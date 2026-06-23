/**
 * Optional semantic passes via the local `claude` CLI. Two flavours:
 *   - analyzeWithClaude:   broad, unprompted scan of a scope (the "Analyze with Claude" button).
 *   - investigateWithClaude: targeted — the user describes a suspected issue and picks sessions;
 *     Claude judges whether it actually happened, using a narration pack + the project's memory.
 * Both are optional: if `claude` isn't on PATH they degrade gracefully.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import type { Finding, MemoryBundle, SessionDetail } from "./types.js";
import type { NarrationItem } from "./parse.js";

export function findClaude(): string | null {
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

/** Spawn `claude -p --output-format json`, feed `input` on stdin, return the assistant's text. */
function runClaudePrint(input: string, timeoutMs: number): Promise<{ available: boolean; text?: string; error?: string }> {
  const bin = findClaude();
  if (!bin) return Promise.resolve({ available: false, error: "claude CLI not configured" });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["-p", "--output-format", "json"], { cwd: os.tmpdir() });
    } catch (e: any) {
      resolve({ available: false, error: String(e?.message || e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ available: true, error: `claude timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.on("error", (e: any) => {
      clearTimeout(timer);
      resolve({ available: false, error: String(e?.message || e) });
    });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => {
      clearTimeout(timer);
      let resultText = stdout;
      try {
        const env = JSON.parse(stdout); // --output-format json wraps the reply
        if (env && typeof env.result === "string") resultText = env.result;
      } catch {
        /* not JSON-wrapped; use raw */
      }
      if (!resultText.trim()) resolve({ available: true, error: stderr.trim() || "empty response from claude" });
      else resolve({ available: true, text: resultText });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

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
  summary?: string;
  error?: string;
  raw?: string;
}

function toFindings(parsed: any, idByPrefix: Map<string, string>, idTag: string): Finding[] {
  return (Array.isArray(parsed.findings) ? parsed.findings : []).map((f: any, i: number) => {
    const ids = (Array.isArray(f.sessionIdPrefixes) ? f.sessionIdPrefixes : [])
      .map((p: string) => idByPrefix.get(String(p).slice(0, 8)) || String(p))
      .filter(Boolean);
    return {
      id: `${idTag}-${i + 1}`,
      category: String(f.category || "other"),
      severity: (["high", "medium", "low", "info"].includes(f.severity) ? f.severity : "low") as Finding["severity"],
      title: String(f.title || "(untitled)"),
      detail: String(f.detail || ""),
      sessionIds: ids,
      evidence: ids.map((id: string) => ({ sessionId: id, snippet: "cited in Claude's analysis" })),
      suggestion: f.suggestion ? String(f.suggestion) : undefined,
      source: "claude" as const,
    };
  });
}

// --- broad scan ------------------------------------------------------------

export function buildDigest(sessions: SessionDetail[], memory: MemoryBundle[], budget = 32_000): string {
  const lines: string[] = [];
  const ordered = [...sessions].sort((a, b) => (a.firstTs || "").localeCompare(b.firstTs || ""));
  lines.push(`# ${ordered.length} Claude Code sessions (chronological)\n`);
  for (const s of ordered) {
    lines.push(`## ${s.firstTs ?? "?"} — "${s.title}"  [${s.id.slice(0, 8)}]`);
    lines.push(`cwd: ${s.cwds.map((c) => c.cwd).join("  |  ")}`);
    if (s.firstUserPrompt) lines.push(`first ask: ${s.firstUserPrompt}`);
    const keySignals = s.signals.filter((g) => ["decision", "open_question", "claim", "todo"].includes(g.type)).slice(0, 10);
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

const SCAN_PROMPT = `You are a "SNAFU analyzer" reviewing a chronological digest of Claude Code coding sessions plus the project's memory files.

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

export async function analyzeWithClaude(sessions: SessionDetail[], memory: MemoryBundle[], timeoutMs = 180_000): Promise<ClaudeResult> {
  const idByPrefix = new Map(sessions.map((s) => [s.id.slice(0, 8), s.id] as const));
  const r = await runClaudePrint(SCAN_PROMPT + buildDigest(sessions, memory), timeoutMs);
  if (!r.available) return { available: false, findings: [], error: r.error };
  if (!r.text) return { available: true, findings: [], error: r.error };
  const parsed = extractJson(r.text);
  if (!parsed) return { available: true, findings: [], error: "could not parse Claude output", raw: r.text.slice(0, 2000) };
  return { available: true, findings: toFindings(parsed, idByPrefix, "claude") };
}

// --- targeted investigation ------------------------------------------------

export interface InvestigationSession {
  id: string;
  title: string;
  firstTs?: string;
  cwds: { cwd: string }[];
  narration: NarrationItem[];
}

export interface InvestigationInput {
  issue: string;
  sessions: InvestigationSession[];
  memory: MemoryBundle[];
}

function buildInvestigationDigest(input: InvestigationInput, budget = 260_000, memBudget = 70_000): string {
  const ordered = [...input.sessions].sort((a, b) => (a.firstTs || "").localeCompare(b.firstTs || ""));
  const perSession = Math.max(12_000, Math.floor(budget / Math.max(1, ordered.length)));
  const lines: string[] = ["# SELECTED SESSIONS — narration only (tool input/output removed)\n"];
  for (const s of ordered) {
    lines.push(`## [${s.id.slice(0, 8)}] ${s.firstTs ?? "?"} — "${s.title}"`);
    lines.push(`cwd: ${s.cwds.map((c) => c.cwd).join("  |  ")}\n`);
    let used = 0;
    let truncated = false;
    for (const it of s.narration) {
      const block = `${it.role === "user" ? "USER" : "CLAUDE"}: ${it.text}`;
      if (used + block.length > perSession) {
        truncated = true;
        break;
      }
      lines.push(block);
      used += block.length;
    }
    if (truncated) lines.push("…(this session's narration was truncated to fit)");
    lines.push("");
  }
  const memFiles = input.memory.flatMap((m) => m.files);
  if (memFiles.length) {
    lines.push(`# CURRENT MEMORY FILES (${memFiles.length}) — note: may have been corrected after the sessions above\n`);
    let memUsed = 0;
    for (const f of memFiles) {
      const block = `## ${f.name}\n${f.text}\n`;
      if (memUsed + block.length > memBudget) {
        lines.push("…(remaining memory truncated)");
        break;
      }
      lines.push(block);
      memUsed += block.length;
    }
  }
  return lines.join("\n");
}

function investigatePrompt(issue: string): string {
  return `You are investigating a SPECIFIC issue a user suspects occurred across their Claude Code sessions.

THE USER'S SUSPICION:
"""
${issue}
"""

Below is the NARRATION (human prompts + Claude's text; tool input/output removed) from the sessions the user selected, followed by the project's CURRENT memory files.

Determine whether the suspected issue actually occurred, grounded in the evidence. Pay special attention to DRIFT:
- an entity / tool / component referred to by inconsistent names across sessions, or differently from how the memory files name it (e.g. a database called by two different names);
- a decision quietly reversed or re-litigated;
- a constraint or convention silently forgotten.

IMPORTANT nuances:
- Memory may have been CORRECTED after these sessions, so a mismatch between an earlier transcript and the current memory is itself strong evidence the drift happened.
- Distinguish a genuine drift from legitimate incidental mention (e.g. a fork correctly referencing its upstream project). Judge by what the project treats as the CANONICAL term and whether usage shifted away from it.

QUOTE the specific evidence and cite the session id prefix in brackets, e.g. [d7594a0f]. Prefer high-confidence, well-evidenced findings. If on close reading the suspicion is NOT supported, say so with severity "info" and explain why.

Respond with ONLY a JSON object, no prose:
{"summary":"1-3 sentence verdict on the user's suspicion","findings":[{"category":"naming-drift|reversed-decision|forgotten-constraint|drift|other","severity":"high|medium|low|info","title":"...","detail":"...quote the evidence...","sessionIdPrefixes":["d7594a0f"],"suggestion":"..."}]}

EVIDENCE FOLLOWS:
`;
}

export async function investigateWithClaude(input: InvestigationInput, timeoutMs = 240_000): Promise<ClaudeResult> {
  const idByPrefix = new Map(input.sessions.map((s) => [s.id.slice(0, 8), s.id] as const));
  const r = await runClaudePrint(investigatePrompt(input.issue) + buildInvestigationDigest(input), timeoutMs);
  if (!r.available) return { available: false, findings: [], error: r.error };
  if (!r.text) return { available: true, findings: [], error: r.error };
  const parsed = extractJson(r.text);
  if (!parsed) return { available: true, findings: [], error: "could not parse Claude output", raw: r.text.slice(0, 2000) };
  return {
    available: true,
    findings: toFindings(parsed, idByPrefix, "investigate"),
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
  };
}
