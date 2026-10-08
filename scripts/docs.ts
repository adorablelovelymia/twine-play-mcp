/**
 * Keep the tool tables in README.md / README-zh.md in sync with the code.
 *
 *   npx tsx scripts/docs.ts            # rewrite the generated blocks
 *   npx tsx scripts/docs.ts --check    # exit 1 when a README is out of date
 *
 * The tool list is read from a real MCP client `tools/list` call, so the README can never claim a
 * tool the server does not register. Only the group labels and the one-line summaries live here —
 * they are hand-written prose, so `--check` compares the *generated* text against the file rather
 * than asking the server for it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mcpClient, REPO_ROOT } from './_harness.js';

const BEGIN = '<!-- tools:begin -->';
const END = '<!-- tools:end -->';

interface ToolDoc {
  /** English group label + Chinese group label. */
  group: [string, string];
  /** English one-liner + Chinese one-liner, keyed by tool name. */
  summary: Record<string, [string, string]>;
}

/**
 * Groups are ordered by how a session actually runs: open, look, act, then the side utilities.
 * Every registered tool must appear here — an unmapped tool fails the check on purpose, so a new
 * tool cannot ship without documentation.
 */
const DOC: ToolDoc[] = [
  {
    group: ['Open & read', '开局与阅读'],
    summary: {
      open_game: ['Open a local file/folder or an http(s) URL and get the first observation.', '打开本地文件／文件夹或 http(s) 网址，返回第一次观测。'],
      observe: ['Current passage text, choices, inputs, dialog and status. Pass `for_text` or `wait_ms` to wait first.', '当前段落文本、选项、输入框、对话框与状态栏。传 `for_text` 或 `wait_ms` 可先等待。'],
      session: ['`list` the open games, or `close` one.', '`list` 列出已打开的游戏，`close` 关闭其中一个。']
    }
  },
  {
    group: ['Act', '操作'],
    summary: {
      choose: ['Click a choice by its 1-based number or by label — dialog buttons included.', '按 1-based 编号或标签点击选项，对话框按钮同样适用。'],
      click_ui: ['Click sidebar buttons and menus by ref, CSS selector or visible text.', '按 ref、CSS 选择器或可见文本点击侧边栏按钮与菜单。'],
      interact: ['Fill an input/select/checkbox by ref, or press a key.', '按 ref 填写输入框／下拉框／复选框，或按键。'],
      navigate: ['`back` one passage, `restart` the story, or `goto` a named passage.', '`back` 回退一段、`restart` 重新开始，或 `goto` 直达指定段落。']
    }
  },
  {
    group: ['Inspect', '查看'],
    summary: {
      find_ui: ['Find controls by text or input name; inspect a DOM subtree or discover overlay panels.', '按文本或 input name 查找控件；也可检查某个 DOM 子树或发现浮层面板。'],
      get_variables: ['Read SugarCube `State.variables` by dot path, or a shallow key summary.', '按点路径读取 SugarCube `State.variables`，或只看顶层键摘要。'],
      get_logs: ['Console errors/HTTP failures and the play journal.', '控制台报错／HTTP 失败，以及游玩日志。'],
      screenshot: ['PNG of the viewport — canvas games and visual QA.', '视口 PNG —— 用于 canvas 游戏与视觉检查。'],
      live_view: ['Let the user watch the real page in their browser (~1 fps).', '让用户在浏览器里实时观看真实页面（约每秒一帧）。']
    }
  },
  {
    group: ['Files & state', '文件与状态'],
    summary: {
      snapshot: ['`save` / `load` / `list` in-session state snapshots for branch exploration.', '会话内状态快照的 `save`／`load`／`list`，用于分支探索。'],
      upload_file: ['Upload a mod `.zip`, `.save` or image into an `<input type=file>`.', '把 mod `.zip`、`.save` 或图片上传到 `<input type=file>`。'],
      download_file: ['`list` the persistent download folder, or `save`/`newest` a captured file.', '`list` 列出持久下载目录，或用 `save`／`newest` 取出捕获的文件。']
    }
  }
];

const HEADER = {
  en: ['| Tool | What it does |', '| --- | --- |'],
  zh: ['| 工具 | 作用 |', '| --- | --- |']
} as const;

async function buildTables(): Promise<{ en: string; zh: string }> {
  const client = await mcpClient('docs-gen');
  const { tools } = await client.listTools();
  await client.close();

  const registered = new Set(tools.map((t) => t.name));
  const mapped = new Set<string>();
  const lines = { en: [] as string[], zh: [] as string[] };

  for (const { group, summary } of DOC) {
    const names = Object.keys(summary);
    lines.en.push('', `**${group[0]}**`, '', ...HEADER.en);
    lines.zh.push('', `**${group[1]}**`, '', ...HEADER.zh);
    for (const name of names) {
      if (!registered.has(name)) {
        throw new Error(`scripts/docs.ts documents "${name}", but the server does not register it.`);
      }
      mapped.add(name);
      lines.en.push(`| \`${name}\` | ${summary[name][0]} |`);
      lines.zh.push(`| \`${name}\` | ${summary[name][1]} |`);
    }
  }

  const missing = [...registered].filter((n) => !mapped.has(n)).sort();
  if (missing.length) {
    throw new Error(
      `Undocumented tool(s): ${missing.join(', ')}. Add them to the DOC table in scripts/docs.ts ` +
        `(the tool surface is: ${[...registered].sort().join(', ')}).`
    );
  }

  const wrap = (body: string[]) => `${BEGIN}\n${body.join('\n').trim()}\n${END}`;
  return { en: wrap(lines.en), zh: wrap(lines.zh) };
}

function applyBlock(file: string, block: string): { changed: boolean; current: boolean; missing: boolean } {
  const abs = path.join(REPO_ROOT, file);
  if (!existsSync(abs)) return { changed: false, current: false, missing: true };
  const text = readFileSync(abs, 'utf8');
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`${file} has no ${BEGIN} / ${END} markers — add them where the tool table goes.`);
  }
  const next = text.slice(0, start) + block + text.slice(end + END.length);
  const changed = next !== text;
  if (changed && !process.argv.includes('--check')) writeFileSync(abs, next);
  return { changed, current: !changed, missing: false };
}

const blocks = await buildTables();
let stale = 0;
for (const [file, block, label] of [
  ['README.md', blocks.en, 'English'],
  ['README-zh.md', blocks.zh, '中文']
] as const) {
  const res = applyBlock(file, block);
  if (res.missing || res.changed) {
    stale++;
    console.log(`  x ${file} (${label}): ${res.missing ? 'missing file' : 'tool table out of date'}`);
  } else {
    console.log(`  ✓ ${file} (${label}): tool table up to date`);
  }
}

if (stale) {
  console.log('\nRun `npx tsx scripts/docs.ts` to regenerate the blocks.');
  process.exit(1);
}
