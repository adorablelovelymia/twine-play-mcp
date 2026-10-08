/**
 * Ad-hoc debugging for a game or a fixture — the tools you reach for when an adapter or a
 * page misbehaves. Each subcommand opens a browser, does one thing and exits.
 *
 *   npx tsx scripts/debug.ts diag [<game>] [steps]   network/console trace + a few steps
 *   npx tsx scripts/debug.ts vars [<game>] [steps]   diff variables across a snapshot round trip
 *   npx tsx scripts/debug.ts dom  [<game>] [steps]   dump the DOM/CSS around a passage
 *   npx tsx scripts/debug.ts probe <fixture>         dump a fixture's DOM and engine globals
 *
 * `<game>` defaults to `$TWMCP_GAME`; `probe` defaults to the `snowman` fixture.
 * The fixture probe keeps its `page.evaluate` body as a string on purpose: tsx/esbuild injects
 * `__name()` helpers into transpiled callbacks, which breaks Playwright's function serialization.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SessionManager, type GameSession } from '../src/session.js';
import { requireGame, varDiff } from './_harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: npx tsx scripts/debug.ts <diag|vars|dom|probe> [game-or-fixture] [steps]

  diag  [game] [steps=5]   live network + console trace, then walk a few steps
  vars  [game] [steps=3]   diff story variables across a snapshot round trip
  dom   [game] [steps=3]   dump passage/status/link HTML and the CSS rules that match
  probe [fixture=snowman]  dump a compiled fixture's DOM and engine globals

<game> may also come from $TWMCP_GAME.`;

const [, , sub, target, stepsArg] = process.argv;
if (!sub || !['diag', 'vars', 'dom', 'probe'].includes(sub)) {
  console.log(USAGE);
  process.exit(sub ? 1 : 0);
}

/** Open whatever the subcommand was pointed at, or explain why we cannot. */
async function openGame(manager: SessionManager, label: string): Promise<GameSession | null> {
  const source = target ?? process.env.TWMCP_GAME ?? '';
  if (!requireGame(source, `debug ${label}`)) return null;
  return manager.open({ source, headless: true });
}

/** Click the first non-external choice, `steps` times, stopping if the story ends. */
async function walk(manager: SessionManager, session: GameSession, steps: number, onFail?: (r: { error?: string; message?: string }) => void) {
  for (let i = 0; i < steps; i++) {
    const obs = session.lastObservation;
    const choice = obs?.choices.find((c) => !c.external && !c.disabled);
    if (!choice) break;
    const res = await manager.choose(session, choice.label);
    if (!res.ok) {
      onFail?.(res);
      break;
    }
  }
}

const manager = new SessionManager();

