# twine-play-mcp

[English](README.md) · **简体中文**

一个让 AI agent **游玩、测试与 QA Twine / 互动小说 HTML 游戏**的 MCP 服务。

Agent 可以读取当前段落、看到编号选项并点击、观察剧情变量、给游戏截图，还能保存/恢复状态来探索分支——
全部通过一套精简、省 token 的工具接口完成，而不是通用的浏览器自动化 API。

```
Agent  ──MCP(stdio)──>  twine-play-mcp  ──Playwright──>  无头 Chrome
                              │                               │
                              │  静态服务器 (127.0.0.1)        │  注入页面桥
                              └────────>  游戏 HTML  <─────────┘
```

## 为什么不用通用浏览器 MCP？

通用浏览器 MCP 会让模型去猜 DOM 选择器、把整页内容灌进上下文，而且完全没有「剧情状态」的概念。
本服务在之上加了一层语义：

- **段落视图**：文本以 Markdown 呈现，附带段落名、游戏格式/版本、剧情元数据
- **编号选项**：标注目标段落名（并默认拦截外链）
- **剧情变量**（SugarCube `State.variables`）：带安全的深度/体积上限
- **原生状态**：SugarCube `Engine.backward/forward`、`Save.base64` 快照
- **格式探测**：优先 SugarCube，其余（Harlowe / Snowman / Chapbook / 未知）走 DOM 兜底
- **追踪器拦截**，以及干净的 console/网络捕获，方便做游戏测试

## 环境要求

- Node.js >= 20（开发环境为 26）
- 已安装 Google Chrome（使用 `channel: 'chrome'`，无需下载 200 MB 的浏览器）
- Linux / macOS / Windows

## 安装

```bash
npm install -g twine-play-mcp   # 或：npx twine-play-mcp
```

无需构建、无需下载浏览器——包内已包含编译好的服务端与页面桥，直接驱动你已有的 Chrome。

然后把它指向任意已发布的 Twine HTML 文件（或包含游戏与资源的文件夹）：

```bash
twine-play-mcp         # 在 stdio 上运行 MCP 服务
```

### 从源码安装（开发用）

```bash
git clone https://github.com/adorablelovelymia/twine-play-mcp.git
cd twine-play-mcp
npm install
npm run build          # 编译到 dist/ 并复制页面桥

# 可选的自检
npm run spike          # 针对真实 SugarCube 游戏的 17 项端到端检查
npm run smoke          # 以 stdio 启动 MCP 服务，并用 MCP SDK 驱动它
```

## 客户端配置

以下片段使用 `npx`，因此无需全局安装。若你已全局安装，把 `"npx"` + `"twine-play-mcp"` 两项
替换为单独一个 `"twine-play-mcp"` 即可。

