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

### Optional: semantic pass with Claude

If the [`claude` CLI](https://claude.com/claude-code) is on your `PATH`, the **Analyze with Claude**
button sends a compact, self-contained digest of the in-scope sessions + memory to a one-shot
`claude -p` run to catch contradictions/drift that keyword heuristics miss. No API key needed; if
`claude` isn't found, the button just reports that and the deterministic findings still stand.

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
`POST /api/analyze?from&to&project`

## Caveats

This is a proof of concept. The heuristic signals are deliberately generous (a few false positives
beat missing a real dropped decision), so treat findings as triage, not verdicts — the evidence is
always one click away. Severity ranking and detectors are easy to tune in `src/detectors.ts`.

## License

MIT
