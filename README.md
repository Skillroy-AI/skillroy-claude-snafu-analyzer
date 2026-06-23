# SNAFU Analyzer

A small local web app that reviews your **Claude Code transcripts and memory files** and surfaces
*snafus* — things that quietly went sideways across sessions:

- **Folder / context mix-ups** — you moved or renamed a project but kept running Claude from the old
  path, so work landed in the wrong repo and cwd-scoped memory drifted. (Claude Code derives a
  transcript's folder from its cwd by turning `/` into `-`, so `…/foo/research` and `…/foo-research`
  collapse into the **same** transcript folder and get co-mingled — this tool untangles them by the
  real `cwd` recorded on every event.)
- **Dropped threads** — a TODO / follow-up / open question raised in one session and never actioned.
- **Decisions never persisted** — a decision discussed in chat but missing from your memory files.
- **Abandoned / stub sessions** — opened in a stale or orphaned folder and left empty.
- **Drift / contradictions** *(optional, via your local `claude` CLI)* — a later session asserts or
  builds something that conflicts with an earlier decision or your stated intent.

It's read-only: it never modifies transcripts, memory, or your projects.

## Quick start

```bash
npm install
npm start            # or: npm run dev   (auto-reload)
# open http://localhost:4317
```

Then pick a date range (and optionally a project), hit **Scan**, and review the **SNAFUs** tab.
Click any piece of evidence to jump to that session; the **Session** tab shows the round-by-round
timeline (your prompt → Claude's end-of-round summary → tools → extracted signals); the **Memory**
tab shows the project's memory files.

### Optional: Claude-powered analysis

If the [`claude` CLI](https://claude.com/claude-code) is on your `PATH` (no API key needed), two
buttons light up. If `claude` isn't found they degrade gracefully and the deterministic findings stand.

- **Analyze with Claude** — a *broad* one-shot scan: sends a compact digest of the in-scope sessions +
  memory to `claude -p` to catch contradictions/drift/dropped threads that keyword heuristics miss.

- **🔎 Investigate…** — a *targeted* investigation when you already suspect something. A guided flow:
  1. pick a date/time range → the tool lists the projects that had sessions in that window;
  2. select the affected project(s);
  3. describe the issue in your own words (e.g. *"the database may have been called by the wrong name
     in a later session"*).

  The tool then sends Claude a **narration pack** — just the human prompts + Claude's text (tool
  input/output stripped, so it's compact) — for the selected sessions, plus the project's *current*
  memory files, and asks it to judge whether your suspicion holds, quoting the evidence per session.
  Because memory may have been corrected after the fact, a mismatch between an older transcript and
  current memory is itself treated as evidence the drift happened — so this catches issues that no
  longer exist anywhere except the transcript.

## How it works

```
~/.claude/projects/<bucket>/<sessionId>.jsonl   ─┐
~/.claude/projects/<bucket>/memory/*.md          ├─►  parse → rounds + signals
                                                 ┘         │
                                          deterministic detectors ─┐
                                          optional `claude -p` ─────┴─►  findings → web UI
```

- `src/discover.ts` — find transcript buckets + memory dirs (override root with `SNAFU_PROJECTS_DIR`).
- `src/parse.ts` — stream a JSONL transcript into a normalized session: rounds, per-event `cwd`
  timeline, tool calls, git branch, AI title. Distinguishes real human prompts from tool-results
  and slash-command wrappers.
- `src/extract.ts` — heuristic signals (todo / decision / open_question / claim / commit /
  memory_write / file_move / handover / wrong_folder).
- `src/detectors.ts` — explainable deterministic SNAFU detectors (each finding carries its evidence).
- `src/analyze-claude.ts` — optional semantic pass through the local `claude` CLI.
- `src/store.ts` / `src/server.ts` — mtime-cached index + Express JSON API + static UI.
- `web/` — dependency-free single-page UI.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `--port` | `4317` | server port |
| `SNAFU_PROJECTS_DIR` / `--projects-dir` | `~/.claude/projects` | where transcripts live |
| `SNAFU_CLAUDE_BIN` | `claude` | path to the `claude` CLI for the optional pass |

## API (for scripting)

`GET /api/projects` · `GET /api/sessions?from&to&project&q` · `GET /api/sessions/:id` ·
`GET /api/snafus?from&to&project` · `GET /api/memory?project` · `GET /api/claude/available` ·
`POST /api/analyze?from&to&project` · `GET /api/projects-in-range?from&to` ·
`POST /api/investigate` (body: `{from, to, projects[], issue}`)

## Caveats

This is a proof of concept. The heuristic signals are deliberately generous (a few false positives
beat missing a real dropped decision), so treat findings as triage, not verdicts — the evidence is
always one click away. Severity ranking and detectors are easy to tune in `src/detectors.ts`.

## License

MIT
