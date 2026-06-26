/** Parse one Claude Code JSONL transcript into a normalized SessionDetail. */
import fs from "node:fs";
import path from "node:path";
import type { CwdPoint, Role, Round, SessionDetail, Signal, ToolCall } from "./types.js";
import { extractSignals } from "./extract.js";

// --- content helpers -------------------------------------------------------

const WRAPPER_RE =
  /<command-name>[\s\S]*?<\/command-name>|<command-message>[\s\S]*?<\/command-message>|<command-args>[\s\S]*?<\/command-args>|<local-command-stdout>[\s\S]*?<\/local-command-stdout>|<local-command-stdout>[\s\S]*$|<local-command-caveat>[\s\S]*?<\/local-command-caveat>|<system-reminder>[\s\S]*?<\/system-reminder>/g;

function stripWrappers(s: string): string {
  return s.replace(WRAPPER_RE, "").trim();
}

function commandName(s: string): string | null {
  const m = s.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  return m ? m[1].trim() : null;
}

/** Concatenate the human-authored text blocks of a message's content. */
function textOf(content: unknown): { text: string; hasToolResult: boolean } {
  if (typeof content === "string") return { text: content, hasToolResult: false };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let hasToolResult = false;
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const t = (b as any).type;
      if (t === "text" && typeof (b as any).text === "string") parts.push((b as any).text);
      else if (t === "tool_result") hasToolResult = true;
    }
    return { text: parts.join("\n\n"), hasToolResult };
  }
  return { text: "", hasToolResult: false };
}

type UserKind = "human" | "command" | "meta" | "tool_result";

function classifyUser(content: unknown, isMeta: boolean): { kind: UserKind; text: string } {
  const { text, hasToolResult } = textOf(content);
  const cmd = commandName(text);
  const residual = stripWrappers(text);

  if (hasToolResult && !residual) return { kind: "tool_result", text: "" };
  if (cmd) return { kind: "command", text: cmd + (residual ? `  —  ${residual}` : "") };

  // /context output and similar local-command stdout injected as a plain string.
  if (/^#{1,3}\s*Context Usage\b/.test(residual) || /^Caveat:/.test(residual)) {
    return { kind: "meta", text: "" };
  }
  if (!residual) return { kind: hasToolResult ? "tool_result" : "meta", text: "" };

  // A meta text block that still carries a substantive instruction (e.g. an expanded slash command).
  if (isMeta && residual.length < 40) return { kind: "meta", text: "" };

  return { kind: isMeta ? "command" : "human", text: residual };
}

function lastTextBlock(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      const b = content[i] as any;
      if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) return b.text;
    }
  }
  return "";
}

function toolCallsOf(content: unknown): {
  calls: ToolCall[];
  thinking: number;
  textBlocks: number;
  memoryWrites: string[];
} {
  const calls: ToolCall[] = [];
  const memoryWrites: string[] = [];
  let thinking = 0;
  let textBlocks = 0;
  if (Array.isArray(content)) {
    for (const b of content as any[]) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "thinking") thinking++;
      else if (b.type === "text" && (b.text || "").trim()) textBlocks++;
      else if (b.type === "tool_use") {
        calls.push({ name: b.name, target: toolTarget(b.name, b.input) });
        if (["Write", "Edit", "NotebookEdit"].includes(b.name)) {
          const mem = memoryNameFromPath(b.input?.file_path);
          if (mem) memoryWrites.push(mem);
        }
      }
    }
  }
  return { calls, thinking, textBlocks, memoryWrites };
}

/** If a written path is under a `…/memory/` dir, return its name relative to that dir, else null. */
function memoryNameFromPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const i = p.lastIndexOf("/memory/");
  if (i === -1) return null;
  const rel = p.slice(i + "/memory/".length);
  return rel.endsWith(".md") ? rel : null;
}

function toolTarget(name: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const cap = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  if (["Read", "Write", "Edit", "NotebookEdit"].includes(name) && input.file_path)
    return cap(String(input.file_path));
  if (name === "Bash") return cap(String(input.description || input.command || ""));
  if (name === "Agent") return cap(String(input.description || ""));
  if (input.title) return cap(String(input.title));
  if (input.id) return cap(String(input.id));
  return undefined;
}

// --- main parse ------------------------------------------------------------

function snippet(s: string, cap = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap - 1) + "…" : t;
}

/** True when cwds aren't a single descent chain — i.e. work spanned sibling/unrelated folders. */
function cwdsDiverge(cwds: string[]): boolean {
  const uniq = [...new Set(cwds)].filter(Boolean).sort((a, b) => a.length - b.length);
  if (uniq.length <= 1) return false;
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i] !== uniq[i - 1] && !uniq[i].startsWith(uniq[i - 1] + "/")) return true;
  }
  return false;
}

export interface NarrationItem {
  role: Role;
  ts?: string;
  text: string;
}

/**
 * The "narration" of a session: human prompts + Claude's text blocks, with tool inputs/results and
 * thinking stripped. This is the compact, high-signal view used for targeted Claude investigations —
 * terminology/decision drift shows up in the narration, not in the (huge) tool I/O.
 */
export function sessionNarration(file: string, perBlockCap = 3000): NarrationItem[] {
  const raw = fs.readFileSync(file, "utf8");
  const out: NarrationItem[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts: string | undefined = d.timestamp;
    const msg = d.message;
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "user") {
      const { kind, text } = classifyUser(msg.content, !!d.isMeta);
      if ((kind === "human" || kind === "command") && text.trim())
        out.push({ role: "user", ts, text: text.slice(0, perBlockCap) });
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content as any[]) {
        if (b && b.type === "text" && typeof b.text === "string" && b.text.trim())
          out.push({ role: "assistant", ts, text: b.text.slice(0, perBlockCap) });
      }
    }
  }
  return out;
}

