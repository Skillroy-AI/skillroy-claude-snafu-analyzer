/**
 * Shared data model for the SNAFU analyzer.
 *
 * A Claude Code transcript is a JSONL file under ~/.claude/projects/<bucket>/<sessionId>.jsonl.
 * The directory name (the "bucket") is the session's cwd with "/" replaced by "-" — which is
 * LOSSY and not reliably reversible. The trustworthy path is the `cwd` field embedded on every
 * event line, so we group/label sessions by their real cwd, not by the bucket name. That single
 * fact is what lets the tool catch "ran Claude from the wrong/moved folder" mix-ups.
 */

export type Role = "user" | "assistant";

/** A single tool invocation inside an assistant turn. */
export interface ToolCall {
  name: string;
  /** A short human-readable target: a file path for Read/Write/Edit, a description for Bash, etc. */
  target?: string;
}

export type SignalType =
  | "todo"
  | "decision"
  | "open_question"
  | "claim"
  | "commit"
  | "memory_write"
  | "file_move"
  | "handover"
  | "wrong_folder";

/** A noteworthy thing extracted from a round's text (heuristic, may have false positives). */
export interface Signal {
  type: SignalType;
  role: Role;
  /** The matched line/snippet, whitespace-collapsed and capped. */
  text: string;
  sessionId: string;
  /** Index of the round this signal came from. */
  round: number;
  ts?: string;
  /** Distinctive tokens (ids like dec-xxx / t-xxx, filenames) for cross-session matching. */
  keywords: string[];
}

/**
 * A "round" = one human prompt and everything Claude did in response, up to the next human prompt.
 * `assistantSummary` is the last assistant text block of the round — Claude's end-of-round summary.
 */
export interface Round {
  index: number;
  /** How this round was opened. */
  source: "human" | "command" | "meta";
  userPrompt: string;
  userTs?: string;
  endTs?: string;
  assistantSummary: string;
  assistantTextCount: number;
  thinkingCount: number;
  toolCalls: ToolCall[];
  signals: Signal[];
}

export interface CwdPoint {
  ts?: string;
  cwd: string;
}

export interface SessionSummary {
  id: string;
  /** Encoded project directory name (the bucket). */
  bucket: string;
  file: string;
  title: string;
  firstTs?: string;
  lastTs?: string;
  durationMs?: number;
  userMsgCount: number;
  assistantMsgCount: number;
  roundCount: number;
  toolCounts: Record<string, number>;
  /** Distinct real working directories seen on event lines, with frequency. */
  cwds: { cwd: string; count: number }[];
  primaryCwd?: string;
  gitBranches: string[];
  versions: string[];
  /** True if the cwd changed during the session at all (includes benign cd into a subdir). */
  movedMidSession: boolean;
  /** True if the cwds diverge (sibling/unrelated paths, not pure descent) — the suspicious case. */
  cwdDiverged: boolean;
  firstUserPrompt: string;
  lastAssistantSummary: string;
  signalCounts: Record<string, number>;
  /** Session-level snafu category tags (computed by detectors), for list badges. */
  snafuFlags: string[];
}

export interface SessionDetail extends SessionSummary {
  rounds: Round[];
  signals: Signal[];
  cwdTimeline: CwdPoint[];
}

export type Severity = "info" | "low" | "medium" | "high";

export interface Evidence {
  sessionId: string;
  round?: number;
  snippet: string;
}

/** One detected (or suspected) issue. */
export interface Finding {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  detail: string;
  sessionIds: string[];
  evidence: Evidence[];
  suggestion?: string;
  source: "deterministic" | "claude";
}

export interface MemoryFile {
  name: string;
  path: string;
  text: string;
}

export interface MemoryBundle {
  bucket: string;
  dir: string | null;
  files: MemoryFile[];
}
