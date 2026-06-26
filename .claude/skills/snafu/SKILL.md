---
name: snafu
description: Investigate a suspected "SNAFU" across past Claude Code sessions — terminology/decision drift, dropped TODOs, decisions never saved to memory, or wrong-folder/context mix-ups — by reading the relevant transcripts' narration plus the project's memory, then judging whether the suspicion holds. Also browses a project's recent MEMORY documents or your recent prompts (newest first). Use when the user says "snafu", "snafu check", asks to investigate whether something drifted / was forgotten / was contradicted across earlier sessions, or asks to see recent memory documents / recent prompts for a project.
---

# snafu — investigate a suspected SNAFU in past sessions

You are the analyzer here: there is **no server and no `claude -p`** — you read the relevant session
narration + memory yourself and reason about the user's suspicion. The investigation is **read-only**;
never modify memory or project files unless the user explicitly asks afterward.

A bundled helper, `extract.mjs` (in this skill's own directory), does the heavy lifting: it finds the
right transcripts under `~/.claude/projects`, untangles the lossy cwd→folder encoding, strips tool
input/output down to the **narration** (human prompts + your past text), and appends the project's
current memory files. Always prefer it over reading raw `*.jsonl` (those are megabytes each).

## Resolve the helper path first

The helper sits next to this file. Find it once:

```bash
SNAFU_DIR=$(ls -d ~/.claude/skills/snafu .claude/skills/snafu 2>/dev/null | head -1)
node "$SNAFU_DIR/extract.mjs" --list
```

## Steps

1. **Parse the request.** Pull out whatever the user already gave you:
   - **project(s)** (e.g. "skillroy-tasks");
   - **scope** — "last N sessions" → `--last N`; an explicit/relative date range → `--from`/`--to`
     (ISO 8601 UTC; use `date` to resolve "yesterday"/"last week"); specific ids → `--sessions a,b`;
   - **the suspicion** itself (what they think went wrong). If the suspicion is missing, ask for it —
     it's the one thing you can't infer.

2. **Pick the project(s).**
   - If the user named one, run `node "$SNAFU_DIR/extract.mjs" --project "<name>" --last <N>` (or with
     `--from/--to`). If it prints `{"ambiguous": true, ...}` (exit 2), show the candidate labels and
     ask which they mean, then re-run with the exact `--bucket <bucket>`.
   - If no project/scope was given, run `--list` (optionally with `--from/--to`) and ask the user to
     pick the affected project(s) and confirm the range. **Skip this prompting whenever the request
     already implies the answer** — e.g. "snafu check on skillroy-tasks, last two sessions" needs no
     questions.

3. **Get the narration pack.** Run the extractor with the resolved project + scope. It prints, per
   session, a `### SESSION <id> <time> "<title>"` header + `USER:`/`CLAUDE:` lines, then a
   `=== CURRENT MEMORY FILES ===` section. Read it.

4. **Investigate the suspicion.** Look specifically for:
   - **naming / terminology drift** — an entity, tool, or component referred to by inconsistent names
     across sessions, or differently from how the memory files name it (e.g. a database called by two
     different names);
   - **reversed or forgotten decisions**, **dropped TODOs / open questions**, **wrong-folder / context
     mix-ups**.

   Key nuances:
   - Memory may have been **corrected after** these sessions, so a mismatch between an older transcript
     and the *current* memory is itself strong evidence the drift happened (and was later fixed).
   - Distinguish a **genuine drift** from a **legitimate incidental mention** — e.g. a fork correctly
     citing its upstream project, or accurate "behavior inherited from X" lineage notes. Judge by what
     the project treats as the **canonical** term and whether usage shifted away from it.

5. **Report.** Lead with a one-line verdict ("Yes, the drift is real" / "No, not supported"). Then list
   findings, each with: a severity (high/medium/low/info), the **quoted evidence** with the
   `[session-id]` it came from, and a concrete recommendation. If the suspicion isn't supported, say so
   plainly and explain why. Be specific; cite, don't paraphrase.

6. **Offer next steps, don't take them.** If a fix is warranted (e.g. correcting a memory file), propose
   it and wait for the user to confirm.

## Example

> "please do a snafu check on project skillroy-tasks in the last two sessions. Claude started referring
> to Kùzu rather than LadybugDB."

→ `node "$SNAFU_DIR/extract.mjs" --project skillroy-tasks --last 2` (disambiguate if needed) → read the
pack → confirm whether the database's canonical name (per memory) drifted to its upstream name across
those sessions, quoting each `[session-id]`, and flag the risk that a fresh session with empty context
could inherit the wrong name. Recommend the fix; apply it only if asked.

## Browsing memory & prompts (a quick look, no investigation)

The same helper also just *shows* things, newest-first. Both default to the **current project**
(inferred from the directory Claude is running in) when the user doesn't name one; pass
`--project "<name>"` (or `--bucket <bucket>`) to target another, and `--last N` to limit the count.

- **Recent MEMORY documents** — newest-modified first:

  ```bash
  node "$SNAFU_DIR/extract.mjs" --memory --last 3
  node "$SNAFU_DIR/extract.mjs" --memory --project skillroy-tasks --last 5
  ```

  e.g. *"show me the last three MEMORY documents in this project."*

- **Recent prompts you typed** — newest first (slash-commands and compaction summaries excluded):

  ```bash
  node "$SNAFU_DIR/extract.mjs" --prompts --last 3
  node "$SNAFU_DIR/extract.mjs" --prompts --project foo --from 2026-06-01
  ```

  e.g. *"show my last three prompts."*

Just relay what the helper prints — it's already formatted. If `--project` is ambiguous it exits 2 with
candidate buckets: show them, ask which, then re-run with `--bucket <bucket>`. If the current project
can't be inferred (the helper says so), ask the user which project they mean.

## Notes
- Requires `node` on PATH (the helper is zero-dependency). If `node` is somehow unavailable, fall back
  to reading the `*.jsonl` yourself with the same filtering, but that's a last resort.
- This skill is the one-off companion to the full **SNAFU Analyzer** web app (same repo), which adds a
  browsing UI and deterministic detectors. Use the web app for broad scans; use this for a quick,
  targeted "did X drift?" check.
