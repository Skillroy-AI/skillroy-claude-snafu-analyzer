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
# open http://localhost:4999
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

## `/snafu` skill — one-off investigation, no server

For a quick "did X drift across my last sessions?" check without starting the web app, this repo ships
a Claude Code **skill** at [`.claude/skills/snafu/`](.claude/skills/snafu/). Here, **Claude itself is
the analyzer** — there's no server and no `claude -p` subprocess. A bundled zero-dependency helper
(`extract.mjs`) finds the right transcripts, strips them to the narration, and appends the project's
memory; Claude reads that and judges your suspicion.

It's available automatically when you run Claude Code **in this repo**. To use it **anywhere**, install
it at the user level:

```bash
# symlink keeps it in sync with the repo; or use cp -r to copy
ln -s "$PWD/.claude/skills/snafu" ~/.claude/skills/snafu
```

Then invoke it conversationally — it infers what it can and only asks for what's missing:

```
/snafu                       # walks you through range → project(s) → suspicion
snafu check on skillroy-tasks, last 2 sessions — did the DB name drift from LadybugDB to Kùzu?
```

The helper is also usable on its own: `node .claude/skills/snafu/extract.mjs --list` or
`--project <name> --last <N>`.

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
| `PORT` / `--port` | `4999` | server port |
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