### OpenCode（`~/.config/opencode/opencode.json`）

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "twine-play": {
      "type": "local",
      "command": ["npx", "-y", "twine-play-mcp"],
      "enabled": true
    }
  }
}
```

### Claude Desktop / Cursor / 任意 `mcpServers` 客户端

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

环境变量：

| 变量 | 用途 |
| --- | --- |
| `TWMCP_CHROME_PATH` | 当 `channel: 'chrome'` 找不到 Chrome 时，手动指定可执行文件 |
| `TWMCP_DOWNLOAD_DIR` | 浏览器下载文件的捕获目录（默认 `~/.cache/twine-play-mcp/downloads`） |
| `TWMCP_VIEW_PORT` / `TWMCP_VIEW_HOST` | 实时视图服务端口（默认 `4571`，被占用时自动递增）与绑定地址（默认 `127.0.0.1`） |

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `open_game` | 打开本地 HTML 文件/文件夹或 URL；可指定 PRNG 随机种子；返回首次观察结果 |
| `observe` | 段落文本、编号选项、输入项（按 40 个一页分页，配合 `inputs_offset`）、对话框、状态栏；`since_last` 可省 token；`format:"json"` 返回结构化输出 |
| `choose` | 按 1 起始的编号或标签点击；对段落选项*和*对话框按钮都有效；`expected` 可做预期校验；默认拦截外链 |
| `wait` | 等待若干毫秒 / 等待指定文本出现 / 等待 DOM 稳定 |
| `interact` | 通过 ref 填写输入框、下拉框、复选框，或按键 |
| `find_ui` | 按可见文本或输入项 name 查找按钮/链接/**label**/输入框；返回 ref 供 `click_ui`/`interact` 使用。是触达单选/复选选项（SugarCube 宏标签）最快的方式 |
| `click_ui` | 点击对话框、侧边栏与菜单（可按 ref / CSS 选择器 / 可见文本），支持基于 `<label>` 的控件与 iframe |
| `upload_file` | 把本地文件上传到 `<input type=file>`（mod `.zip`、`.save` 导入），可通过触发按钮或直接指定输入框，支持 iframe |
| `download_file` | 浏览器文件控制（适用于任意游戏）：把已捕获的下载复制到指定路径——可按 `trigger_text`/`trigger_ref`（点击游戏自己的下载按钮）、按下载目录中的 `name`/`index`，或默认取最新文件。目录中的副本会保留 |
| `list_downloads` | 列出捕获到工具持久下载目录中的文件（跨会话/重启保留），含文件名、大小、时间与绝对路径 |
| `inspect_ui` | 检查或发现段落之外的 UI 面板（mod 界面、后台）；列出按钮/输入框与文件输入框 |
| `get_variables` | 按点路径读取剧情变量（`V.hairlength`），或给出顶层键的浅层摘要；避免倾倒整个变量状态 |
| `back` | 回退一个段落（SugarCube `Engine.backward`） |
| `restart` | 从头重新开始，可选择重新播种 PRNG |
| `save_state` / `load_state` | 会话内命名快照，用于探索分支 |
| `screenshot` | 视口 PNG 截图（canvas/视觉类游戏、视觉 QA）；传 `path` 可存盘 |
| `live_view` | 让用户看到真实页面：本地 URL 流式输出真实 Playwright 标签页的 JPEG 帧（约 1 帧/秒）+ 段落/步数/日志；无头模式同样可用；`open:true` 会用默认浏览器打开 |
| `get_console_errors` | 页面捕获到的 JS 异常、console 错误与 HTTP 失败 |
| `get_journal` | 操作历史：访问过的段落、做过的选择、覆盖率统计 |
| `list_games` / `close_game` | 会话管理 |

### 观看页面（实时视图）

`live_view(game_id)` 会启动一个极小的本地服务（每个 MCP 进程只启动一次，端口 4571 起），返回形如
`http://127.0.0.1:4571/v/game_abc` 的网址。用任意浏览器打开它（或传 `open: true`），即可看到
**agent 正在操作的那个真实标签页**——约每秒一帧 JPEG，外加段落、步数、引擎状态、最近操作与段落文本。
它对无头游戏同样有效；只有有人观看时才抓帧；关闭游戏即停止。若想要一个原生的浏览器窗口，请改用
`headless: false` 打开游戏（`open_game`）。

实用组合：如果你的客户端能在侧边栏显示网页（例如 OpenCode 的 Review 面板 /
`browser.tabs.open`），把实时视图的网址指过去，就能一边看 agent 游玩一边跟进。

**只选一种显示方式（给 agent 的规则）。** 为了保持用户屏幕整洁，展示正在运行的游戏时只用一个渠道，
绝不叠加：

1. **默认：** `live_view`——把网址交给用户，或传一次 `open: true` 替他打开。重复调用会复用同一个视图，
   不会新开标签页。
2. **仅在明确要求时：** 用户要真实浏览器窗口时才用 `open_game(headless: false)`。不要再叠加实时视图——
   有头窗口本身已经可见了。
3. `screenshot` 是一次性的视觉检查，**不是流**——不要循环调用来「展示」游戏。

