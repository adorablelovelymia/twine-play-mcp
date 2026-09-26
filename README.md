# twine-play-mcp

An MCP server that lets AI agents **play, test and QA Twine / interactive-fiction HTML games**.

The agent reads the current passage, sees numbered choices, clicks them, watches story
variables, screenshots the game, and can save/restore state to explore branches — all
through a small, token-friendly tool surface instead of a generic browser automation API.

```
Agent  ──MCP(stdio)──>  twine-play-mcp  ──Playwright──>  headless Chrome
                              │                               │
                              │  static server (127.0.0.1)    │  injected bridge
                              └────────> game HTML <──────────┘
```

## Why not a generic browser MCP?

Generic browser MCPs make the model guess DOM selectors, dump whole pages into context
and have no notion of "story state". This server adds a semantic layer:

- **Passage view**: text as Markdown, passage name, format/version, story metadata
- **Numbered choices** with target passage names (and external-link blocking)
- **Story variables** (SugarCube `State.variables`) with safe depth/size caps
- **Native state**: SugarCube `Engine.backward/forward`, `Save.base64` snapshots
- **Format detection**: SugarCube first, DOM fallback for Harlowe / Snowman / Chapbook / unknown
- **Tracker blocking** and quiet console/network capture for clean playtesting

## Requirements

- Node.js >= 20 (developed on 26)
- Google Chrome installed (uses `channel: 'chrome'`; no 200 MB browser download)
- Linux/macOS/Windows

## Quick start

```bash
npm install
npm run build          # compiles to dist/ and copies the page bridge

# sanity checks (optional)
npm run spike          # 17 end-to-end checks against a real SugarCube game
npm run smoke          # spawns the MCP server over stdio and drives it with the MCP SDK
```

Point it at any published Twine HTML file (or a folder containing the game + assets):

```bash
node dist/index.js     # MCP server on stdio
```

## Client configuration