export function parseSessionFile(file: string, bucket: string): SessionDetail {
  const raw = fs.readFileSync(file, "utf8");
  const id = path.basename(file).replace(/\.jsonl$/, "");

  const rounds: Round[] = [];
  const cwdTimeline: CwdPoint[] = [];
  const cwdCounts = new Map<string, number>();
  const branches = new Set<string>();
  const versions = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let aiTitle = "";
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let userMsgCount = 0;
  let assistantMsgCount = 0;
  let lastCwd: string | undefined;

  type Cur = Round & { _asstConcat: string };
  let cur: Cur | null = null;
  const startRound = (source: Round["source"], userPrompt: string, ts?: string): Cur => {
    const r: Cur = {
      index: rounds.length,
      source,
      userPrompt: snippet(userPrompt, 1000),
      userTs: ts,
      endTs: ts,
      assistantSummary: "",
      assistantTextCount: 0,
      thinkingCount: 0,
      toolCalls: [],
      signals: [],
      memoryWrites: [],
      _asstConcat: "",
    };
    rounds.push(r);
    return r;
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    const ts: string | undefined = d.timestamp;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    if (typeof d.cwd === "string") {
      cwdCounts.set(d.cwd, (cwdCounts.get(d.cwd) || 0) + 1);
      if (d.cwd !== lastCwd) {
        cwdTimeline.push({ ts, cwd: d.cwd });
        lastCwd = d.cwd;
      }
    }
    if (typeof d.gitBranch === "string" && d.gitBranch) branches.add(d.gitBranch);
    if (typeof d.version === "string") versions.add(d.version);
    if (d.type === "ai-title" && d.aiTitle) aiTitle = d.aiTitle;

    const msg = d.message;
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;

    if (role === "user") {
      userMsgCount++;
      const { kind, text } = classifyUser(msg.content, !!d.isMeta);
      // An injected compaction summary ("continued from a previous conversation…") is a user-role
      // line but not a turn the human typed — don't let it open a round.
      if (!d.isCompactSummary && (kind === "human" || kind === "command")) {
        cur = startRound(kind === "command" ? "command" : "human", text, ts);
        for (const s of extractSignals(text, "user", id, cur.index, ts)) cur.signals.push(s);
      } else if (cur && ts) {
        cur.endTs = ts; // tool_result / meta / summary turn — keep the round's clock moving
      }
    } else if (role === "assistant") {
      assistantMsgCount++;
      if (!cur) cur = startRound("meta", "(session opened)", ts);
      const { calls, thinking, textBlocks, memoryWrites } = toolCallsOf(msg.content);
      for (const c of calls) {
        cur.toolCalls.push(c);
        toolCounts[c.name] = (toolCounts[c.name] || 0) + 1;
      }
      for (const m of memoryWrites) cur.memoryWrites.push(m);
      cur.thinkingCount += thinking;
      cur.assistantTextCount += textBlocks;
      const last = lastTextBlock(msg.content);
      if (last.trim()) {
        cur.assistantSummary = snippet(last, 1200);
        cur._asstConcat += "\n\n" + last;
      }
      if (ts) cur.endTs = ts;
    }
  }

  // Extract assistant-side signals once per round over the concatenated text.
  for (const r of rounds as (Round & { _asstConcat: string })[]) {
    if (r._asstConcat.trim()) {
      for (const s of extractSignals(r._asstConcat, "assistant", id, r.index, r.endTs)) r.signals.push(s);
    }
    delete (r as any)._asstConcat;
    if (r.memoryWrites.length > 1) r.memoryWrites = [...new Set(r.memoryWrites)];
  }

  // Session-level roll-up: which memory files were written, and in which round.
  const memoryWrites: SessionDetail["memoryWrites"] = [];
  for (const r of rounds)
    for (const name of r.memoryWrites) memoryWrites.push({ name, round: r.index, ts: r.endTs });

  const cwds = [...cwdCounts.entries()]
    .map(([cwd, count]) => ({ cwd, count }))
    .sort((a, b) => b.count - a.count);
  const allSignals: Signal[] = rounds.flatMap((r) => r.signals);
  const signalCounts: Record<string, number> = {};
  for (const s of allSignals) signalCounts[s.type] = (signalCounts[s.type] || 0) + 1;

  const firstHuman = rounds.find((r) => r.source === "human") || rounds.find((r) => r.userPrompt);
  const lastSummaryRound = [...rounds].reverse().find((r) => r.assistantSummary);

  return {
    id,
    bucket,
    file,
    title: aiTitle || (firstHuman ? snippet(firstHuman.userPrompt, 80) : "(untitled)"),
    firstTs,
    lastTs,
    durationMs: firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : undefined,
    userMsgCount,
    assistantMsgCount,
    roundCount: rounds.filter((r) => r.source !== "meta").length,
    toolCounts,
    cwds,
    primaryCwd: cwds[0]?.cwd,
    gitBranches: [...branches],
    versions: [...versions],
    movedMidSession: cwds.length > 1,
    cwdDiverged: cwdsDiverge(cwds.map((c) => c.cwd)),
    firstUserPrompt: firstHuman ? snippet(firstHuman.userPrompt, 400) : "",
    lastAssistantSummary: lastSummaryRound ? snippet(lastSummaryRound.assistantSummary, 600) : "",
    signalCounts,
    snafuFlags: [],
    rounds,
    signals: allSignals,
    cwdTimeline,
    memoryWrites,
  };
}
