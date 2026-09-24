/** Explore a game's start screen and UI entry points. npx tsx scripts/dol-explore.ts [game.html] */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { SessionManager } from '../src/session.js';
import { renderObservation } from '../src/render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = process.argv[2] ?? '/home/qiyue/Projects/degrees_of_lewdity/DoL-Chinese-Launcher-0.5.11.9-chs-1.0.0a-linux-x86_64/Degrees of Lewdity.html';

const manager = new SessionManager();
const t0 = Date.now();
const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 60000 });
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 等它自己安静下来再观察一次
await manager.waitStable(session, 60000);
const obs = await manager.observe(session, { includeVariables: false, maxTextChars: 1500 });
console.log('\n===== observation =====');
console.log(renderObservation(obs, { step: 0 }).slice(0, 1800));

// UI 入口：passage 之外的按钮/链接
const ui = await session.page.evaluate(`(() => {
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll('button, a, [role=button], input[type=button], .link-internal, tw-link')) {
    if (el.closest('#passage')) continue;
    const t = (el.innerText || el.value || el.title || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ tag: el.tagName.toLowerCase(), text: t.slice(0, 60), id: el.id || null, cls: String(el.className).slice(0, 60) });
  }
  return out.slice(0, 60);
})()`);
console.log('\n===== UI buttons outside #passage =====');
console.log(JSON.stringify(ui, null, 1));

// Mod 相关全局
const mods = await session.page.evaluate(`(() => {
  const w = window;
  const keys = Object.keys(w).filter(k => /mod/i.test(k)).slice(0, 30);
  const info = { windowKeys: keys };
  try { info.modLoader = w.modLoader ? Object.keys(w.modLoader).slice(0, 20) : null; } catch (e) { info.modLoader = 'ERR'; }
  try {
    const st = w.SugarCube && w.SugarCube.State;
    info.passage = st ? st.passage : null;
  } catch (e) { /* ignore */ }
  try { info.modLoadSwitch = w.localStorage.getItem('ModLoadSwitch'); } catch (e) { info.modLoadSwitch = 'ERR'; }
  try { info.indexedDBs = ['']; } catch (e) { /* ignore */ }
  return info;
})()`);
console.log('\n===== mod globals =====');
console.log(JSON.stringify(mods, null, 1));

// 列出 IndexedDB 数据库名
const dbs = await session.page.evaluate(`(async () => {
  if (!indexedDB.databases) return 'no databases() API';
  const list = await indexedDB.databases();
  return list.map(d => d.name + '@' + d.version);
})()`);
console.log('\n===== IndexedDB =====');
console.log(JSON.stringify(dbs, null, 1));

const png = await manager.screenshot(session);
fs.writeFileSync('/tmp/opencode/dol-start.png', png);
console.log('\nscreenshot: /tmp/opencode/dol-start.png', png.length, 'bytes');

await manager.closeAll();