### OpenCode (`~/.config/opencode/opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "twine-play": {
      "type": "local",
      "command": ["node", "/absolute/path/to/twine-play-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

### Claude Desktop / Cursor / any `mcpServers` client

```json
{
  "mcpServers": {
    "twine-play": {
      "command": "node",
      "args": ["/absolute/path/to/twine-play-mcp/dist/index.js"]
    }
  }
}
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `TWMCP_CHROME_PATH` | Chrome executable if `channel: 'chrome'` cannot find it |
| `TWMCP_DOWNLOAD_DIR` | Folder where browser downloads are captured (default `~/.cache/twine-play-mcp/downloads`) |
| `TWMCP_VIEW_PORT` / `TWMCP_VIEW_HOST` | Live-view server port (default `4571`, auto-increments if busy) and bind host (default `127.0.0.1`) |

## Tools

| Tool | What it does |
| --- | --- |
| `open_game` | Open a local HTML file/folder or URL; optional PRNG seed; returns first observation |
| `observe` | Passage text, numbered choices, inputs (paginated windows of 40 with `inputs_offset`), dialog, status bar; `since_last` saves tokens; `format:"json"` for structured output |
| `choose` | Click by 1-based number or label; works for passage choices *and* dialog buttons; `expected` guard; external links blocked by default |
| `wait` | Wait for ms / for text / for the DOM to settle |
| `interact` | Fill inputs/selects/checkboxes by ref, or press a key |
| `find_ui` | Find buttons/links/**labels**/inputs by visible text or input name; returns refs for `click_ui`/`interact`. The fastest way to reach radio/checkbox options (SugarCube macro labels) |
| `click_ui` | Click dialogs, sidebar and menus (by ref / CSS selector / visible text), including `<label>`-based controls and iframes |
| `upload_file` | Upload a local file into an `<input type=file>` (mod .zip, .save import) via trigger button or direct input, frame-aware |
| `download_file` | Browser file control (any game): copy a captured download to a path — by `trigger_text`/`trigger_ref` (click the game's download button), by `name`/`index` from the download folder, or the newest file by default. The folder copy stays |
| `list_downloads` | List files captured into the tool's persistent download folder (survives sessions/restarts), with name, size, time and absolute path |
| `inspect_ui` | Inspect or discover UI panels outside the passage (mod GUIs, backstage); lists buttons/inputs and file inputs |
| `get_variables` | Read story variables by dot path (`V.hairlength`), or a shallow top-level key summary; avoids dumping the whole variable state |
| `back` | Undo one passage (SugarCube `Engine.backward`) |
| `restart` | Restart from the beginning, optionally reseeding the PRNG |
| `save_state` / `load_state` | Named in-session snapshots for branch exploration |
| `screenshot` | PNG of the viewport (canvas/visual games, visual QA); pass `path` to save to disk |
| `live_view` | Give the user eyes on the real page: local URL streaming JPEG frames (~1/s) of the actual Playwright tab + passage/step/journal; works headless; `open:true` launches the default browser |
| `get_console_errors` | JS exceptions, console errors and HTTP failures captured from the page |
| `get_journal` | Action history: passages visited, choices taken, coverage counts |
| `list_games` / `close_game` | Session management |

### Watching the page (live view)

`live_view(game_id)` starts a tiny local server (once per MCP process, port 4571+) and returns a URL
like `http://127.0.0.1:4571/v/game_abc`. Open it in any browser (or pass `open: true`) to watch the
**actual tab the agent is driving** — a JPEG frame about once per second, plus passage, step, engine
state, recent actions and the passage text. It works with headless games, frames are captured only
while somebody is watching, and closing the game stops it. For a raw browser window instead, open the
game with `headless: false` (`open_game`).

Handy combo: if your client can show a web page in a side pane (e.g. OpenCode's Review pane /
`browser.tabs.open`), point it at the live-view URL and you can follow along while the agent plays.

**Pick one view (agents).** To keep the user's screen clean, show a running game through exactly one
channel — never stack them:

1. **Default:** `live_view` — hand the URL to the user, or pass `open: true` once to launch it for
   them. Repeated calls reuse the same view and never open another tab.
2. **Only on explicit request:** `open_game(headless: false)` when the user asks for a real browser
   window. Don't add a live view on top; a headed window is already visible.
3. `screenshot` is a one-shot visual check, **not** a stream — don't loop it to "show" the game.

If a view (live view tab or headed window) is already open, reuse it instead of starting a second
one. The MCP server ships this same policy in its `instructions` field, so MCP clients can pass it
to the model automatically; the tool descriptions repeat it where it matters (`live_view`,
`open_game.headless`, `screenshot`).

### Agent ergonomics

- **Output**: every play tool returns a formatted text observation (a string). Pass `format:"json"`
  to receive a JSON string instead (`JSON.parse` it) with `passage`, `text`, `choices[{n,label,target}]`,
  `inputs[{ref,kind,label,checked}]`, `inputsTotal`, `dialog`, `status`.
- **Inputs are paginated, not truncated**: a header like `Inputs (41-80 of 140)` plus
  `inputs_offset=80` means everything is reachable — no silent hard cap.
- **Label matching**: `click_ui(text)` and `find_ui(text)` understand SugarCube `<<radiobutton>>` /
  `<<checkbox>>` labels, so options like "Jet black" or combat moves like "Punch" are clickable by text.
- **Errors are compact**: failures return `ERROR: code — message`, a `Hint`, the current passage and the
  available choices — never a full observation dump.
- **Variables**: observations do not embed variable blobs by default; use `get_variables` for the keys
  you care about. `include_variables:true` is still available when you want the (truncated) dump.
- **Dialogs**: dialog buttons appear as numbered choices tagged `[dialog]`, and a `Dialog buttons:` line
  lists them; checkbox labels are shown on the input line.


## Format support

| Format | Detect | Text/choices | Variables | Passage name | Back | Snapshots |
| --- | --- | --- | --- | --- | --- | --- |
| **SugarCube 2.21+** | ✅ | ✅ | ✅ `State.variables` | ✅ | ✅ `Engine.backward` | ✅ `Save.base64` (2.37+) / `Save.deserialize` (older) |
| **Harlowe 3** | ✅ | ✅ | — (engine internals are private) | — | ✅ sidebar undo | — |
| **Snowman 2** | ✅ | ✅ | ✅ `story.state` | ✅ | — | ✅ state JSON |
| **Chapbook 1** | ✅ | ✅ | ✅ `engine.state.saveToObject()` | ✅ `trail` | — | ✅ `restoreFromObject` |
| **Unknown HTML** | generic | ✅ DOM heuristics | — | — | — | — |

Everything degrades gracefully: an unknown or exotic format still plays with the generic DOM
path; format-specific tools report `unsupported` instead of failing.

## Play-session example (what the agent sees)

```
[sugarcube 2.37.3 · step 3 · engine=idle · passage: 069]
You squeeze through the narrow gap...

Choices (2):
  1. Go deeper -> 070
  2. Check the mirror

Status:
Resistance: 500/500
Variables: {"resistance":500,"pleasure":0,"degradation":0,...}
```

## How it works

- `src/bridge/bridge.js` is injected into every page (`addInitScript`) and exposes
  `window.__twineMCP`: format detection, passage/choice extraction, click/fill helpers,
  settle-waiting, snapshots and seeding. All server calls go through this bridge only.
- `src/session.ts` owns the browser, one `BrowserContext` per game (isolated saves) and a
  tiny static server so local games run on `http://127.0.0.1` (localStorage works).
- `src/render.ts` turns observations into compact Markdown for the model.
- Choices get temporary `data-twmcp-ref` attributes; the server prefers real Playwright
  clicks and falls back to DOM clicks for exotic macro-generated links.
- Spoiler policy: only what a player can see is returned. No passage lists or source
  dumps are exposed.

## Complex games

Real games are not just passages and links. The MCP handles the awkward parts:

- **Modal dialogs** (SugarCube `#ui-dialog`, content gates, settings): their text appears as a
  `Dialog:` block and their buttons/inputs are numbered like choices, so the agent can tick a
  consent checkbox (`interact`) and click `Enter` (`choose`).
- **Iframes**: mod managers and dev panels often live in a child frame. `inspect_ui` discovers
  them (marked `[iframe]`), `click_ui` by text and `upload_file` search every frame.
- **File workflows**: uploads go through `upload_file` (mod `.zip`, save import) — by clicking a
  trigger (`trigger_text` / `trigger_selector`, e.g. `#saves-import`) or pointing at an
  `<input type=file>` directly. Downloads go the other way through a persistent download folder:
  every browser download is captured there (`TWMCP_DOWNLOAD_DIR` overrides the location),
  `list_downloads` shows the contents, and `download_file` copies one anywhere (`path`, default
  `<cwd>/downloads/<name>`) — either by clicking the game's export button or by `name`/`index`
  afterwards. No manual temp-folder copying, and files survive `close_game` and MCP restarts.
- **DoL case study**: `test/fixtures` aside, `scripts/dol-mcp-test.ts` drives Degrees of
  Lewdity end to end — consent gate → importing `ModI18N.mod.zip` and
  `GameOriginalImagePack.mod.zip` through the in-game ModLoader GUI → page reload → importing
  a real `.save` through the SAVES dialog → several turns of normal play.

## Tests

```bash
npm run spike      # 17 checks against a real SugarCube 2.37 game (play, back, snapshot, screenshot)
npm run formats    # 4 compiled fixtures: SugarCube 2.30, Harlowe 3.1, Snowman 2.0, Chapbook 1.0
npm run smoke      # spawns the built MCP server and drives the tools over stdio
npm run clarity    # agent-ergonomics regression on DoL character creation (pagination, labels, variables)
npm run fixtures   # rebuild test/fixtures/compiled/*.html with Tweego (see test/fixtures/build.sh)
npx tsx scripts/dol-mcp-test.ts   # Degrees of Lewdity: gate, mod import, save import, play
```

`scripts/inspect.ts <fixture>` dumps the DOM/story-format internals of a game — handy when
adding a new adapter.

## Status / roadmap

- [x] M1: SugarCube adapter, generic DOM fallback, observation/choice/input/wait/screenshot,
      snapshots, backtracking, console+network QA capture, stdio MCP, spike + smoke tests
- [x] M2: Harlowe / Chapbook / Snowman adapters verified against compiled fixtures
- [x] M2: play journal (`get_journal`) for run summaries, resuming and QA coverage
- [x] M3: dialogs/iframe-aware UI control (`click_ui`, `inspect_ui`, `upload_file`) — verified on
      Degrees of Lewdity (mod import + save import + play)
- [x] M4: agent ergonomics — input pagination + totals, `find_ui` label search, `get_variables`,
      `format:"json"`, compact errors (driven by a naive-agent playtest that stalled on DoL
      character creation)
- [x] M4: file workflows both ways — `upload_file` for mods/saves, `download_file` + `list_downloads`
      for a persistent browser download folder (no temp-folder copying)
- [x] M5: live view — watch the real page in any browser (~1 fps frames + passage/step/journal);
      headed mode via `open_game(headless: false)`
- [ ] M3: `click_at` for canvas games, spoiler-gated story-map analysis, npm packaging

## Safety notes

- Page scripts run in Chrome's sandbox; the bridge never exposes Node to the page.
- No arbitrary `eval` tool is exposed to the agent.
- Analytics/tracker hosts are blocked by default (`block_trackers: false` to disable).
- External links are blocked unless `allow_external: true` is passed.

## 中文速览

这是一个让 AI agent 游玩 / 测试 Twine 文字游戏的 MCP 服务：无头 Chrome + 页面桥，
提供观察、选项点击、变量读取、存档回溯、截图、控制台 QA 等 22 个工具。
本地游戏会通过内置静态服务器以 `http://127.0.0.1` 打开（保证存档可用），
支持 SugarCube 原生 API，其余格式走通用 DOM 兜底。
只看不猜：`live_view` 给你一个本地网址，用任意浏览器就能实时看到 AI 正在操作的真实页面；
也可以 `open_game(headless: false)` 直接弹出浏览器窗口。
显示方式只选一种：默认 `live_view`（需要时让它帮你打开一次），用户明说要真实窗口才用有头模式，
别同时叠加窗口/标签页/反复截图刷屏——MCP 的 `instructions` 与工具说明里都写了这条规则。
配置方式见上方 OpenCode / Claude Desktop 片段。
