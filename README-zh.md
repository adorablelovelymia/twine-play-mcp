# twine-play-mcp

[English](README.md) · **简体中文**

让 AI agent **游玩、测试并 QA Twine / 互动小说 HTML 游戏** 的 MCP 服务。

agent 能读取当前段落、点击带编号的选项、填写输入框、观察故事变量、应答游戏对话框、存快照以
探索分支，还能把真实页面实时投给你看——用的是一个小巧省 token 的工具面，而不是通用浏览器自动化。

```
Agent  ──MCP(stdio)──>  twine-play-mcp  ──Playwright──>  无头 Chrome
                              │                               │
                              │  静态服务器 (127.0.0.1)        │  注入页面桥
                              └────────> 游戏 HTML <──────────┘
```

## 环境要求

- **Node.js ≥ 20**
- 已安装 **Google Chrome**（通过 `channel: 'chrome'` 调用，不会额外下载 200 MB 浏览器）
- Linux / macOS / Windows

## 安装

```bash
npm install -g twine-play-mcp   # 或者直接：npx twine-play-mcp
```

npm 包里已包含编译好的服务端与页面桥，无需构建步骤。

## 客户端配置

把服务加进你的 MCP 客户端。任何 `mcpServers` 形式的客户端都可以：

```json
{
  "mcpServers": {
    "twine-play": {
      "command": "npx",
      "args": ["-y", "twine-play-mcp"]
    }
  }
}
```

OpenCode 用自己的一套结构（`~/.config/opencode/opencode.json`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "twine-play": { "type": "local", "command": ["npx", "-y", "twine-play-mcp"], "enabled": true }
  }
}
```

现成配置文件见 [`examples/`](examples)。环境变量全部可选：

- `TWMCP_CHROME_PATH` —— `channel: 'chrome'` 找不到时的 Chrome 可执行文件路径
- `TWMCP_DOWNLOAD_DIR` —— 浏览器下载的捕获目录（默认 `~/.cache/twine-play-mcp/downloads`，不可写时自动降级）
- `TWMCP_VIEW_HOST` / `TWMCP_VIEW_PORT` —— 实时视图的绑定地址（默认 `127.0.0.1`）与起始端口（默认 `4571`，占用时递增）
- `TWMCP_BLOCK_TRACKERS` —— 设为 `0` 可不再拦截统计站点

## 快速开始

让 agent 做这件事即可——**游戏路径是 `open_game` 工具的入参，不是命令行参数**。
不存在 `twine-play-mcp game.html` 这种用法。

> 用 twine-play-mcp 打开 `/path/to/game.html`，告诉我第一段写了什么。

底层发生的事，以及 agent 看到的内容：

```
open_game({ source: "/path/to/game.html" })
  Opened game "game_c5ac1a" (/path/to/game.html)
  game_id: game_c5ac1a
  Story: TS Ero Trap Dungeon · Format: sugarcube 2.31.1 · ifid: ...
  Served from: http://127.0.0.1:41235/
  [sugarcube 2.31.1 · step 0 · engine=idle · passage: Title]
  ...
  Choices (1):
    1. Start -> Prologue

choose({ choice: 1 })          # 或者 click_ui / interact / navigate
  Clicked: "Start" -> Prologue
  [sugarcube 2.31.1 · step 1 · engine=idle · passage: Prologue]
  ...

observe({ for_text: "你醒来" })          # 等待定时段落，然后读取
interact({ ref: "i1", value: "Shiori" }) # 填写表单
snapshot({ action: "save", name: "before-boss" })
live_view({})                  # 把一个能实时观看真实页面的 URL 交给用户
```

只打开一个游戏时 `game_id` 可以省略，少些噪音；打开多个时必须传，报错会把候选列出来。

## 工具一览

工具面刻意保持很小：相关的动词合在一起，而不是各自开一个工具（`navigate` 管 back/restart/goto，
`snapshot` 管 save/load/list，`get_logs` 管 console + journal）；只有一个开关的类型收进
`action:` / `kind:` 参数里。

<!-- tools:begin -->
**开局与阅读**

| 工具 | 作用 |
| --- | --- |
| `open_game` | 打开本地文件／文件夹或 http(s) 网址，返回第一次观测。 |
| `observe` | 当前段落文本、选项、输入框、对话框与状态栏。传 `for_text` 或 `wait_ms` 可先等待。 |
| `session` | `list` 列出已打开的游戏，`close` 关闭其中一个。 |

**操作**

| 工具 | 作用 |
| --- | --- |
| `choose` | 按 1-based 编号或标签点击选项，对话框按钮同样适用。 |
| `click_ui` | 按 ref、CSS 选择器或可见文本点击侧边栏按钮与菜单。 |
| `interact` | 按 ref 填写输入框／下拉框／复选框，或按键。 |
| `navigate` | `back` 回退一段、`restart` 重新开始，或 `goto` 直达指定段落。 |

**查看**

| 工具 | 作用 |
| --- | --- |
| `find_ui` | 按文本或 input name 查找控件；也可检查某个 DOM 子树或发现浮层面板。 |
| `get_variables` | 按点路径读取 SugarCube `State.variables`，或只看顶层键摘要。 |
| `get_logs` | 控制台报错／HTTP 失败，以及游玩日志。 |
| `screenshot` | 视口 PNG —— 用于 canvas 游戏与视觉检查。 |
| `live_view` | 让用户在浏览器里实时观看真实页面（约每秒一帧）。 |

**文件与状态**

| 工具 | 作用 |
| --- | --- |
| `snapshot` | 会话内状态快照的 `save`／`load`／`list`，用于分支探索。 |
| `upload_file` | 把 mod `.zip`、`.save` 或图片上传到 `<input type=file>`。 |
| `download_file` | `list` 列出持久下载目录，或用 `save`／`newest` 取出捕获的文件。 |
<!-- tools:end -->

每个工具的细节都在它自己的 description 里——调用一次、看看参数就清楚了。默认输出是给人看的
格式化文本；传 `format: "json"` 可拿到能 `JSON.parse` 的结果（`observe`、`choose`、
`click_ui`、`interact`、`navigate`、`snapshot`、`upload_file`、`download_file`、`open_game`）。

## 观看页面

`live_view` 会启动一个极小的本地服务（每个 MCP 进程只启动一次），返回类似
`http://127.0.0.1:4571/v/game_c5ac1a` 的地址。打开它就能看到 **agent 正在操作的那个真实标签页**：
约每秒一帧 JPEG，外加段落名、步数、引擎状态和最近的操作。无头模式同样可用，并且只有有人观看时
才会抓帧。

