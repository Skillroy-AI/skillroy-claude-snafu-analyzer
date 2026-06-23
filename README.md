# Claude SNAFU Analyzer by Skillroy.AI

## TL;DR

**Ask Claude to install:**

```
Please clone https://github.com/Skillroy-AI/skillroy-claude-snafu-analyzer.git, then install the snafu skill globally for me via linking.
```

Then restart Claude and reload skills (only needed first time):

```
/reload-skills
```

**Example Usage:**

```
/snafu check on my-project, last 3 sessions — did Claude start contradicting an earlier decision about <topic>?
```

> [!TIP]
>
> 1. Periodically ask Claude to check Github for updates to the snafu skill.
> 2. There is also a web UI for browsing through your transcripts and searching for issues (see "option 2" below).

## About

A local tool that reviews your **Claude Code transcripts and memory files** and surfaces *snafus* —
things that quietly went sideways across sessions. Use it either as a one-message **`/snafu` skill**
inside Claude Code, or as a **local web app** with a browsable UI. It finds:

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

First, get the code (needed for either option). You'll need [Node.js](https://nodejs.org) 18+:

```bash
git clone https://github.com/Skillroy-AI/skillroy-claude-snafu-analyzer.git
```

## Option 1 — the `/snafu` skill (quickest)

Investigate a suspicion in a single message, right inside [Claude Code](https://claude.com/claude-code)
— no server to run. Make `/snafu` available in **every** project by linking it into your personal
skills folder.

**macOS / Linux**

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skillroy-claude-snafu-analyzer/.claude/skills/snafu" ~/.claude/skills/snafu
```

**Windows** — PowerShell, run from the folder where you cloned:

```powershell
New-Item -ItemType SymbolicLink -Path "$HOME\.claude\skills\snafu" -Target "$PWD\skillroy-claude-snafu-analyzer\.claude\skills\snafu"
```

(Prefer copying over linking? Use `cp -r` / `xcopy` instead — but you'll have to re-copy to get updates.)

Then **restart Claude Code** so it loads the skill. Now just describe what you suspect — it infers the
rest and asks only for what's missing:

```
snafu check on my-project, last 3 sessions — did Claude start contradicting an earlier decision?
```

…or type `/snafu` with no details and it walks you through: date range → project(s) → your suspicion.
It's read-only: it reports what it found (and the session it came from) and suggests a fix without
making one.

> Stuck on a step? Paste it into Claude Code and ask it to set the skill up for you.

### Example: investigating regressions

Recurring regressions — especially while splitting a large codebase into smaller pieces — often trace
back to drift across sessions: a fix that got quietly reverted, or a plan that changed without being
written down. Point `/snafu` at the span where things went wrong:

```
snafu check on my-project, last 5 sessions — a bug we fixed earlier came back; did a later session revert or contradict the fix?
```
```
snafu check on my-project this week — did the plan for splitting <module> change between sessions without being saved to memory?
```

It reads those sessions' narration + memory and tells you what drifted and which session it came from,
then suggests a fix (read-only — it won't change anything). The web app's **🔎 Investigate…** button
does the same thing, point-and-click, and is handy for very large spans.

## Option 2 — the web app (browsable UI)

The web app adds a clickable timeline and always-on deterministic detectors across **all** your
projects at once. Needs [Node.js](https://nodejs.org) 18+.

```bash
cd skillroy-claude-snafu-analyzer
npm install          # one-time: install dependencies
npm start            # start the local server
# then open the printed URL, e.g. http://localhost:4999
```

Pick a date range (and optionally a project), hit **Scan**, and review the **SNAFUs** tab; click any
evidence to jump to that session. If the [`claude` CLI](https://claude.com/claude-code) is on your
`PATH` (no API key needed), two extra buttons appear:

- **Analyze with Claude** — a broad semantic scan of everything in scope.
- **🔎 Investigate…** — the guided, point-and-click version of the `/snafu` skill.

Everything is read-only — it never changes your transcripts, memory, or projects.

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
