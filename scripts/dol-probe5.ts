/** Explore DoL's SAVES → Export/Import dialog and try importing a .save file. npx tsx scripts/dol-probe5.ts */
import fs from 'node:fs';
import { SessionManager } from '../src/session.js';

const DOL = '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64';
const GAME = `${DOL}/Degrees of Lewdity.html`;
const SAVE = `${DOL}/saves/degrees-of-lewdity-20260912-202024.save`;

const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 30000 });
const page = session.page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 90; i++) {
  if (await page.evaluate(`!!(window.SugarCube && window.SugarCube.State && window.SugarCube.State.passage)`)) break;
  await sleep(2000);
}
await sleep(3000);

await page.evaluate(`(() => { const cb = document.querySelector('#ui-dialog input[type=checkbox]'); if (cb && !cb.checked) cb.click(); const b = Array.from(document.querySelectorAll('#ui-dialog button')).find(x => (x.innerText||'').trim() === 'Enter'); if (b) b.setAttribute('data-p','enter'); })()`);
if (await page.locator('[data-p="enter"]').count()) await page.locator('[data-p="enter"]').click({ timeout: 3000 });
await sleep(4000);

// open SAVES
await page.evaluate(`(() => {
  const b = Array.from(document.querySelectorAll('#ui-bar button, #startCaption button, #story-caption button')).find(x => /saves/i.test(x.innerText||''));
  if (b) b.setAttribute('data-p','saves');
})()`);
if (await page.locator('[data-p="saves"]').count()) await page.locator('[data-p="saves"]').click({ timeout: 3000 });
await sleep(2000);

const dumpDialog = async (tag: string) => {
  const d = await page.evaluate(`(() => {
    const trim = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').slice(0, n || 200);
    const dlg = document.querySelector('#ui-dialog');
    const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 1 && r.height > 1 && st.display !== 'none' && st.visibility !== 'hidden'; };
    const buttons = Array.from(dlg.querySelectorAll('button, a, .link-internal')).filter(visible).map((b) => ({ text: trim(b.innerText || b.value, 40), cls: String(b.className).slice(0, 40) }));
    return { text: trim(dlg.innerText, 500), buttons: buttons.slice(0, 40), files: dlg.querySelectorAll('input[type=file]').length };
  })()`);
  console.log(`\n=== dialog [${tag}] ===`);
  console.log(JSON.stringify(d, null, 1));
  return d;
};
await dumpDialog('saves');
fs.writeFileSync('/tmp/opencode/dol-20-saves.png', await manager.screenshot(session));

// click the Export/Import tab
const tab = page.locator('#ui-dialog').getByText('Export/Import', { exact: false }).first();
if (await tab.count()) {
  await tab.click({ timeout: 3000 });
  await sleep(1500);
  console.log('>>> clicked Export/Import tab');
}
await dumpDialog('export-import');
fs.writeFileSync('/tmp/opencode/dol-21-exportimport.png', await manager.screenshot(session));

// look for a load-from-file button
const cand = await page.evaluate(`(() => {
  const trim = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const dlg = document.querySelector('#ui-dialog');
  const out = [];
  for (const el of dlg.querySelectorAll('button, a, .link-internal, input[type=button]')) {
    const t = trim(el.innerText || el.value || '');
    if (/file|import|load|导入|读取|文件/i.test(t)) out.push(t);
  }
  return out;
})()`);
console.log('>>> load-from-file candidates:', JSON.stringify(cand));

// try the file chooser path
const chooserPromise = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
if (cand.length) {
  const btn = page.locator('#ui-dialog').getByText(/file|import|load|导入|读取|文件/i).first();
  await btn.click({ timeout: 3000 }).catch((e) => console.log('click err', String(e).slice(0, 120)));
}
const chooser = await chooserPromise;
if (chooser) {
  console.log('>>> file chooser opened; setting save file');
  await chooser.setFiles(SAVE);
} else {
  const fi = page.locator('#ui-dialog input[type=file]');
  const n = await fi.count();
  console.log('>>> no chooser; file inputs in dialog:', n);
  if (n) await fi.first().setInputFiles(SAVE);
}
await sleep(5000);
fs.writeFileSync('/tmp/opencode/dol-22-after-import.png', await manager.screenshot(session));

const obs = await manager.observe(session, { includeVariables: true, maxTextChars: 400 });
console.log('\n=== passage after import ===', obs.passage, '| variables:', JSON.stringify(obs.variables).slice(0, 200));
console.log('text head:', obs.text.slice(0, 200).replace(/\n/g, ' '));

await manager.closeAll();
