/**
 * Deterministic SNAFU detectors. Each returns Finding[]. They are intentionally explainable:
 * every finding carries the evidence that triggered it so a human can judge it quickly.
 */
import type { Finding, MemoryBundle, SessionDetail, Signal } from "./types.js";
import { memoryText } from "./memory.js";

interface Ctx {
  sessions: SessionDetail[];
  memoryByBucket: Map<string, MemoryBundle>;
}

const cap = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A lowercased search blob per session, for "was this mentioned later?" checks. */
function blobOf(s: SessionDetail): string {
  const parts = [s.title, s.firstUserPrompt];
  for (const r of s.rounds) parts.push(r.userPrompt, r.assistantSummary);
  for (const g of s.signals) parts.push(g.text);
  return parts.join(" \n ").toLowerCase();
}

export function runDetectors(ctx: Ctx): Finding[] {
  const { sessions, memoryByBucket } = ctx;
  const findings: Finding[] = [];
  let n = 0;
  const nextId = (cat: string) => `det-${cat}-${++n}`;

  const blobs = new Map<string, string>();
  for (const s of sessions) blobs.set(s.id, blobOf(s));
  const memAll = [...memoryByBucket.values()].map(memoryText).join("\n");

  // 1) Co-mingled transcripts: one bucket (transcript folder) holding multiple real cwds.
  const byBucket = new Map<string, SessionDetail[]>();
  for (const s of sessions) (byBucket.get(s.bucket) ?? byBucket.set(s.bucket, []).get(s.bucket)!).push(s);
  for (const [bucket, group] of byBucket) {
    const cwdToSessions = new Map<string, string[]>();
    for (const s of group)
      for (const c of s.cwds)
        (cwdToSessions.get(c.cwd) ?? cwdToSessions.set(c.cwd, []).get(c.cwd)!).push(s.id);
    if (cwdToSessions.size > 1) {
      const lines = [...cwdToSessions.entries()].map(([c, ids]) => `• ${c}  (${ids.length} session${ids.length > 1 ? "s" : ""})`);
      findings.push({
        id: nextId("comingled"),
        category: "folder-confusion",
        severity: "high",
        title: `One transcript folder maps to ${cwdToSessions.size} different working directories`,
        detail:
          `The bucket "${bucket}" contains sessions that actually ran in different folders. ` +
          `Claude Code derives the transcript folder from the cwd (slashes → dashes), so distinct paths ` +
          `like ".../foo/research" and ".../foo-research" collapse to the SAME bucket and get co-mingled. ` +
          `This is a classic "I moved/renamed the folder but kept working in the old one" mix-up.\n\n` +
          lines.join("\n"),
        sessionIds: group.map((s) => s.id),
        evidence: [...cwdToSessions.entries()].slice(0, 8).map(([c, ids]) => ({
          sessionId: ids[0],
          snippet: `cwd ${c} — sessions: ${ids.join(", ")}`,
        })),
        suggestion:
          "Confirm which directory is canonical, move stray work there, and start future sessions from the canonical path so memory/cwd stay aligned.",
        source: "deterministic",
      });
    }
  }

  // 2) cwd DIVERGED mid-session (sibling/unrelated paths — a move/mis-start, not benign cd).
  for (const s of sessions) {
    if (!s.cwdDiverged) continue;
    const path = s.cwdTimeline.map((p) => p.cwd);
    findings.push({
      id: nextId("moved"),
      category: "folder-confusion",
      severity: "medium",
      title: "Working directory diverged mid-session (possible move / mis-start)",
      detail:
        `Session "${s.title}" ran across ${s.cwds.length} directories — and they aren't a simple ` +
        `parent→subfolder descent, so a folder was likely moved/renamed or Claude was kept running in a stale path:\n` +
        path.map((c, i) => `${i + 1}. ${c}`).join("\n") +
        `\n\nWork done after the change can land in the wrong repo, and cwd-scoped memory may not follow.`,
      sessionIds: [s.id],
      evidence: s.cwdTimeline.slice(0, 6).map((p) => ({ sessionId: s.id, snippet: `${p.ts ?? "?"} → ${p.cwd}` })),
      suggestion: "Verify outputs from after the move are in the intended repo; restart Claude in the new path.",
      source: "deterministic",
    });
  }

  // 3) Abandoned / stub sessions (opened, ~no work) — candidates for orphaned mis-starts.
  for (const s of sessions) {
    const tiny = s.assistantMsgCount === 0 || (s.roundCount <= 1 && (s.durationMs ?? 0) < 60_000 && s.assistantMsgCount < 2);
    if (!tiny) continue;
    findings.push({
      id: nextId("stub"),
      category: "abandoned-session",
      severity: "info",
      title: "Abandoned / stub session",
      detail:
        `Session opened ${s.firstTs ?? "?"} in ${s.primaryCwd ?? "?"} with little or no work ` +
        `(${s.assistantMsgCount} assistant messages, ${Math.round((s.durationMs ?? 0) / 1000)}s). ` +
        `Often an accidental start — sometimes in a stale/orphaned folder.`,
      sessionIds: [s.id],
      evidence: [{ sessionId: s.id, snippet: s.firstUserPrompt || "(no human prompt)" }],
      source: "deterministic",
    });
  }

  // helper: was a token mentioned in any session that STARTED after `ts`, or in memory?
  const sorted = [...sessions].sort((a, b) => (a.firstTs || "").localeCompare(b.firstTs || ""));
  const mentionedLater = (kw: string, ts?: string): boolean => {
    const k = kw.toLowerCase();
    if (memAll.includes(k)) return true;
    for (const s of sorted) {
      if (ts && (s.firstTs || "") <= ts) continue;
      if ((blobs.get(s.id) || "").includes(k)) return true;
    }
    return false;
  };

  // 4) Dropped TODOs: a todo carrying a distinctive token (id/filename) never seen later or in memory.
  let dropped = 0;
  for (const s of sorted) {
    for (const g of s.signals) {
      if (g.type !== "todo" || g.keywords.length === 0) continue;
      const unseen = g.keywords.filter((kw) => !mentionedLater(kw, s.lastTs));
      if (unseen.length === 0) continue;
      if (dropped++ >= 12) break;
      findings.push({
        id: nextId("droppedtodo"),
        category: "dropped-thread",
        severity: "low",
        title: `Possible dropped TODO (${unseen.join(", ")})`,
        detail:
          `A follow-up referencing ${unseen.map((k) => `"${k}"`).join(", ")} appeared but those tokens ` +
          `don't show up in any later session or in memory — it may never have been actioned.\n\n“${cap(g.text)}”`,
        sessionIds: [s.id],
        evidence: [{ sessionId: s.id, round: g.round, snippet: cap(g.text) }],
        suggestion: "If still relevant, capture it as a task; otherwise note it as intentionally dropped.",
        source: "deterministic",
      });
    }
  }

  // 5) Open questions left at the very end of a session, not echoed in memory.
  let openq = 0;
  for (const s of sessions) {
    const lastRound = s.rounds.length - 1;
    for (const g of s.signals) {
      if (g.type !== "open_question" || g.round < lastRound) continue;
      const inMem = g.keywords.some((kw) => memAll.includes(kw.toLowerCase()));
      if (inMem) continue;
      if (openq++ >= 10) break;
      findings.push({
        id: nextId("openq"),
        category: "open-question",
        severity: "low",
        title: "Open question left at end of session",
        detail: `The session ended on a question to you that isn't reflected in memory:\n\n“${cap(g.text)}”`,
        sessionIds: [s.id],
        evidence: [{ sessionId: s.id, round: g.round, snippet: cap(g.text) }],
        suggestion: "Answer it and persist the decision, or it risks falling out of context.",
        source: "deterministic",
      });
    }
  }

  // 6) Decisions referencing an id (dec-xxx) absent from that bucket's memory.
  let dec = 0;
  for (const s of sessions) {
    const mem = memoryByBucket.get(s.bucket);
    if (!mem || mem.files.length === 0) continue; // can't judge absence with no memory
    const memTxt = memoryText(mem);
    for (const g of s.signals) {
      if (g.type !== "decision") continue;
      const ids = g.keywords.filter((k) => /^(dec|q|b|t)-/.test(k));
      const missing = ids.filter((k) => !memTxt.includes(k.toLowerCase()));
      if (missing.length === 0) continue;
      if (dec++ >= 10) break;
      findings.push({
        id: nextId("decmem"),
        category: "decision-not-persisted",
        severity: "low",
        title: `Decision ${missing.join(", ")} not found in memory`,
        detail: `A decision referencing ${missing.join(", ")} was discussed but doesn't appear in this project's memory files.\n\n“${cap(g.text)}”`,
        sessionIds: [s.id],
        evidence: [{ sessionId: s.id, round: g.round, snippet: cap(g.text) }],
        suggestion: "If it's a real decision, record it in memory so future sessions inherit it.",
        source: "deterministic",
      });
    }
  }

  // 7) Recovery trail: handover / wrong-folder mentions, grouped as context.
  const recovery: Signal[] = [];
  for (const s of sessions) for (const g of s.signals) if (g.type === "handover" || g.type === "wrong_folder") recovery.push(g);
  if (recovery.length) {
    const ids = [...new Set(recovery.map((r) => r.sessionId))];
    findings.push({
      id: nextId("recovery"),
      category: "recovery-trail",
      severity: "info",
      title: `Folder/handover recovery activity (${recovery.length} mentions)`,
      detail: "Sessions explicitly mention a handover or the wrong/orphaned folder — useful breadcrumbs for reconstructing what happened.",
      sessionIds: ids,
      evidence: recovery.slice(0, 8).map((r) => ({ sessionId: r.sessionId, round: r.round, snippet: cap(r.text) })),
      source: "deterministic",
    });
  }

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}
