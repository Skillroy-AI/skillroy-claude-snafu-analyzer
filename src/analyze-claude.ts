/**
 * Optional semantic pass: shell out to the local `claude` CLI to catch things heuristics can't —
 * contradictions/drift between sessions and decisions discussed but never persisted. Entirely
 * optional: if `claude` isn't on PATH it degrades gracefully and the deterministic findings stand.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import type { Finding, MemoryBundle, SessionDetail } from "./types.js";

export function findClaude(): string | null {
  // Respect an explicit override, else rely on PATH resolution by spawn.
  return process.env.SNAFU_CLAUDE_BIN || "claude";
}

export async function claudeAvailable(): Promise<{ available: boolean; bin: string | null }> {
  const bin = findClaude();
  if (!bin) return { available: false, bin: null };
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => resolve({ available: false, bin }));
    child.on("close", (code) => resolve({ available: code === 0, bin }));
  });
}

/** Compact, self-contained digest of the scope — the only context the sub-Claude gets. */
export function buildDigest(sessions: SessionDetail[], memory: MemoryBundle[], budget = 32_000): string {
  const lines: string[] = [];
  const ordered = [...sessions].sort((a, b) => (a.firstTs || "").localeCompare(b.firstTs || ""));
  lines.push(`# ${ordered.length} Claude Code sessions (chronological)\n`);
  for (const s of ordered) {
    lines.push(`## ${s.firstTs ?? "?"} — "${s.title}"  [${s.id.slice(0, 8)}]`);
    lines.push(`cwd: ${s.cwds.map((c) => c.cwd).join("  |  ")}`);
    if (s.firstUserPrompt) lines.push(`first ask: ${s.firstUserPrompt}`);
    const keySignals = s.signals.filter((g) => g.type === "decision" || g.type === "open_question" || g.type === "claim" || g.type === "todo").slice(0, 10);
    for (const g of keySignals) lines.push(`  [${g.type}] ${g.text}`);
    if (s.lastAssistantSummary) lines.push(`end summary: ${s.lastAssistantSummary}`);
    lines.push("");
  }
  const memFiles = memory.flatMap((m) => m.files);
  if (memFiles.length) {
    lines.push(`# Memory files (${memFiles.length})\n`);
    for (const f of memFiles) lines.push(`## ${f.name}\n${f.text}\n`);
  }
  let out = lines.join("\n");
  if (out.length > budget) out = out.slice(0, budget) + "\n…(digest truncated)";
  return out;
}

const PROMPT = `You are a "SNAFU analyzer" reviewing a chronological digest of Claude Code coding sessions plus the project's memory files.

Find issues that simple keyword heuristics miss. Focus on:
1. CONTRADICTIONS / DRIFT — a later session asserts or builds something that conflicts with an earlier decision or the user's stated intent.
2. UNPERSISTED DECISIONS — a decision clearly made in conversation that is absent from the memory files.
3. DROPPED THREADS — a TODO / follow-up / open question raised and seemingly never resolved.
4. CONTEXT-MANAGEMENT MISTAKES — work done in the wrong folder/repo, confusion from moves/renames.

For each issue, be specific and cite the session id prefix(es) it involves. Prefer a few high-confidence findings over many speculative ones. If a suspected issue turns out to be a false alarm on closer reading, you may include it with severity "info" and explain why it's actually fine.

Respond with ONLY a JSON object, no prose, in exactly this shape:
{"findings":[{"category":"drift|unpersisted-decision|dropped-thread|folder-confusion|other","severity":"high|medium|low|info","title":"...","detail":"...","sessionIdPrefixes":["abc12345"],"suggestion":"..."}]}

DIGEST FOLLOWS:
`;

function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface ClaudeResult {
  available: boolean;
  findings: Finding[];
  error?: string;
  raw?: string;
}

export async function analyzeWithClaude(
  sessions: SessionDetail[],
  memory: MemoryBundle[],
  timeoutMs = 180_000,
): Promise<ClaudeResult> {
  const bin = findClaude();
  if (!bin) return { available: false, findings: [], error: "claude CLI not configured" };

  const idByPrefix = new Map<string, string>();
  for (const s of sessions) idByPrefix.set(s.id.slice(0, 8), s.id);

  const digest = buildDigest(sessions, memory);
  const input = PROMPT + digest;

  return new Promise<ClaudeResult>((resolve) => {
    let child;
    try {
      // Neutral cwd so the sub-Claude doesn't load an unrelated project's context.
      child = spawn(bin, ["-p", "--output-format", "json"], { cwd: os.tmpdir() });
    } catch (e: any) {
      resolve({ available: false, findings: [], error: String(e?.message || e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ available: true, findings: [], error: `claude timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    child.on("error", (e: any) => {
      clearTimeout(timer);
      resolve({ available: false, findings: [], error: String(e?.message || e) });
    });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => {
      clearTimeout(timer);
      // `--output-format json` wraps the reply: { type:"result", result:"<text>", ... }
      let resultText = stdout;
      try {
        const env = JSON.parse(stdout);
        if (env && typeof env.result === "string") resultText = env.result;
      } catch {
        /* not JSON-wrapped; use raw */
      }
      const parsed = extractJson(resultText);
      if (!parsed || !Array.isArray(parsed.findings)) {
        resolve({ available: true, findings: [], error: stderr.trim() || "could not parse Claude output", raw: resultText.slice(0, 2000) });
        return;
      }
      const findings: Finding[] = parsed.findings.map((f: any, i: number) => {
        const ids = (Array.isArray(f.sessionIdPrefixes) ? f.sessionIdPrefixes : [])
          .map((p: string) => idByPrefix.get(String(p).slice(0, 8)) || String(p))
          .filter(Boolean);
        return {
          id: `claude-${i + 1}`,
          category: String(f.category || "other"),
          severity: (["high", "medium", "low", "info"].includes(f.severity) ? f.severity : "low") as Finding["severity"],
          title: String(f.title || "(untitled)"),
          detail: String(f.detail || ""),
          sessionIds: ids,
          evidence: ids.map((id: string) => ({ sessionId: id, snippet: "see Claude analysis" })),
          suggestion: f.suggestion ? String(f.suggestion) : undefined,
          source: "claude" as const,
        };
      });
      resolve({ available: true, findings });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
