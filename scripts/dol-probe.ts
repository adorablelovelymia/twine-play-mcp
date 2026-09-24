/** Probe DoL's ModLoader GUI container + save dialog buttons. npx tsx scripts/dol-probe.ts */
import { SessionManager } from '../src/session.js';

const GAME = '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64/Degrees of Lewdity.html';
const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 30000 });

for (let i = 0; i < 90; i++) {
  if (await session.page.evaluate(`!!(window.SugarCube && window.SugarCube.State && window.SugarCube.State.passage)`)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 3000));

// consent gate: checkbox via JS, Enter via a real click
await session.page.evaluate(`(() => {
  const cb = document.querySelector('#ui-dialog input[type=checkbox]');
  if (cb && !cb.checked) cb.click();
  const btn = Array.from(document.querySelectorAll('#ui-dialog button')).find(b => (b.innerText||'').trim() === 'Enter');
  if (btn) btn.setAttribute('data-probe', 'enter');
})()`);
if (await session.page.locator('[data-probe="enter"]').count()) {
  await session.page.locator('[data-probe="enter"]').click({ timeout: 3000 });
}
await new Promise((r) => setTimeout(r, 4000));
const gateOpen = await session.page.evaluate(`(() => { const d = document.querySelector('#ui-dialog'); return !!d && getComputedStyle(d).display !== 'none' && d.getBoundingClientRect().height > 1; })()`);
console.log('gate still open:', gateOpen);

// open ModLoader GUI with a real click
const bannerHtml = await session.page.evaluate(`document.querySelector('#startBannerModLoaderGui').outerHTML`);
console.log('banner html:', bannerHtml);
const probeState = async (tag: string) => {
  const s = await session.page.evaluate(`(() => {
    const gui = document.querySelector('#ModLoaderGui, .ModLoaderGui, [id*=ModLoader]:not(#startBannerModLoaderGui)');
    const files = document.querySelectorAll('input[type=file]').length;
    const safe = /SafeMode/.test(document.body.innerText || '');
    return { gui: !!gui, files, safe, modGuiText: gui ? (gui.innerText || '').slice(0, 80) : null };
  })()`);
  console.log(`  [${tag}]`, JSON.stringify(s));
  return s;
};
await probeState('before-click');
await session.page.evaluate(`document.querySelector('#startBannerModLoaderGui').setAttribute('data-probe','banner')`);
await session.page.locator('[data-probe="banner"]').click({ timeout: 3000, force: true });
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 700));
  await probeState(`after-click-${i}`);
}
await new Promise((r) => setTimeout(r, 2500));

const modGui = await session.page.evaluate(`(() => {
  const trim = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').slice(0, n || 200);
  const info = [];
  for (const el of document.querySelectorAll('[id*=odLoader i], [class*=odLoader i]')) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    info.push({ tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className).slice(0,60), pos: st.position, size: [Math.round(r.width), Math.round(r.height)], display: st.display, btn: el.querySelectorAll('button').length, file: el.querySelectorAll('input[type=file]').length, text: trim(el.innerText, 60) });
  }
  const files = Array.from(document.querySelectorAll('input[type=file]')).map((f) => {
    const r = f.getBoundingClientRect();
    const st = getComputedStyle(f);
    const chain = []; let p = f; while (p && p !== document.body && chain.length < 5) { chain.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (p.className ? '.' + String(p.className).split(' ')[0] : '')); p = p.parentElement; }
    return { chain, display: st.display, size: [Math.round(r.width), Math.round(r.height)], accept: f.getAttribute('accept') };
  });
  return { info: info.slice(0, 12), files, modGuiExists: !!document.querySelector('#ModLoaderGui, .ModLoaderGui') };
})()`);
console.log('=== ModLoader-ish elements ===');
console.log(JSON.stringify(modGui, null, 1));

// close the GUI (close button inside it)
await session.page.keyboard.press('Escape').catch(() => undefined);
await new Promise((r) => setTimeout(r, 800));

// open SAVES with a real click
await session.page.evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll('#ui-bar button, #startCaption button, #story-caption button'));
  const b = btns.find(x => (x.innerText||'').trim().toLowerCase().includes('saves')) || btns.find(x => /save|读|存/i.test(x.innerText||''));
  if (b) b.setAttribute('data-probe', 'saves');
})()`);
if (await session.page.locator('[data-probe="saves"]').count()) {
  await session.page.locator('[data-probe="saves"]').click({ timeout: 3000 });
}
await new Promise((r) => setTimeout(r, 2500));

const saveDlg = await session.page.evaluate(`(() => {
  const trim = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').slice(0, n || 200);
  const dlg = document.querySelector('#ui-dialog');
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 1 && r.height > 1 && st.display !== 'none' && st.visibility !== 'hidden'; };
  const buttons = Array.from(dlg.querySelectorAll('button, a, .link-internal')).filter(visible).map((b) => ({ text: trim(b.innerText || b.value, 40), cls: String(b.className).slice(0, 50), id: b.id || null }));
  const tabs = Array.from(dlg.querySelectorAll('*')).filter((e) => visible(e) && /export|import|导出|导入/i.test(e.innerText || '') && e.children.length === 0).map((e) => ({ tag: e.tagName.toLowerCase(), text: trim(e.innerText, 40), cls: String(e.className).slice(0,50) }));
  return { open: !!dlg && visible(dlg), text: trim(dlg.innerText, 400), buttons: buttons.slice(0, 40), tabs, files: dlg.querySelectorAll('input[type=file]').length };
})()`);
console.log('\n=== SAVES dialog ===');
console.log(JSON.stringify(saveDlg, null, 1));

await manager.closeAll();