如果某个视图（实时视图标签页或有头窗口）已经打开，请复用它而不是再开一个。MCP 服务把这条策略也写进了
自己的 `instructions` 字段，因此 MCP 客户端可以自动把它传给模型；相关工具的说明里也重复了这一点
（`live_view`、`open_game.headless`、`screenshot`）。

### Agent 使用体验

- **输出**：每个游玩类工具都返回格式化后的文本观察结果（字符串）。传 `format:"json"` 则改为返回一个
  JSON 字符串（用 `JSON.parse` 解析），包含 `passage`、`text`、`choices[{n,label,target}]`、
  `inputs[{ref,kind,label,checked}]`、`inputsTotal`、`dialog`、`status`。
- **输入项是分页而非截断**：出现形如 `Inputs (41-80 of 140)` 的表头时，配合 `inputs_offset=80`
  就能触达全部内容——不存在静默的硬上限。
- **标签匹配**：`click_ui(text)` 与 `find_ui(text)` 能理解 SugarCube `<<radiobutton>>` /
  `<<checkbox>>` 的标签，所以「Jet black」这类选项或「Punch」这类战斗指令都能按文本点击。
- **错误信息精简**：失败时返回 `ERROR: code — message`、一条 `Hint`、当前段落与可用选项——
  绝不倾倒完整的观察结果。
- **变量**：观察结果默认不内嵌变量数据块；用 `get_variables` 只取你关心的键。
  需要（截断后的）全量数据时仍可用 `include_variables:true`。
- **对话框**：对话框按钮会以编号选项的形式出现并标记 `[dialog]`，同时有一行 `Dialog buttons:`
  列出它们；复选框标签会显示在输入项那一行。


## 格式支持

| 格式 | 探测 | 文本/选项 | 变量 | 段落名 | 回退 | 快照 |
| --- | --- | --- | --- | --- | --- | --- |
| **SugarCube 2.21+** | ✅ | ✅ | ✅ `State.variables` | ✅ | ✅ `Engine.backward` | ✅ `Save.base64`（2.37+）/ `Save.deserialize`（更早版本） |
| **Harlowe 3** | ✅ | ✅ | —（引擎内部实现为私有） | — | ✅ 侧边栏撤销 | — |
| **Snowman 2** | ✅ | ✅ | ✅ `story.state` | ✅ | — | ✅ state JSON |
| **Chapbook 1** | ✅ | ✅ | ✅ `engine.state.saveToObject()` | ✅ `trail` | — | ✅ `restoreFromObject` |
| **未知 HTML** | 通用 | ✅ DOM 启发式 | — | — | — | — |

一切都优雅降级：未知或冷门格式仍可通过通用 DOM 路径游玩；格式专属工具会返回 `unsupported`
而不是直接失败。

## 游玩会话示例（agent 看到的内容）

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

## 实现原理

- `src/bridge/bridge.js` 通过 `addInitScript` 注入每个页面，暴露 `window.__twineMCP`：
  格式探测、段落/选项提取、点击/填写辅助、等待稳定、快照与随机种子。所有服务端调用都只经由这个桥。
- `src/session.ts` 持有浏览器，每个游戏一个 `BrowserContext`（存档互相隔离），并内置一个极小的
  静态服务器，让本地游戏运行在 `http://127.0.0.1` 上（这样 localStorage 才能工作）。
- `src/render.ts` 把观察结果转成给模型看的精简 Markdown。
- 选项会被临时打上 `data-twmcp-ref` 属性；服务端优先使用真实的 Playwright 点击，对冷门宏生成的
  链接则回退到 DOM 点击。
- 剧透策略：只返回玩家能看到的内容。不暴露段落列表或源码。

## 复杂游戏

真实游戏不只是段落和链接。本 MCP 处理了那些棘手的部分：

- **模态对话框**（SugarCube `#ui-dialog`、内容门禁、设置）：其文本会以 `Dialog:` 块出现，
  按钮/输入项像选项一样编号，因此 agent 可以勾选同意条款（`interact`）再点 `Enter`（`choose`）。
