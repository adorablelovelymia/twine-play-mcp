/**
 * DOM/window inspection for a compiled fixture.  npx tsx scripts/inspect.ts <name>
 *
 * NOTE: the page.evaluate body is a plain string on purpose. tsx/esbuild injects
 * __name() helpers into transpiled callbacks, which breaks Playwright's function
 * serialization; strings sidestep that entirely.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SessionManager } from '../src/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] ?? 'snowman';
const file = path.join(HERE, '..', 'test', 'fixtures', 'compiled', `${name}.html`);

const manager = new SessionManager();
const session = await manager.open({ source: file, headless: true });
const page = session.page;

const script = `(() => {
  const w = window;
  const trim = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').slice(0, n || 700);
  const el = (sel) => {
    const e = document.querySelector(sel);
    return e ? { found: true, tag: e.tagName, id: e.id, cls: e.className, display: getComputedStyle(e).display, text: trim(e.textContent, 300), html: trim(e.outerHTML, 600) } : { found: false };
  };
  let storyPassage = null;
  try { storyPassage = w.story && w.story.passage; } catch (e) { storyPassage = 'ERR ' + e; }
  let stateShape = null;
  try {
    const s = (w.story && w.story.state) || w.state;
    stateShape = s ? { keys: Object.keys(s).slice(0, 30), vars: s.variables ? Object.keys(s.variables) : null, varsValue: s.variables } : null;
  } catch (e) { stateShape = 'ERR ' + e; }
  const describe = (obj) => {
    try {
      return {
        type: typeof obj,
        keys: obj ? Object.keys(obj).slice(0, 30) : null,
        proto: obj ? Object.getOwnPropertyNames(Object.getPrototypeOf(obj)).slice(0, 25) : null,
        json: (() => { try { return trim(JSON.stringify(obj), 300); } catch (e) { return 'ERR'; } })()
      };
    } catch (e) { return 'ERR ' + e; }
  };
  const jqEl = w.story && w.story.$passageEl;
  const jqNode = jqEl && jqEl[0] ? jqEl[0] : null;
  const apiProbe = {
    storyBack: typeof (w.story && w.story.back),
    storyGo: typeof (w.story && w.story.go),
    storyCheckpoint: typeof (w.story && w.story.checkpoint),
    engineBack: typeof (w.engine && w.engine.back),
    engineGoto: typeof (w.engine && w.engine.goto),
    engineKeys: w.engine ? Object.keys(w.engine).slice(0, 30) : null,
    engineStateProps: w.engine && w.engine.state ? Object.getOwnPropertyNames(w.engine.state).slice(0, 30) : null,
    harlowePassageAttrs: (() => {
      const e = document.querySelector('tw-passage');
      return e ? Array.from(e.attributes).map((a) => a.name + '=' + String(a.value).slice(0, 40)).slice(0, 12) : null;
    })(),
    harloweStoryAttrs: (() => {
      const e = document.querySelector('tw-story');
      return e ? Array.from(e.attributes).map((a) => a.name + '=' + String(a.value).slice(0, 40)).slice(0, 12) : null;
    })(),
    storyProtoMethods: w.story ? Object.getOwnPropertyNames(Object.getPrototypeOf(w.story)).slice(0, 40) : null,
    storyOwnMethods: w.story ? Object.getOwnPropertyNames(w.story).filter((k) => typeof w.story[k] === 'function') : null,
    engineStory: w.engine
      ? {
          type: typeof w.engine.story,
          keys: w.engine.story && typeof w.engine.story === 'object' ? Object.keys(w.engine.story).slice(0, 25) : null,
          proto: w.engine.story && typeof w.engine.story === 'object' ? Object.getOwnPropertyNames(Object.getPrototypeOf(w.engine.story)).slice(0, 30) : null
        }
      : null
  };
  return {
    bodyChildren: Array.from(document.body.children).map((c) => c.tagName.toLowerCase() + '#' + c.id + '.' + String(c.className || '').split(' ').join('.')),
    engineNames: Object.keys(w).filter((k) => /engine|story|state|passage|chapbook/i.test(k)).slice(0, 30),
    passage: el('#passage'),
    twPassage: el('tw-passage'),
    others: el('[data-passage], .passage, #page, #content, main'),
    twStoryHtml: trim(document.querySelector('tw-story') && document.querySelector('tw-story').innerHTML, 1000),
    storyKeys: w.story ? Object.keys(w.story).slice(0, 40) : null,
    storyPassage: storyPassage === undefined ? null : storyPassage,
    stateShape,
    passageGlobal: describe(w.passage),
    storyState: describe(w.story && w.story.state),
    storyVars: describe(w.story && w.story.state && w.story.state.variables),
    passageElHtml: jqNode ? trim(jqNode.outerHTML, 800) : null,
    apiProbe
  };
})()`;

const info = await page.evaluate(script);
console.log(JSON.stringify(info, null, 2));
await manager.closeAll();
