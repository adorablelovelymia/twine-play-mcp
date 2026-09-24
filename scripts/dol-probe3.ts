/** Verify shadow-DOM hypothesis and try the mod import through Playwright locators. npx tsx scripts/dol-probe3.ts */
import fs from 'node:fs';
import { SessionManager } from '../src/session.js';

const DOL = '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64';
const GAME = `${DOL}/Degrees of Lewdity.html`;
const MOD1 = `${DOL}/mods/ModI18N.mod.zip`;

const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 30000 });
const page = session.page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 90; i++) {
  if (await page.evaluate(`!!(window.SugarCube && window.SugarCube.State && window.SugarCube.State.passage)`)) break;
  await sleep(2000);
}
await sleep(3000);

// gate
await page.evaluate(`(() => { const cb = document.querySelector('#ui-dialog input[type=checkbox]'); if (cb && !cb.checked) cb.click(); document.querySelector('#ui-dialog button[class*=link]')?.setAttribute('data-p','enter'); })()`);
if (await page.locator('[data-p="enter"]').count()) await page.locator('[data-p="enter"]').click({ timeout: 3000 });
await sleep(4000);

// open GUI
await page.locator('#startBannerModLoaderGui').click({ timeout: 3000 });
await sleep(2500);

// shadow detection
const shadow = await page.evaluate(`(() => {
  const hosts = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.shadowRoot) hosts.push({
      tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className).slice(0, 40),
      text: (el.shadowRoot.textContent || '').replace(/\\s+/g, ' ').slice(0, 120),
      files: el.shadowRoot.querySelectorAll('input[type=file]').length,
      buttons: el.shadowRoot.querySelectorAll('button').length
    });
  }
  return hosts.slice(0, 10);
})()`);
console.log('=== shadow hosts ===');
console.log(JSON.stringify(shadow, null, 1));

// Playwright locator visibility (pierces shadow DOM)
const counts = {
  fileInputs: await page.locator('input[type=file]').count(),
  addModText: await page.getByText('AddMod', { exact: true }).count(),
  chooseFile: await page.getByText('Choose File', { exact: true }).count(),
  safeMode: await page.getByText('SafeMode', { exact: true }).count()
};
console.log('=== playwright locator counts ===', JSON.stringify(counts));

// try uploading the mod via Playwright (pierces shadow DOM)
if (counts.fileInputs > 0) {
  await page.locator('input[type=file]').first().setInputFiles(MOD1);
  await sleep(1200);
  const png1 = await manager.screenshot(session);
  fs.writeFileSync('/tmp/opencode/dol-10-file-chosen.png', png1);
  console.log('screenshot after setInputFiles: /tmp/opencode/dol-10-file-chosen.png');
}
if (counts.addModText > 0) {
  await page.getByText('AddMod', { exact: true }).first().click({ timeout: 3000 });
  await sleep(5000);
  const png2 = await manager.screenshot(session);
  fs.writeFileSync('/tmp/opencode/dol-11-added.png', png2);
  console.log('screenshot after AddMod: /tmp/opencode/dol-11-added.png');
  // read the result textarea inside the shadow root
  const result = await page.evaluate(`(() => {
    for (const el of document.querySelectorAll('*')) {
      if (!el.shadowRoot) continue;
      const tas = el.shadowRoot.querySelectorAll('textarea');
      const out = Array.from(tas).map(t => ({ v: (t.value || '').slice(0, 120) }));
      if (out.length) return out;
    }
    return null;
  })()`);
  console.log('shadow textareas:', JSON.stringify(result));
}

const consoleIssues = session.console.filter((c) => c.type !== 'warning');
console.log('console issues:', consoleIssues.length, consoleIssues.slice(-3).map((c) => c.text.slice(0, 120)));
await manager.closeAll();
