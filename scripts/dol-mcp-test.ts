/**
 * Degrees of Lewdity end-to-end MCP test:
 *   0. open (63 MB SugarCube 2.36 + ModLoader)
 *   1. consent gate
 *   2. import two .mod.zip through the in-game ModLoader GUI (iframe), reload, verify mods loaded
 *   3. import a real .save file through SAVES -> 从文件读取 (#saves-import)
 *   4. play a few turns
 *
 *   npx tsx scripts/dol-mcp-test.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DOL = '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64';
const GAME = path.join(DOL, 'Degrees of Lewdity.html');
const MODS = [path.join(DOL, 'mods/ModI18N.mod.zip'), path.join(DOL, 'mods/GameOriginalImagePack.mod.zip')];
const SAVE = path.join(DOL, 'saves/degrees-of-lewdity-20260912-202024.save');
const SHOTS = '/tmp/opencode';

const client = new Client({ name: 'dol-test', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'dist/index.js')], cwd: ROOT, stderr: 'inherit' });
await client.connect(transport);

const textOf = (r: unknown): string => {
  const content = (r as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? `[${c.type}]`).join('\n');
};
let gameId = '';
let softErrors = 0;
const call = async (name: string, args: Record<string, unknown> = {}, show = 400): Promise<string> => {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  const t = textOf(res);
  const err = (res as { isError?: boolean }).isError ? ' **ERROR**' : '';
  if (err) softErrors++;
  console.log(`\n### ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${err}`);
  console.log(t.slice(0, show) + (t.length > show ? `\n… (${t.length - show} more)` : ''));
  return t;
};
const shot = (n: string) => call('screenshot', { game_id: gameId, path: `${SHOTS}/${n}.png` }, 80);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const passageOf = (t: string) => t.match(/passage: ([^\]]+)\]/)?.[1] ?? '?';

// ---------------------------------------------------------------- 0. open
const open = await call('open_game', { source: GAME, wait_timeout_ms: 30000 }, 250);
gameId = open.match(/Opened game "([^"]+)"/)?.[1] ?? '';
if (!gameId) process.exit(1);
console.log('>>> gameId =', gameId);

// ---------------------------------------------------------------- 1. gate
await call('wait', { game_id: gameId, for_text: 'WELCOME TO DEGREES', timeout_ms: 120000 }, 120);
const gate = await call('observe', { game_id: gameId, since_last: false, max_text_chars: 200, include_variables: false }, 300);
const cb = gate.match(/\n  (i\d+) checkbox/)?.[1];
if (cb) await call('interact', { game_id: gameId, ref: cb, value: 'true' }, 100);
await call('choose', { game_id: gameId, choice: 'Enter' }, 150);
await call('wait', { game_id: gameId, for_text: 'Start Game', timeout_ms: 30000 }, 100);
await shot('dol-30-title');

// ---------------------------------------------------------------- 2. mods via ModLoader GUI (iframe)
await call('click_ui', { game_id: gameId, text: 'ModLoader Manager' }, 150);
await sleep(2000);
const panels = await call('inspect_ui', { game_id: gameId }, 1000);
console.log('>>> panel discovery above; frame panels are marked [iframe]');
for (const mod of MODS) {
  const up = await call('upload_file', { game_id: gameId, path: mod }, 200);
  console.log(`>>> uploaded ${path.basename(mod)}:`, up.slice(0, 80).replace(/\n/g, ' '));
  const add = await call('click_ui', { game_id: gameId, text: 'AddMod' }, 200);
  console.log('>>> AddMod:', add.split('\n')[0]);
  await sleep(4000);
}
await shot('dol-31-mods-added');
const reload = await call('click_ui', { game_id: gameId, text: 'reload page' }, 200);
console.log('>>> reload:', reload.split('\n')[0]);

// wait for reboot after reload
await sleep(8000);
await call('wait', { game_id: gameId, for_text: 'Degrees of Lewdity', timeout_ms: 120000 }, 100);
await sleep(3000);
// possible consent gate again
const gate2 = await call('observe', { game_id: gameId, since_last: false, max_text_chars: 200, include_variables: false }, 250);
const cb2 = gate2.match(/\n  (i\d+) checkbox/)?.[1];
if (cb2) {
  await call('interact', { game_id: gameId, ref: cb2, value: 'true' }, 80);
  await call('choose', { game_id: gameId, choice: 'Enter' }, 120);
  await sleep(2000);
}
await shot('dol-32-after-reload');

// verify loaded mods by inspecting the GUI iframe again
await call('click_ui', { game_id: gameId, text: 'ModLoader Manager' }, 120);
await sleep(1500);
const loaded = await call('inspect_ui', { game_id: gameId }, 1600);
const modLoaded = /ModI18N/.test(loaded) && /GameOriginalImagePack/.test(loaded);
console.log('>>> now-loaded mod list contains both mods:', modLoaded ? 'YES' : 'NO');
await call('click_ui', { game_id: gameId, text: 'close' }, 100).catch(() => '');

// ---------------------------------------------------------------- 3. save import (language-agnostic)
const uiBar = await call('inspect_ui', { game_id: gameId, selector: '#ui-bar' }, 1200);
const saveBtn = [...uiBar.matchAll(/^\s*\d+\.\s+(.+?)\s+\[(x\d+)\]/gm)]
  .map((m) => ({ label: m[1]!.trim(), ref: m[2]! }))
  .find((b) => /saves|存档|读档/i.test(b.label));
console.log('>>> save-dialog button:', saveBtn ? `${saveBtn.label} [${saveBtn.ref}]` : '(not found)');
if (saveBtn) {
  await call('click_ui', { game_id: gameId, ref: saveBtn.ref }, 200);
  await sleep(1500);
}
await shot('dol-33-saves-dialog');

const dlg = await call('inspect_ui', { game_id: gameId, selector: '#ui-dialog' }, 1200);
const dlgButtons = [...dlg.matchAll(/^\s*\d+\.\s+(.+?)\s+\[(x\d+)\]/gm)].map((m) => ({ label: m[1]!.trim(), ref: m[2]! }));
const importBtn = dlgButtons.find((b) => /读取…|load from file|导入|import.*file/i.test(b.label))
  ?? dlgButtons.find((b) => /读取|file|import/i.test(b.label));
console.log('>>> dialog buttons:', dlgButtons.map((b) => b.label).join(' | ') || '(none)');
console.log('>>> import button:', importBtn ? `${importBtn.label} [${importBtn.ref}]` : '(none)');

let imported = { text: '' };
// SugarCube's stable import control first; then the inspected ref.
imported = { text: await call('upload_file', { game_id: gameId, path: SAVE, trigger_selector: '#saves-import' }, 300) };
if (!imported.text.includes('Uploaded') && importBtn) {
  imported = { text: await call('upload_file', { game_id: gameId, path: SAVE, trigger_ref: importBtn.ref }, 300) };
}
if (!imported.text.includes('Uploaded')) {
  imported = { text: await call('upload_file', { game_id: gameId, path: SAVE }, 300) };
}
console.log('>>> save import result:', imported.text.split('\n')[0]);
await sleep(4000);
await shot('dol-34-save-imported');
const afterSave = await call('observe', { game_id: gameId, since_last: false, max_text_chars: 400, include_variables: true }, 900);
console.log('>>> passage after save import:', passageOf(afterSave));

// ---------------------------------------------------------------- 4. play a few turns
// if we are still on the start screen, start a game first
let onStart = /passage: (Start|Start2)\]/.test(afterSave);
if (onStart) {
  const startChoice = afterSave.match(/^\s*\d+\.\s+(开始游戏|Start Game|开始\b.*)\s*$/m);
  console.log('>>> start button match:', startChoice?.[1] ?? '(none)');
  if (startChoice) {
    await call('choose', { game_id: gameId, choice: startChoice[1]!.trim() }, 500);
    await sleep(1500);
  }
}
for (let i = 0; i < 4; i++) {
  const o = await call('observe', { game_id: gameId, since_last: false, max_text_chars: 200, include_variables: false }, 300);
  const first = o.match(/^  1\.\s+(.+)$/m)?.[1] ?? null;
  console.log(`>>> turn ${i + 1}: passage=${passageOf(o)} first=${first}`);
  if (!first) break;
  await call('choose', { game_id: gameId, choice: 1 }, 260);
  await sleep(600);
}
await shot('dol-35-played');
const journal = await call('get_journal', { game_id: gameId, limit: 8 }, 600);
console.log('>>> journal length:', journal.split('\n')[0]);

await call('close_game', { game_id: gameId }, 100);
await client.close();
console.log(`\n===== done. soft errors: ${softErrors}. screenshots in ${SHOTS} =====`);
