/**
 * MCP end-to-end smoke test: spawns the built server over stdio and drives it
 * with the MCP client SDK, exactly like a real agent would.
 *
 *   npm run build && npm run smoke
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';

const GAME = process.env.TWMCP_GAME ?? '/home/qiyue/Projects/ts_ero_trap_dungeon-1.0.6/build/TS-Ero-Trap-Dungeon.html';
const HERE = new URL('..', import.meta.url).pathname;

const client = new Client({ name: 'twine-play-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [HERE + 'dist/index.js'],
  cwd: HERE,
  stderr: 'inherit'
});

const textOf = (res: unknown): string => {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? `[${c.type}]`).join('\n');
};

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`Tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(', ')}`);
  check('tool count sane', tools.tools.length >= 10, `${tools.tools.length}`);

  const open = textOf(await client.callTool({ name: 'open_game', arguments: { source: GAME } }));
  console.log('\n--- open_game ---\n' + open.slice(0, 900));
  const gameId = open.match(/Opened game "([^"]+)"/)?.[1];
  check('open_game returned id', !!gameId, gameId);
  check('open_game shows choices', /Choices \(\d+\)/.test(open), '');

  const obs = textOf(await client.callTool({ name: 'observe', arguments: { game_id: gameId, since_last: true } }));
  check('observe since_last works', obs.includes('no change'), obs.split('\n')[0] ?? '');

  const ext = textOf(await client.callTool({ name: 'choose', arguments: { game_id: gameId, choice: 3 } }));
  check('external links blocked by default', /external-link-blocked/.test(ext), ext.split('\n')[0] ?? '');

  const choose = textOf(await client.callTool({ name: 'choose', arguments: { game_id: gameId, choice: 1 } }));
  console.log('\n--- choose(1) ---\n' + choose.slice(0, 500));
  check('choose returned new passage', /Clicked:/.test(choose), '');

  const save = textOf(await client.callTool({ name: 'save_state', arguments: { game_id: gameId, name: 'smoke' } }));
  check('save_state works', /Saved snapshot/.test(save), save);
  const load = textOf(await client.callTool({ name: 'load_state', arguments: { game_id: gameId, name: 'smoke' } }));
  check('load_state works', /Loaded snapshot/.test(load), '');

  const shot = await client.callTool({ name: 'screenshot', arguments: { game_id: gameId } });
  const img = (shot.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image');
  check('screenshot returns image', !!img?.data && img.data.length > 1000, `${img?.data?.length ?? 0} base64 chars`);

  const errs = textOf(await client.callTool({ name: 'get_console_errors', arguments: { game_id: gameId } }));
  check('console clean', /No console errors/.test(errs), errs.slice(0, 120));

  const journal = textOf(await client.callTool({ name: 'get_journal', arguments: { game_id: gameId } }));
  check('journal records play', /Journal: \d+ action/.test(journal) && /▷继续/.test(journal), journal.split('\n')[0] ?? '');

  const findUi = textOf(await client.callTool({ name: 'find_ui', arguments: { game_id: gameId, text: '继续' } }));
  check('find_ui finds labelled controls', /Found [1-9]/.test(findUi), findUi.split('\n')[0] ?? '');

  const vars = textOf(await client.callTool({ name: 'get_variables', arguments: { game_id: gameId } }));
  let varsOk = false;
  try {
    varsOk = !!(JSON.parse(vars) as { ok?: boolean }).ok;
  } catch {
    varsOk = false;
  }
  check('get_variables returns JSON', varsOk, vars.slice(0, 120));

  const obsJson = textOf(await client.callTool({ name: 'observe', arguments: { game_id: gameId, format: 'json', since_last: false } }));
  let jsonPassage: string | null = null;
  try {
    jsonPassage = (JSON.parse(obsJson) as { passage?: string }).passage ?? null;
  } catch {
    jsonPassage = null;
  }
  check('observe format:json parses', !!jsonPassage, obsJson.slice(0, 120));

  const badChoice = textOf(await client.callTool({ name: 'choose', arguments: { game_id: gameId, choice: 'no-such-choice-xyz' } }));
  check(
    'errors are concise and list choices',
    /Available choices:/.test(badChoice) && badChoice.length < 900,
    `${badChoice.length} chars`
  );

  // SugarCube sidebar: find_ui sees it, click_ui(ref) operates it, dialog is numbered.
  const sidebar = textOf(await client.callTool({ name: 'find_ui', arguments: { game_id: gameId, text: 'SAVES' } }));
  const saveRef = sidebar.match(/\[(u\d+)\]/)?.[1];
  check('find_ui sees the sidebar (SAVES)', /Found [1-9]/.test(sidebar) && !!saveRef, sidebar.split('\n')[0] ?? '');
  const opened = saveRef
    ? textOf(await client.callTool({ name: 'click_ui', arguments: { game_id: gameId, ref: saveRef } }))
    : '';
  check(
    'click_ui(ref) opens the sidebar dialog',
    /Dialog buttons/.test(opened) && /Save Slot 1/.test(opened),
    opened.split('\n').find((l) => l.startsWith('Dialog buttons'))?.slice(0, 120) ?? '(no dialog)'
  );

  // Browser file control (generic): trigger a download, list the tool's download folder,
  // then copy the captured file by name — no manual temp-folder handling.
  const dlPath = '/tmp/opencode/twmcp-smoke-save.save';
  const dl = textOf(
    await client.callTool({ name: 'download_file', arguments: { game_id: gameId, trigger_text: 'Save', path: dlPath } })
  );
  let dlBytes = 0;
  try {
    dlBytes = fs.existsSync(dlPath) ? fs.statSync(dlPath).size : 0;
  } catch {
    dlBytes = 0;
  }
  check('download_file saves the export directly', dlBytes > 100 && /Saved ".*" ->/.test(dl), dl.split('\n')[0]?.slice(0, 120) ?? '');

  const listOut = textOf(await client.callTool({ name: 'list_downloads', arguments: { limit: 5 } }));
  const listedName = listOut.split('\n').find((l) => /\.save\b/.test(l))?.match(/^\s*\d+\.\s+(.+?)\s+—/)?.[1];
  check('list_downloads shows captured files', /Download folder:/.test(listOut) && !!listedName, listedName ?? listOut.split('\n')[0] ?? '');

  const copyPath = '/tmp/opencode/twmcp-smoke-copy.save';
  const copy = listedName
    ? textOf(await client.callTool({ name: 'download_file', arguments: { game_id: gameId, name: listedName, path: copyPath } }))
    : '';
  let copyBytes = 0;
  try {
    copyBytes = fs.existsSync(copyPath) ? fs.statSync(copyPath).size : 0;
  } catch {
    copyBytes = 0;
  }
  check('download_file copies a captured file by name', copyBytes > 100 && /Saved "/.test(copy), `${copyBytes} B`);

  // Live view: the user can watch the actual page the agent is driving.
  const lv = textOf(await client.callTool({ name: 'live_view', arguments: { game_id: gameId, open: false } }));
  const lvUrl = lv.match(/http:\/\/127\.0\.0\.1:\d+\/v\/[A-Za-z0-9_-]+/)?.[0];
  check('live_view returns a viewer URL', !!lvUrl, lv.split('\n')[0]?.slice(0, 100) ?? '');
  let viewHtmlOk = false;
  let frameBytes = 0;
  if (lvUrl) {
    const htmlRes = await fetch(lvUrl);
    const html = await htmlRes.text();
    viewHtmlOk = htmlRes.ok && html.includes(gameId!) && html.includes('/f/');
    const frameRes = await fetch(lvUrl.replace('/v/', '/f/') + '.jpg');
    frameBytes = Buffer.from(await frameRes.arrayBuffer()).length;
  }
  check('live view serves the viewer page and a JPEG frame', viewHtmlOk && frameBytes > 5000, `html ${viewHtmlOk ? 'ok' : 'bad'}, ${frameBytes} B jpeg`);

  const list = textOf(await client.callTool({ name: 'list_games', arguments: {} }));
  check('list_games works', list.includes(gameId!), list.split('\n')[0] ?? '');

  const close = textOf(await client.callTool({ name: 'close_game', arguments: { game_id: gameId } }));
  check('close_game works', /Closed/.test(close), close);

  if (lvUrl) {
    const after = await fetch(lvUrl)
      .then((r) => r.status)
      .catch(() => 0);
    check('live view reports a closed game (404)', after === 404, `HTTP ${after}`);
  }

  const listAfter = textOf(await client.callTool({ name: 'list_downloads', arguments: { limit: 10 } }));
  check('download folder persists after close_game', !!listedName && listAfter.includes(listedName), listAfter.split('\n')[0] ?? '');

  await client.close();
} catch (err) {
  console.error('SMOKE CRASHED:', err);
  failures++;
}

console.log(failures ? `\n===== ${failures} smoke check(s) FAILED =====` : '\n===== all smoke checks passed =====');
process.exit(failures ? 1 : 0);
