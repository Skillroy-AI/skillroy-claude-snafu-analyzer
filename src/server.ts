/** Express app: JSON API over the Store + static single-page UI. */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, toSummary, type Scope } from "./store.js";
import { runDetectors } from "./detectors.js";
import { analyzeWithClaude, claudeAvailable } from "./analyze-claude.js";
import type { Finding } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");

function scopeOf(q: any): Scope {
  return {
    from: q.from || undefined,
    to: q.to || undefined,
    project: q.project || undefined,
    q: q.q || undefined,
  };
}

/** Map findings → per-session category flags for list badges. */
function flagsBySession(findings: Finding[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const f of findings)
    for (const id of f.sessionIds) (m.get(id) ?? m.set(id, new Set()).get(id)!).add(f.category);
  return m;
}

export function createServer(store: Store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true, root: store.root }));

  app.post("/api/refresh", (_req, res) => {
    store.refresh();
    res.json({ ok: true });
  });

  app.get("/api/projects", (_req, res) => res.json({ root: store.root, projects: store.projects() }));

  app.get("/api/sessions", (req, res) => {
    const scope = scopeOf(req.query);
    const sessions = store.scoped(scope);
    const findings = runDetectors({ sessions, memoryByBucket: store.memoryMap() });
    const flags = flagsBySession(findings);
    res.json({
      count: sessions.length,
      sessions: sessions.map((s) => toSummary(s, [...(flags.get(s.id) || [])])),
    });
  });

  app.get("/api/sessions/:id", (req, res) => {
    const s = store.sessionById(req.params.id);
    if (!s) return res.status(404).json({ error: "session not found" });
    const findings = runDetectors({ sessions: [s], memoryByBucket: store.memoryMap() });
    res.json({ session: s, findings });
  });

  app.get("/api/snafus", (req, res) => {
    const scope = scopeOf(req.query);
    const sessions = store.scoped(scope);
    const findings = runDetectors({ sessions, memoryByBucket: store.memoryMap() });
    res.json({ count: findings.length, scopeSessions: sessions.length, findings });
  });

  app.get("/api/memory", (req, res) => {
    res.json({ memory: store.memory(req.query.project as string | undefined) });
  });

  app.get("/api/claude/available", async (_req, res) => res.json(await claudeAvailable()));

  app.post("/api/analyze", async (req, res) => {
    const scope = scopeOf({ ...req.query, ...req.body });
    const sessions = store.scoped(scope);
    if (sessions.length === 0) return res.json({ available: true, findings: [], error: "no sessions in scope" });
    const result = await analyzeWithClaude(sessions, store.memory(scope.project));
    res.json(result);
  });

  app.use(express.static(WEB_DIR));
  app.get("/", (_req, res) => res.sendFile(path.join(WEB_DIR, "index.html")));

  return app;
}
