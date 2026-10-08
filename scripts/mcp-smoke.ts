/**
 * MCP end-to-end smoke test: spawns the built server over stdio and drives it
 * with the MCP client SDK, exactly like a real agent would.
 *
 *   npm run build && TWMCP_GAME=/path/to/game.html npm run smoke
 *
 * The default game lives outside the repo, so without TWMCP_GAME this skips cleanly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import fs from 'node:fs';
import { mcpClient, requireGame, textOf } from './_harness.js';

// Folder input: the tool picks index.html (works for both the "build/…" and the flat release layout).
const GAME = process.env.TWMCP_GAME ?? '';
if (!requireGame(GAME, 'mcp-smoke')) process.exit(0);

let client: Client;
try {
  client = await mcpClient('twine-play-smoke');
} catch (err) {
  console.error('SMOKE CRASHED (could not start the server):', err);
  process.exit(1);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  const tools = await client.listTools();
  console.log(`Tools (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(', ')}`);
  check('tool count sane', tools.tools.length >= 12, `${tools.tools.length}`);

  // --- open + single-session default -------------------------------------
  const open = textOf(await client.callTool({ name: 'open_game', arguments: { source: GAME } }));
  console.log('\n--- open_game ---\n' + open.slice(0, 900));
  const gameId = open.match(/game_id:\s*(game_\w+)/)?.[1];
  check('open_game exposes a game_id line', !!gameId, gameId);
  check('open_game shows choices', /Choices \(\d+\)/.test(open), '');

  // game_id is optional with one game open: this must work with no arguments at all.
  // The first observe can still differ from the open_game snapshot, so check the second one.
  const obsNoId = textOf(await client.callTool({ name: 'observe', arguments: {} }));
  check('observe works without game_id (single session)', /passage:/.test(obsNoId), obsNoId.split('\n')[0] ?? '');
  const obsAgain = textOf(await client.callTool({ name: 'observe', arguments: {} }));
  check('observe since_last works', obsAgain.includes('no change'), obsAgain.split('\n')[1] ?? '');

  // --- choose ------------------------------------------------------------
  const ext = textOf(await client.callTool({ name: 'choose', arguments: { choice: 3 } }));
  check('external links blocked by default', /external-link-blocked/.test(ext), ext.split('\n')[0] ?? '');

  const choose = textOf(await client.callTool({ name: 'choose', arguments: { choice: 1 } }));
  console.log('\n--- choose(1) ---\n' + choose.slice(0, 500));
  check('choose returned new passage', /Clicked:/.test(choose), '');

  const back = textOf(await client.callTool({ name: 'navigate', arguments: { action: 'back' } }));
  check('navigate(back) works', /Went back one step/.test(back) || /unsupported/i.test(back), back.split('\n')[0] ?? '');

  // --- snapshots ---------------------------------------------------------
  const save = textOf(await client.callTool({ name: 'snapshot', arguments: { action: 'save', name: 'smoke' } }));
  check('snapshot(save) works', /Saved snapshot/.test(save), save);
  const snapList = textOf(await client.callTool({ name: 'snapshot', arguments: { action: 'list' } }));
  check('snapshot(list) shows the name', /smoke/.test(snapList), snapList.split('\n').join(' ').slice(0, 120));
  const load = textOf(await client.callTool({ name: 'snapshot', arguments: { action: 'load', name: 'smoke' } }));
  check('snapshot(load) works', /Loaded snapshot/.test(load), '');

  // --- visual / inputs ---------------------------------------------------
  const shot = await client.callTool({ name: 'screenshot', arguments: {} });
  const img = (shot.content as Array<{ type: string; data?: string }>).find((c) => c.type === 'image');
  check('screenshot returns image', !!img?.data && img.data.length > 1000, `${img?.data?.length ?? 0} base64 chars`);

  const findUi = textOf(await client.callTool({ name: 'find_ui', arguments: { text: 'Continue' } }));
  check('find_ui finds labelled controls', /Found [1-9]/.test(findUi), findUi.split('\n')[0] ?? '');

  const vars = textOf(await client.callTool({ name: 'get_variables', arguments: {} }));
  let varsOk = false;
  try {
    varsOk = !!(JSON.parse(vars) as { ok?: boolean }).ok;
  } catch {
    varsOk = false;
  }
  check('get_variables returns JSON', varsOk, vars.slice(0, 120));

  const obsJson = textOf(await client.callTool({ name: 'observe', arguments: { format: 'json', since_last: false } }));
  let jsonId: string | null = null;
  try {
    jsonId = (JSON.parse(obsJson) as { game_id?: string }).game_id ?? null;
  } catch {
    jsonId = null;
  }
  check('observe format:json carries game_id', jsonId === gameId, obsJson.slice(0, 120));

  // --- logs --------------------------------------------------------------
  const logs = textOf(await client.callTool({ name: 'get_logs', arguments: {} }));
  check('get_logs reports console + journal', /Console \(/.test(logs) && /Journal: \d+ action/.test(logs), logs.split('\n')[0] ?? '');

  // --- errors stay compact ----------------------------------------------
  const badChoice = textOf(await client.callTool({ name: 'choose', arguments: { choice: 'no-such-choice-xyz' } }));
  check(
    'errors are concise and list choices',
    /Available choices:/.test(badChoice) && badChoice.length < 900,
    `${badChoice.length} chars`
  );

  // --- sidebar via find_ui + click_ui ------------------------------------
  const sidebar = textOf(await client.callTool({ name: 'find_ui', arguments: { text: 'SAVES' } }));
  const saveRef = sidebar.match(/\[(u\d+)\]/)?.[1];
  check('find_ui sees the sidebar (SAVES)', /Found [1-9]/.test(sidebar) && !!saveRef, sidebar.split('\n')[0] ?? '');
  const opened = saveRef
    ? textOf(await client.callTool({ name: 'click_ui', arguments: { ref: saveRef } }))
    : '';
  check(
    'click_ui(ref) opens the sidebar dialog',
    /Dialog buttons/.test(opened) && /Save to Disk/.test(opened),
    opened.split('\n').find((l) => l.startsWith('Dialog buttons'))?.slice(0, 120) ?? '(no dialog)'
  );

  // --- browser downloads: trigger, list, copy ----------------------------
  const dlPath = '/tmp/twmcp-smoke-save.save';
  const dl = textOf(
    await client.callTool({ name: 'download_file', arguments: { action: 'save', trigger: 'Save to Disk', dest_file: dlPath } })
  );
  let dlBytes = 0;
  try {
    dlBytes = fs.existsSync(dlPath) ? fs.statSync(dlPath).size : 0;
  } catch {
    dlBytes = 0;
  }
  check('download_file(trigger) saves the export', dlBytes > 100 && /Saved ".*" ->/.test(dl), dl.split('\n')[0]?.slice(0, 120) ?? '');

  const listOut = textOf(await client.callTool({ name: 'download_file', arguments: { action: 'list', limit: 5 } }));
  const listedName = listOut.split('\n').find((l) => /\.save\b/.test(l))?.match(/^\s*\d+\.\s+(.+?)\s+—/)?.[1];
  check('download_file(list) shows captured files', /Download folder:/.test(listOut) && !!listedName, listedName ?? listOut.split('\n')[0] ?? '');

  const copyPath = '/tmp/twmcp-smoke-copy.save';
  const copy = listedName
    ? textOf(await client.callTool({ name: 'download_file', arguments: { action: 'save', name: listedName, dest_file: copyPath } }))
    : '';
  let copyBytes = 0;
  try {
    copyBytes = fs.existsSync(copyPath) ? fs.statSync(copyPath).size : 0;
  } catch {
    copyBytes = 0;
  }
  check('download_file copies a captured file by name', copyBytes > 100 && /Saved "/.test(copy), `${copyBytes} B`);
  // A pure copy touches no game element, so it must not pay for the whole passage.
  check('a pure copy skips the passage dump', /game state unchanged/.test(copy) && !/Choices \(/.test(copy), `${copy.length} chars`);

  // --- live view ---------------------------------------------------------
  const lv = textOf(await client.callTool({ name: 'live_view', arguments: { open: false } }));
  const lvUrl = lv.match(/http:\/\/127\.0\.0\.1:\d+\/v\/[A-Za-z0-9_-]+/)?.[0];
  check('live_view returns a viewer URL', !!lvUrl, lv.split('\n')[0]?.slice(0, 100) ?? '');
  const lv2 = textOf(await client.callTool({ name: 'live_view', arguments: {} }));
  check('live_view is idempotent on repeat calls', lv2.includes(lvUrl ?? '###') && lv2.length < lv.length, `${lv.length} -> ${lv2.length} chars`);
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

  // --- session management ------------------------------------------------
  const list = textOf(await client.callTool({ name: 'session', arguments: { action: 'list' } }));
  check('session(list) works', list.includes(gameId!), list.split('\n')[0] ?? '');

  const close = textOf(await client.callTool({ name: 'session', arguments: { action: 'close' } }));
  check('session(close) works', /Closed/.test(close), close);

  if (lvUrl) {
    const after = await fetch(lvUrl)
      .then((r) => r.status)
      .catch(() => 0);
    check('live view reports a closed game (404)', after === 404, `HTTP ${after}`);
  }

  const noGame = textOf(await client.callTool({ name: 'observe', arguments: {} }));
  check('observing with no session explains what to do', /No open games/.test(noGame), noGame.split('\n')[0] ?? '');

  const listAfter = textOf(await client.callTool({ name: 'download_file', arguments: { action: 'list', limit: 10 } }));
  check('download folder persists after close', !!listedName && listAfter.includes(listedName), listAfter.split('\n')[0] ?? '');

  await client.close();
} catch (err) {
  console.error('SMOKE CRASHED:', err);
  failures++;
}

console.log(failures ? `\n===== ${failures} smoke check(s) FAILED =====` : '\n===== all smoke checks passed =====');
process.exit(failures ? 1 : 0);