- **iframe**：mod 管理器与开发者面板常常位于子框架中。`inspect_ui` 会发现它们（标记 `[iframe]`），
  `click_ui` 按文本、`upload_file` 都会搜索每个框架。
- **文件工作流**：上传走 `upload_file`（mod `.zip`、存档导入）——可点击触发元素
  （`trigger_text` / `trigger_selector`，例如 `#saves-import`）或直接指向 `<input type=file>`。
  下载则反向经过一个持久下载目录：浏览器每次下载都会被捕获到那里（`TWMCP_DOWNLOAD_DIR`
  可覆盖位置），`list_downloads` 显示目录内容，`download_file` 可把它复制到任意位置（`path`，
  默认 `<cwd>/downloads/<name>`）——既可点击游戏自己的导出按钮，也可事后再按 `name`/`index` 取。
  无需手动复制临时目录，且文件在 `close_game` 与 MCP 重启后依然保留。
- **DoL 案例研究**：除 `test/fixtures` 外，`scripts/dol-mcp-test.ts` 端到端驱动
  Degrees of Lewdity——同意门禁 → 通过游戏内 ModLoader 界面导入 `ModI18N.mod.zip` 与
  `GameOriginalImagePack.mod.zip` → 页面重载 → 通过 SAVES 对话框导入真实 `.save` →
  正常游玩若干回合。

## 测试

```bash
npm run spike      # 针对真实 SugarCube 2.37 游戏的 17 项检查（游玩、回退、快照、截图）
npm run formats    # 4 个已编译夹具：SugarCube 2.30、Harlowe 3.1、Snowman 2.0、Chapbook 1.0
npm run smoke      # 启动构建后的 MCP 服务并通过 stdio 驱动各工具
npm run clarity    # 针对 DoL 角色创建的 agent 体验回归（分页、标签、变量）
npm run fixtures   # 用 Tweego 重新构建 test/fixtures/compiled/*.html（见 test/fixtures/build.sh）
npx tsx scripts/dol-mcp-test.ts   # Degrees of Lewdity：门禁、mod 导入、存档导入、游玩
```

`scripts/inspect.ts <fixture>` 会输出某个游戏的 DOM/剧情格式内部结构——新增适配器时很好用。

## 状态 / 路线图

- [x] M1：SugarCube 适配器、通用 DOM 兜底、观察/选项/输入/等待/截图、快照、回退、
      console+网络 QA 捕获、stdio MCP、spike + smoke 测试
- [x] M2：Harlowe / Chapbook / Snowman 适配器，已针对编译夹具验证
- [x] M2：游玩日志（`get_journal`），用于运行摘要、续玩与 QA 覆盖率
- [x] M3：对话框/iframe 感知的 UI 控制（`click_ui`、`inspect_ui`、`upload_file`）——
      已在 Degrees of Lewdity 上验证（mod 导入 + 存档导入 + 游玩）
- [x] M4：agent 使用体验——输入分页 + 总数、`find_ui` 标签搜索、`get_variables`、
      `format:"json"`、精简错误（源自一次「天真 agent」试玩，它在 DoL 角色创建处卡住）
- [x] M4：双向文件工作流——`upload_file` 处理 mod/存档，`download_file` + `list_downloads`
      提供持久下载目录（无需复制临时目录）
- [x] M5：实时视图——在任意浏览器中观看真实页面（约 1 fps 帧 + 段落/步数/日志）；
      有头模式通过 `open_game(headless: false)`
- [x] M5：npm 打包——已发布为 [`twine-play-mcp`](https://www.npmjs.com/package/twine-play-mcp)
- [ ] M3：面向 canvas 游戏的 `click_at`、受剧透限制的剧情地图分析

## 安全说明

- 页面脚本运行在 Chrome 沙箱中；页面桥从不向页面暴露 Node。
- 不向 agent 暴露任意 `eval` 工具。
- 默认拦截分析/追踪类主机（可用 `block_trackers: false` 关闭）。
- 除非传入 `allow_external: true`，否则外链一律拦截。
