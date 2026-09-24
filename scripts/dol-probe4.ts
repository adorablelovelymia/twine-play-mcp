/** Check whether the ModLoader GUI lives in an iframe and drive the mod import inside it. npx tsx scripts/dol-probe4.ts */
import fs from 'node:fs';
import { SessionManager } from '../src/session.js';

const DOL = '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64';
const GAME = `${DOL}/Degrees of Lewdity.html`;
const MODS = [`${DOL}/mods/ModI18N.mod.zip`, `${DOL}/mods/GameOriginalImagePack.mod.zip`];

const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 30000 });
const page = session.page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 90; i++) {
  if (await page.evaluate(`!!(window.SugarCube && window.SugarCube.State && window.SugarCube.State.passage)`)) break;
  await sleep(2000);
}
await sleep(3000);

// gate (verify)
await page.evaluate(`(() => { const cb = document.querySelector('#ui-dialog input[type=checkbox]'); if (cb && !cb.checked) cb.click(); const b = Array.from(document.querySelectorAll('#ui-dialog button')).find(x => (x.innerText||'').trim() === 'Enter'); if (b) b.setAttribute('data-p','enter'); })()`);
if (await page.locator('[data-p="enter"]').count()) await page.locator('[data-p="enter"]').click({ timeout: 3000 });
await sleep(4000);
const gateOpen = await page.evaluate(`(() => { const d = document.querySelector('#ui-dialog'); return !!d && getComputedStyle(d).display !== 'none' && d.getBoundingClientRect().height > 5; })()`);
console.log('gate still open:', gateOpen);

// open GUI
await page.locator('#startBannerModLoaderGui').click({ timeout: 3000 });
await sleep(2500);

// frames
const frames = page.frames();
console.log('frames:', frames.length);
for (const f of frames) {
  let info: Record<string, unknown> = {};
  try {
    info = await f.evaluate(`(() => ({
      url: location.href.slice(0, 80),
      title: document.title,
      files: document.querySelectorAll('input[type=file]').length,
      buttons: document.querySelectorAll('button').length,
      text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 100)
    }))()`);
  } catch (e) {
    info = { err: String(e).slice(0, 80) };
  }
  console.log('  frame:', JSON.stringify(info));
}

// find the GUI frame
const guiFrames = [];
for (const f of frames) {
  try {
    if (await f.locator('input[type=file]').count()) guiFrames.push(f);
  } catch {
    /* ignore */
  }
}
console.log('frames with file input:', guiFrames.length);

if (guiFrames.length) {
  const f = guiFrames[0]!;
  await f.locator('input[type=file]').first().setInputFiles(MODS[0]!);
  await sleep(1000);
  fs.writeFileSync('/tmp/opencode/dol-12-file-chosen.png', await manager.screenshot(session));

  const addBtn = f.getByText('AddMod', { exact: true }).first();
  if (await addBtn.count()) {
    await addBtn.click({ timeout: 3000 });
    await sleep(6000);
  }
  fs.writeFileSync('/tmp/opencode/dol-13-added1.png', await manager.screenshot(session));
  const result = await f.evaluate(`(() => Array.from(document.querySelectorAll('textarea')).map(t => (t.value || '').slice(0, 200)))()`);
  console.log('after AddMod #1, textareas:', JSON.stringify(result));

  // second mod
  await f.locator('input[type=file]').first().setInputFiles(MODS[1]!);
  await sleep(800);
  if (await f.getByText('AddMod', { exact: true }).count()) {
    await f.getByText('AddMod', { exact: true }).first().click({ timeout: 3000 });
    await sleep(6000);
  }
  fs.writeFileSync('/tmp/opencode/dol-14-added2.png', await manager.screenshot(session));
  const result2 = await f.evaluate(`(() => Array.from(document.querySelectorAll('textarea')).map(t => (t.value || '').slice(0, 300)))()`);
  console.log('after AddMod #2, textareas:', JSON.stringify(result2));
}
await manager.closeAll();