if (sub === 'probe') {
  const name = target ?? 'snowman';
  const file = path.join(HERE, '..', 'test', 'fixtures', 'compiled', `${name}.html`);
  const session = await manager.open({ source: file, headless: true });
  const script = `(() => {
    const w = window;
    const trim = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').slice(0, n || 700);
    const el = (sel) => {
      const e = document.querySelector(sel);
      return e ? { found: true, tag: e.tagName, id: e.id, cls: e.className, display: getComputedStyle(e).display, text: trim(e.textContent, 300), html: trim(e.outerHTML, 600) } : { found: false };
    };
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
    return {
      bodyChildren: Array.from(document.body.children).map((c) => c.tagName.toLowerCase() + '#' + c.id + '.' + String(c.className || '').split(' ').join('.')),
      engineNames: Object.keys(w).filter((k) => /engine|story|state|passage|chapbook/i.test(k)).slice(0, 30),
      passage: el('#passage'),
      twPassage: el('tw-passage'),
      others: el('[data-passage], .passage, #page, #content, main'),
      twStoryHtml: trim(document.querySelector('tw-story') && document.querySelector('tw-story').innerHTML, 1000),
      storyKeys: w.story ? Object.keys(w.story).slice(0, 40) : null,
      storyVars: describe(w.story && w.story.state && w.story.state.variables),
      engineStateProps: w.engine && w.engine.state ? Object.getOwnPropertyNames(w.engine.state).slice(0, 30) : null
    };
  })()`;
  console.log(JSON.stringify(await session.page.evaluate(script), null, 2));
  await manager.closeAll();
} else if (sub === 'dom') {
  const session = await openGame(manager, 'dom');
  if (session) {
    await walk(manager, session, Number(stepsArg ?? 3));
    const script = `(() => {
      const trim = (s, n) => String(s == null ? '' : s).slice(0, n || 1200);
      const pseudo = (el, which) => {
        if (!el) return null;
        try { return getComputedStyle(el, which).content; } catch (e) { return 'ERR ' + e; }
      };
      const root = document.querySelector('#passage') || document.querySelector('tw-passage');
      const status = document.querySelector('#story-caption, tw-header, .status-bar');
      const link = Array.from(document.querySelectorAll('#passage a, #passage tw-link, tw-passage a')).pop();
      const rules = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rs = [];
        try { rs = Array.from(sheet.cssRules); } catch (e) { continue; }
        for (const r of rs) {
          const t = r.cssText || '';
          if (/content:/.test(t)) rules.push(trim(t, 200));
        }
      }
      return {
        passageHtml: root ? trim(root.innerHTML, 2500) : null,
        headingHtml: (() => { const h = root && root.querySelector('h1, h2, strong'); return h ? h.outerHTML : null; })(),
        headingBefore: pseudo(root && root.querySelector('h1, h2, strong'), '::before'),
        statusHtml: status ? trim(status.innerHTML, 1800) : null,
        statusBefore: pseudo(status, '::before'),
        linkHtml: link ? link.outerHTML : null,
        linkBefore: pseudo(link, '::before'),
        contentRules: rules.slice(0, 25)
      };
    })()`;
    console.log(JSON.stringify(await session.page.evaluate(script), null, 1));
    await manager.closeAll();
  }
} else if (sub === 'vars') {
  const session = await openGame(manager, 'vars');
  if (session) {
    const steps = Number(stepsArg ?? 3);
    const before = session.lastObservation?.variables ?? null;
    console.log('passage at save:', session.lastObservation?.passage);
    console.log('variables at save:', JSON.stringify(before).slice(0, 600));
    const saved = await manager.saveState(session, 'debug');
    if (!saved.ok) console.log('snapshot unsupported for this format:', saved.error);
    await walk(manager, session, steps);
    const loaded = await manager.loadState(session, 'debug');
    console.log('passage after load:', session.lastObservation?.passage, loaded.ok ? '' : `(load failed: ${loaded.error})`);
    const diffs = varDiff(before, session.lastObservation?.variables ?? null);
    console.log(`\ndifferences: ${diffs.length}`);
    for (const d of diffs.slice(0, 40)) console.log('  ' + d);
    await manager.closeAll();
  }
} else {
  const session = await openGame(manager, 'diag');
  if (session) {
    session.page.on('response', (res) => {
      if (res.status() >= 400) console.log(`HTTP ${res.status()} ${res.url()}`);
    });
    session.page.on('requestfailed', (req) => {
      console.log(`FAILED ${req.failure()?.errorText} ${req.url()}`);
    });
    session.page.on('console', (msg) => {
      console.log(`CONSOLE[${msg.type()}] ${msg.text().slice(0, 300)} @ ${msg.location()?.url ?? ''}`);
    });
    console.log('--- walking a few steps ---');
    await walk(manager, session, Number(stepsArg ?? 5), (r) => console.log('choose failed:', r.error, r.message));
    console.log('--- captured console buffer ---');
    for (const c of session.console) console.log(`${c.type}: ${c.text.slice(0, 200)} @ ${c.location ?? ''}`);
    await manager.closeAll();
  }
}
