# Contributing

Thanks for helping. The user-facing docs live in [README.md](README.md) /
[README-zh.md](README-zh.md); everything below is for people working on the server itself.

## Repository map

```
src/
  index.ts          stdio transport, signal handling
  server.ts         the MCP tool surface — one tool per user-facing verb
  session.ts        SessionManager: browser, per-game contexts, static server, downloads
  render.ts         observations -> the text a model reads
  live-view.ts      the local JPEG stream the user watches
  static-server.ts  serves a local game over 127.0.0.1 so localStorage/saves work
  bridge/bridge.js  injected into every page (plain JS, no build step); sees the DOM
scripts/            self-checks and dev tools (see below)
test/fixtures/      4 story formats compiled to html — the fixture test data
```

## How it works

- **The page bridge** (`src/bridge/bridge.js`) is injected with `addInitScript` before any game
  script runs, and exposes `window.__twineMCP`. Every DOM-touching operation goes through it:
  format detection, passage/choice extraction, click/fill helpers, settle-waiting, snapshots,
  seeding. It is plain JS on purpose — it is shipped to the browser as-is.
- **One `BrowserContext` per game** keeps saves and localStorage isolated, and a tiny static server
  puts local games on `http://127.0.0.1` (needed for `localStorage` to work at all).
- **Every interactive element gets a temporary `data-twmcp-ref`** during an observation. The server
  prefers a real Playwright click, and falls back to a DOM `click()` for exotic macro-generated
  links. Refs are re-assigned on every observation, which is why a stale ref is a normal error.
- **Spoiler policy**: only what a player can see is returned. No passage list, no source dump.

## Adding a story-format adapter

1. `src/bridge/bridge.js` — extend `detectFormat()` and the per-format branches of
   `readPassageName()`, `readVariables()`, `back()`, `snapshot()`, `restore()`, `goTo()`, `seed()`.
   Return `{ ok: false, error: 'unsupported', message: '...' }` when the format has no such API —
   never throw, and never fake it.
2. `test/fixtures/<format>.twee` — add a small three-passage fixture that exercises text, choices,
   a variable, a snapshot round trip and (if supported) `back`.
3. `test/fixtures/build.sh` — add the `-f <format>` line for Tweego, then `npm run fixtures`.
4. `scripts/formats.ts` — add a `CASES` entry with the expected behaviour, including which
   capabilities are `unsupported`.
5. `npx tsx scripts/debug.ts probe <fixture>` dumps the format's DOM and engine globals if you need
   to see what the engine exposes.

Then update the support matrix in both READMEs.

## Scripts

| Script | Needs | What it covers |
| --- | --- | --- |
| `npm test` | nothing | Build, 4-format fixture checks, tool-surface snapshot + byte budget, doc check |
| `npm run smoke` | `TWMCP_GAME` | Full MCP round trip over stdio: open, play, snapshots, downloads, live view |
| `npm run spike` | `TWMCP_GAME` | Longer single-format play: variables, N steps, back, screenshot |
| `npm run clarity` | `TWMCP_GAME` | Agent-ergonomics regressions: input pagination, label matching, error shape |
| `npm run formats` | nothing | Just the fixture checks |
| `npm run tools` | nothing | Print the tool surface; refresh `test/tools.snapshot.json` |
| `npm run docs` | nothing | Regenerate the README tool tables |
| `npm run debug` | varies | Ad-hoc tools — see `npx tsx scripts/debug.ts` for the subcommands |
| `npm run fixtures` | Tweego in `.tools/` | Rebuild `test/fixtures/compiled/*.html` from the `.twee` sources |

`npm test` is the one that must always work on a clean clone: the compiled fixtures are committed
on purpose, so no Tweego install is needed. The `TWMCP_GAME` scripts skip cleanly (exit 0) when no
game is configured, so they are safe to wire into CI.

### The tool-surface budget

`scripts/tools.ts` measures the JSON a client actually receives (`tools/list`) and enforces a byte
budget plus a per-description limit, and pins tool/parameter names in
`test/tools.snapshot.json`. Every tool definition costs context in *every* session, so growing the
surface is a deliberate act, not a side effect.

```bash
npx tsx scripts/tools.ts            # show the surface, refresh the snapshot
npx tsx scripts/tools.ts --check    # fail if names/parameters changed
npx tsx scripts/tools.ts --budget   # fail if the surface or a description grew past budget
```

After an intentional change: refresh the snapshot, bump `SURFACE_BUDGET_BYTES` if the new tool is
worth it, and update `scripts/docs.ts` (it fails on an undocumented tool).

## Docs are generated

The tool tables in both READMEs are produced from the live tool list:

```bash
npx tsx scripts/docs.ts            # regenerate the blocks between the markers
npx tsx scripts/docs.ts --check    # fail when they are stale
```

Only the group labels and one-line summaries in `scripts/docs.ts` are hand-written. If you add a
tool, `docs.ts` fails until it is mapped there — that is intentional, so the README cannot drift.

## Style notes

- Keep tool **descriptions** short; put detail in the parameter descriptions. `tools.ts --budget`
  enforces a per-description limit.
- Error messages must be actionable: a `Hint`, and the choices/passages the agent can act on.
  Prefer `errResult()` over a bare `errorText()` in a `catch`.
- Never swallow a failure into a silently-empty result — a poisoned observation is worse than a
  loud error.
- `src/bridge/bridge.js` is not type-checked. Change it carefully and lean on `npm test` and
  `npm run smoke`.

## Roadmap

- [ ] `click_at(x, y)` for canvas-only games
- [ ] Optional spoiler-gated story-map analysis
- [ ] A second fixture per format covering dialogs and iframes
