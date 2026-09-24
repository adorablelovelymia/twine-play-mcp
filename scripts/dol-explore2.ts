/** DoL: pass the consent gate and dump the title screen + ModLoader GUI. npx tsx scripts/dol-explore2.ts */
import fs from 'node:fs';
import { SessionManager } from '../src/session.js';

const GAME = process.env.TWMCP_GAME ?? '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64/Degrees of Lewdity.html';
const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 30000 });

// 等 SugarCube 起来
for (let i = 0; i < 90; i++) {
  const ok = await session.page.evaluate(`!!(window.SugarCube && window.SugarCube.State && window.SugarCube.State.passage)`) as boolean;
  if (ok) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 2000));

const clickText = async (text: string) => {
  const loc = session.page.getByText(text, { exact: true }).locator('visible=true').first();
  await loc.click({ timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));
};

// 通过弹窗
try {
  await clickText('Enter');
  console.log('clicked Enter');
} catch (e) {
  console.log('Enter click failed:', String(e).slice(0, 200));
}
await new Promise((r) => setTimeout(r, 4000));

const data = await session.page.evaluate(`(() => {
  const trim = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').slice(0, n || 200);
  const chain = (el) => { const c = []; let p = el; while (p && p !== document.body && c.length < 5) { c.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (p.className ? '.' + String(p.className).split(' ').slice(0,2).join('.') : '')); p = p.parentElement; } return c; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 1 && r.height > 1 && st.display !== 'none' && st.visibility !== 'hidden'; };
  const buttons = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], [onclick]')) {
    if (!visible(el)) continue;
    const t = trim(el.innerText || el.value || el.title || el.getAttribute('aria-label') || '', 70);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    buttons.push({ tag: el.tagName.toLowerCase(), text: t, cls: String(el.className).slice(0, 60), id: el.id || null, chain: chain(el).slice(0, 3) });
  }
  const banner = document.querySelector('#startBannerModLoaderGui');
  const dialog = document.querySelector('#ui-dialog');
  const passage = document.querySelector('#passages .passage:last-of-type');
  return {
    passageName: passage ? passage.getAttribute('data-passage') : null,
    passageText: passage ? trim(passage.innerText, 500) : null,
    passageChoices: passage ? Array.from(passage.querySelectorAll('button, a, .link-internal, [onclick]')).filter(visible).map(e => trim(e.innerText || e.value, 60)).filter(Boolean).slice(0, 15) : null,
    dialogOpen: dialog ? !dialog.classList.contains('hidden') && getComputedStyle(dialog).display !== 'none' : false,
    dialogText: dialog && visible(dialog) ? trim(dialog.innerText, 400) : null,
    banner: banner ? { visible: visible(banner), html: trim(banner.outerHTML, 1200) } : null,
    buttons: buttons.slice(0, 50)
  };
})()`);
console.log(JSON.stringify(data, null, 1).slice(0, 6000));

const png = await manager.screenshot(session);
fs.writeFileSync('/tmp/opencode/dol-title.png', png);
console.log('\nscreenshot: /tmp/opencode/dol-title.png', png.length, 'bytes');
await manager.closeAll();
