# Contributing

Thanks for hacking on the SNAFU Analyzer. This is a small, dependency-light proof of concept — please
keep it that way.

## Prerequisites

- [Node.js](https://nodejs.org) 18+ (developed on 24)
- Optional: the [`claude` CLI](https://claude.com/claude-code) on `PATH` for the semantic
  analyze/investigate features (no API key needed)

## Setup & common commands

```bash
git clone https://github.com/Skillroy-AI/skillroy-claude-snafu-analyzer.git
cd skillroy-claude-snafu-analyzer
npm install

npm start          # run the web app (tsx, no build) → http://localhost:4999
npm run dev        # same, with auto-reload
npm run build      # type-check + compile to dist/
npm run serve      # run the compiled dist/ build
npm test           # node --test with the tsx loader
```

Run `npm run build && npm test` before opening a PR.

## Project layout

There are **two surfaces** over the same idea (parse transcripts → find snafus):

| Path | What |
|---|---|
| `src/` | The web app — Express JSON API + the analysis engine (TypeScript, ESM/NodeNext) |
| `web/` | The browser UI — **dependency-free vanilla** HTML/CSS/JS (no build step) |
| `.claude/skills/snafu/` | The `/snafu` skill — `SKILL.md` + a **zero-dependency** `extract.mjs` |
| `test/` | `node:test` suites using synthetic fixtures (no real transcripts) |

`src/` modules: `discover` (find buckets) → `parse` (JSONL → rounds/signals/cwd-timeline) →
`extract` (heuristic signals) → `detectors` (deterministic findings) / `analyze-claude` (optional
`claude -p` passes); `store` caches + scopes; `server` exposes the API + static UI; `index` is the CLI.

## Design principles (don't break these)

- **Read-only.** Never modify the user's transcripts, memory, or projects. The analyzer only reads.
- **Group by real `cwd`, not the folder name.** Claude Code encodes a transcript's folder from its cwd
  by turning `/` into `-`, which is lossy (`foo/research` and `foo-research` collapse together). Always
  rely on the `cwd` field recorded on each event. Hide the analyzer's own `claude -p` sub-runs (they log
  under the OS temp dir).
- **Heuristics are triage, not verdicts.** Deterministic signals are intentionally generous; every
  finding must carry its evidence so a human can judge it.
- **Stay dependency-light.** Runtime deps: just `express`. The web UI and `extract.mjs` have **zero**
  dependencies — keep them that way.

### ⚠️ Two narration extractors, on purpose

The "narration pack" (human prompts + Claude's text, tool I/O stripped) is produced in two places:

- `src/parse.ts` → `sessionNarration()` — typed, used by the web app's Investigate endpoint
- `.claude/skills/snafu/extract.mjs` — standalone & zero-dep, so the skill works without the repo built

They intentionally duplicate the parsing logic (wrapper-stripping, temp-run suppression, etc.). **If you
change one, change the other** — or unify them (see roadmap).

## Tests

`npm test` runs `test/*.test.ts` via `node --test`. Tests build their own tiny JSONL fixtures, so they
don't depend on anyone's real `~/.claude` history — please keep new tests self-contained and portable.

## Roadmap / open ideas

- A deterministic **regression / contradiction** detector (currently only the `claude -p` passes catch
  semantic drift).
- **Unify the two narration extractors** (e.g. have the skill shell out to a compiled CLI, or generate
  `extract.mjs` from `src/`).
- Tests for `detectors.ts` and the skill's `extract.mjs`.
- A cleaner home for the `claude -p` sub-run transcripts (dedicated dir + cleanup) instead of relying on
  temp-dir suppression.
- Packaging the skill for install without cloning (plugin / marketplace).

## Pull requests

Branch off `main`, keep commits focused with imperative subjects, ensure `build` + `test` pass, and open
a PR against `Skillroy-AI/skillroy-claude-snafu-analyzer`. By contributing you agree your changes are
licensed under the project's [MIT License](README.md#license).
