import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSessionFile } from "../src/parse.js";

function fixture(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snafu-test-"));
  const file = path.join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
}

const base = { sessionId: "s", gitBranch: "main", version: "1.0.0" };

test("rounds, summaries, tools, signals, and cwd divergence", () => {
  const file = fixture([
    { type: "ai-title", aiTitle: "Wire the schema" },
    { ...base, type: "user", timestamp: "2026-06-22T00:00:00Z", cwd: "/a/b", message: { role: "user", content: "Please wire the schema. TODO: add tests for dec-foo." } },
    { ...base, type: "assistant", timestamp: "2026-06-22T00:01:00Z", cwd: "/a/b", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Working on it." }, { type: "tool_use", name: "Edit", input: { file_path: "/a/b/schema.ts" } }] } },
    { ...base, type: "user", timestamp: "2026-06-22T00:02:00Z", cwd: "/a/b", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    { ...base, type: "assistant", timestamp: "2026-06-22T00:03:00Z", cwd: "/a/b-research", message: { role: "assistant", content: [{ type: "text", text: "Done. The schema is now the single source of truth." }] } },
    { ...base, type: "user", timestamp: "2026-06-22T00:04:00Z", cwd: "/a/b-research", message: { role: "user", content: "<command-name>/exit</command-name>" } },
  ]);
  const s = parseSessionFile(file, "bucket");

  assert.equal(s.title, "Wire the schema");
  assert.equal(s.roundCount, 2, "one human round + one command round");
  assert.equal(s.rounds[0].source, "human");
  assert.equal(s.rounds[1].source, "command");

  // tool_result must NOT start a new round
  assert.ok(s.rounds[0].toolCalls.some((t) => t.name === "Edit" && /schema\.ts/.test(t.target || "")));

  // end-of-round summary = last assistant text block, even across a tool_result turn
  assert.match(s.rounds[0].assistantSummary, /single source of truth/);

  // signals
  const types = new Set(s.signals.map((g) => g.type));
  assert.ok(types.has("todo"), "TODO detected");
  assert.ok(types.has("claim"), "claim detected");
  assert.ok(s.signals.some((g) => g.keywords.includes("dec-foo")), "id keyword captured");

  // cwd: /a/b-research is a sibling of /a/b, not a descendant → divergence
  assert.equal(s.movedMidSession, true);
  assert.equal(s.cwdDiverged, true);
  assert.equal(s.primaryCwd, "/a/b");
});

test("cd into a subfolder is movement but NOT divergence", () => {
  const file = fixture([
    { ...base, type: "user", timestamp: "2026-06-22T00:00:00Z", cwd: "/a/b", message: { role: "user", content: "start" } },
    { ...base, type: "assistant", timestamp: "2026-06-22T00:01:00Z", cwd: "/a/b/poc", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]);
  const s = parseSessionFile(file, "bucket");
  assert.equal(s.movedMidSession, true);
  assert.equal(s.cwdDiverged, false);
});

test("memory writes are attributed to the round and session", () => {
  const file = fixture([
    { ...base, type: "user", timestamp: "2026-06-22T00:00:00Z", cwd: "/a/b", message: { role: "user", content: "remember this fact" } },
    { ...base, type: "assistant", timestamp: "2026-06-22T00:00:30Z", cwd: "/a/b", message: { role: "assistant", content: [
      { type: "tool_use", name: "Write", input: { file_path: "/Users/x/.claude/projects/-a-b/memory/fact-one.md" } },
      { type: "text", text: "saved it" },
    ] } },
    { ...base, type: "user", timestamp: "2026-06-22T00:01:00Z", cwd: "/a/b", message: { role: "user", content: "now update the index" } },
    { ...base, type: "assistant", timestamp: "2026-06-22T00:01:30Z", cwd: "/a/b", message: { role: "assistant", content: [
      { type: "tool_use", name: "Edit", input: { file_path: "/Users/x/.claude/projects/-a-b/memory/MEMORY.md" } },
      { type: "tool_use", name: "Write", input: { file_path: "/a/b/src/index.ts" } }, // NOT under memory/
    ] } },
  ]);
  const s = parseSessionFile(file, "bucket");

  assert.deepEqual(s.rounds[0].memoryWrites, ["fact-one.md"]);
  assert.deepEqual(s.rounds[1].memoryWrites, ["MEMORY.md"], "non-memory writes are ignored");
  assert.deepEqual(s.memoryWrites.map((w) => w.name), ["fact-one.md", "MEMORY.md"]);
  assert.equal(s.memoryWrites[0].round, 0);
  assert.equal(s.memoryWrites[1].round, 1);
});

test("an injected compaction summary is not a human prompt/round", () => {
  const file = fixture([
    { ...base, type: "user", timestamp: "2026-06-22T00:00:00Z", cwd: "/a/b", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: …" } },
    { ...base, type: "user", timestamp: "2026-06-22T00:00:10Z", cwd: "/a/b", message: { role: "user", content: "the real first prompt" } },
    { ...base, type: "assistant", timestamp: "2026-06-22T00:01:00Z", cwd: "/a/b", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]);
  const s = parseSessionFile(file, "bucket");
  assert.equal(s.roundCount, 1);
  assert.equal(s.rounds[0].userPrompt, "the real first prompt");
});

test("a /context dump and system-reminder do not create human rounds", () => {
  const file = fixture([
    { ...base, type: "user", timestamp: "2026-06-22T00:00:00Z", cwd: "/a/b", isMeta: true, message: { role: "user", content: "## Context Usage\nTokens: 10k" } },
    { ...base, type: "user", timestamp: "2026-06-22T00:00:10Z", cwd: "/a/b", message: { role: "user", content: "real question" } },
    { ...base, type: "assistant", timestamp: "2026-06-22T00:01:00Z", cwd: "/a/b", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ]);
  const s = parseSessionFile(file, "bucket");
  assert.equal(s.roundCount, 1);
  assert.equal(s.rounds[0].userPrompt, "real question");
});
