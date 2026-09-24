/** DoL DOM structure dump. npx tsx scripts/dol-dom.ts */
import { SessionManager } from '../src/session.js';

const GAME = process.env.TWMCP_GAME ?? '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64/Degrees of Lewdity.html';
const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 30000 });

// 等 SugarCube 起来
for (let i = 0; i < 60; i++) {
  const ok = await session.page.evaluate(`!!(window.SugarCube && window.SugarCube.State)`) as boolean;
  if (ok) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 3000));

const data = await session.page.evaluate(`(() => {
  const trim = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').slice(0, n || 200);
  const chain = (el) => { const c = []; let p = el; while (p && p !== document.body && c.length < 6) { c.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (p.className ? '.' + String(p.className).split(' ').join('.') : '')); p = p.parentElement; } return c; };
  const findText = (needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.includes(needle)) {
        return { text: trim(n.nodeValue), chain: chain(n.parentElement), parentHtml: trim(n.parentElement?.outerHTML, 300) };
      }
    }
    return null;
  };
  const clickables = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('a, button, [role=button], input[type=button], tw-link')) {
    const t = trim(el.innerText || el.value || '', 60);
    if (!t || seen.has(t)) continue;
    const r = el.getBoundingClientRect();
    seen.add(t);
    clickables.push({ tag: el.tagName.toLowerCase(), text: t, cls: String(el.className).slice(0, 50), visible: r.width > 0 && r.height > 0, href: el.getAttribute('href') || null, chain: chain(el).slice(0, 3) });
  }
  return {
    bodyChildren: Array.from(document.body.children).map(c => c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + (c.className ? '.' + String(c.className).split(' ').slice(0, 2).join('.') : '')),
    story: document.querySelector('#story') ? { html: trim(document.querySelector('#story').outerHTML, 700), children: Array.from(document.querySelector('#story').children).map(c => c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + '.' + String(c.className).split(' ').slice(0,2).join('.')) } : null,
    passageCandidates: ['#passage', 'tw-passage', '#story .passage', '.passage', '#story', 'tw-story'].map(s => ({ sel: s, found: !!document.querySelector(s) })),
    titleText: findText('WELCOME TO DEGREES'),
    newGameText: findText('New Game') || findText('Start') || findText('新'),
    clickables: clickables.slice(0, 40)
  };
})()`);

console.log(JSON.stringify(data, null, 1).slice(0, 6000));
await manager.closeAll();