**给 agent 的约定：每个游戏只开一种视图。** 默认用 `live_view`（用户希望你直接打开时，只传一次
`open: true`）。只有用户明确要一个真实浏览器窗口时，才用 `open_game({ headless: false })`，
并且不要再叠加实时视图。`screenshot` 是一次性的视觉检查，不是视频流。这条策略也随 MCP 的
`instructions` 字段一起下发。

## 格式支持

| 格式 | 识别 | 文本／选项 | `get_variables` | 段落名 | `navigate(back)` | `snapshot` |
| --- | --- | --- | --- | --- | --- | --- |
| **SugarCube 2.21+** | ✅ | ✅ | ✅ `State.variables` | ✅ | ✅ `Engine.backward` | ✅ `Save.base64` / `Save.deserialize` |
| **Harlowe 3** | ✅ | ✅ | —（引擎内部不公开） | — | ✅ 侧边栏撤销 | — |
| **Snowman 2** | ✅ | ✅ | —（改用 `observe(include_variables:true)`） | ✅ | — | ✅ 状态 JSON |
| **Chapbook 1** | ✅ | ✅ | —（改用 `observe(include_variables:true)`） | ✅ `trail` | — | ✅ `restoreFromObject` |
| **未知 HTML** | 通用 | ✅ DOM 启发式 | — | — | — | — |

`observe` 同样能读到 Snowman（`story.state`）与 Chapbook（`engine.state`）的变量，只有
`get_variables` 的点路径查询是 SugarCube 专属。一切都会优雅降级：未知格式仍可走通用 DOM 路径
游玩，格式专属的工具会返回 `unsupported` 而不是直接失败。

## 疑难排查

- **`Could not launch Chrome`** —— 安装 Google Chrome，或用 `TWMCP_CHROME_PATH` 指定路径。
- **`Multiple HTML files in <dir>`** —— 该目录有多个 html，直接传具体的 `.html` 文件。
- **传了文件路径却毫无反应** —— 路径是给 `open_game` 的；命令行不接受参数。
- **实时视图端口被占用** —— 它会从 4571 起自动递增，用返回的 URL 即可。
- **没看到下载的文件** —— 看 `download_file(action:"list")` 打印的目录；不可写时会自动降级。
- **某个工具返回 `unsupported`** —— 该格式没有对应 API（见上表）。

## 安全说明

- 页面脚本运行在 Chrome 沙箱里；页面桥不会把 Node 暴露给页面，也不向 agent 暴露任意 `eval` 工具。
- 默认拦截统计／追踪域名（`TWMCP_BLOCK_TRACKERS=0` 可关闭）。
- 除非传 `allow_external: true`，离开游戏的链接一律拦截。`open_game` 只用 `127.0.0.1` 提供本地游戏，且仅能读取被服务根目录下的文件。

## 开发

```bash
git clone https://github.com/adorablelovelymia/twine-play-mcp.git
cd twine-play-mcp
npm install
npm test            # 构建 + 四格式夹具检查 + 工具面快照/预算
```

`npm test` 不需要任何外部游戏——夹具就在仓库里。更重的检查（`npm run smoke`、
`npm run spike`、`npm run clarity`）会驱动真实游戏，需要
`TWMCP_GAME=/path/to/game.html`；没设置就自动跳过。

架构说明、新增 story format 适配器的步骤、脚本索引与路线图都在
**[CONTRIBUTING.md](CONTRIBUTING.md)**。
