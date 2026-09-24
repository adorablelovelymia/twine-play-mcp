/** Dump the real DOM + CSS around the suspicious raw-markup rendering. npx tsx scripts/domdump.ts */
import { SessionManager } from '../src/session.js';

const GAME = process.env.TWMCP_GAME ?? '/home/qiyue/Projects/ts_ero_trap_dungeon-1.0.6/build/TS-Ero-Trap-Dungeon.html';
const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true });
for (let i = 0; i < 3; i++) await manager.choose(session, session.lastObservation!.choices.findIndex((c) => !c.external) + 1);

const script = `(() => {
  const trim = (s, n) => String(s == null ? '' : s).slice(0, n || 1200);
  const h1 = document.querySelector('#passage h1');
  const status = document.querySelector('#story-caption');
  const link = Array.from(document.querySelectorAll('#passage a, #passage tw-link')).pop();
  const pseudo = (el, which) => {
    if (!el) return null;
    try { return getComputedStyle(el, which).content; } catch (e) { return 'ERR ' + e; }
  };
  const rules = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rs = [];
    try { rs = Array.from(sheet.cssRules); } catch (e) { continue; }
    for (const r of rs) {
      const t = r.cssText || '';
      if (/print|resistance|[[\\]]{2}|book|floor|\\$/.test(t)) rules.push(trim(t, 240));
    }
  }
  return {
    passageHtml: trim(document.querySelector('#passage') && document.querySelector('#passage').innerHTML, 2500),
    h1Html: h1 ? h1.outerHTML : null,
    h1Before: pseudo(h1, '::before'),
    h1After: pseudo(h1, '::after'),
    statusHtml: trim(status && status.innerHTML, 1800),
    statusBefore: pseudo(status, '::before'),
    linkHtml: link ? link.outerHTML : null,
    linkBefore: pseudo(link, '::before'),
    matchingRules: rules.slice(0, 25)
  };
})()`;

const info = await session.page.evaluate(script);
console.log(JSON.stringify(info, null, 1));
await manager.closeAll();
