/** Wait for a heavy DoL-style game to finish booting, logging network + console. npx tsx scripts/dol-boot.ts [game.html] */
import fs from 'node:fs';
import { SessionManager } from '../src/session.js';

const GAME = process.argv[2] ?? '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64/Degrees of Lewdity.html';
const MAX_WAIT = Number(process.env.WAIT ?? 240);

const manager = new SessionManager();
const t0 = Date.now();
const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 30000 });
console.log(`domcontentloaded + settle in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

let logs = 0;
session.page.on('console', (msg) => {
  if (logs++ > 120) return;
  const t = msg.text().slice(0, 220);
  if (/error|fail|mod|loader|boot/i.test(t) || msg.type() === 'error') console.log(`  [console:${msg.type()}] ${t}`);
});
session.page.on('response', (res) => {
  const u = res.url();
  if (/mods|modList/i.test(u)) console.log(`  [http] ${res.status()} ${u.slice(-120)}`);
});
session.page.on('requestfailed', (req) => {
  const u = req.url();
  if (/mods|modList/i.test(u)) console.log(`  [http-failed] ${req.failure()?.errorText} ${u.slice(-120)}`);
});

const ready = async () => {
  try {
    return await session.page.evaluate(`(() => {
      const sq = window.SugarCube;
      const passage = document.querySelector('#passage');
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200);
      return {
        hasPassage: !!passage,
        passageText: passage ? passage.innerText.replace(/\\s+/g, ' ').slice(0, 120) : null,
        sqVersion: sq && sq.version ? String(sq.version) : null,
        state: sq && sq.State ? sq.State.passage : null,
        bodyHead: text,
        spinner: !!document.querySelector('#spinner, .spinner, [class*=loading]')
      };
    })()`) as Record<string, unknown>;
  } catch (e) {
    return { error: String(e) };
  }
};

let last = '';
const deadline = Date.now() + MAX_WAIT * 1000;
while (Date.now() < deadline) {
  const r = await ready();
  const line = JSON.stringify(r);
  if (line !== last) {
    last = line;
    console.log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s ${line.slice(0, 260)}`);
  }
  if (r.sqVersion && r.hasPassage) break;
  await new Promise((r2) => setTimeout(r2, 3000));
}

const final = await ready();
console.log(`\nfinal after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(final, null, 1).slice(0, 800));

const png = await manager.screenshot(session);
fs.writeFileSync('/tmp/opencode/dol-boot.png', png);
console.log('screenshot: /tmp/opencode/dol-boot.png', png.length, 'bytes');

const errs = session.console.filter((c) => c.type !== 'warning');
console.log('\nconsole issues:', errs.length);
for (const e of errs.slice(0, 10)) console.log(`  [${e.type}] ${e.text.slice(0, 200)}`);

await manager.closeAll();
