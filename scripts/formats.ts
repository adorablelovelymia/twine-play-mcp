/**
 * Multi-format adapter checks against compiled fixtures (Tweego).
 *   npm run formats
 *
 * Covers: format detection, text/choice extraction, navigation, variables,
 * backtracking and snapshot round trips per story-format adapter.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SessionManager } from '../src/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(HERE, '..', 'test', 'fixtures', 'compiled', `${name}.html`);

interface Case {
  name: string;
  expectFormat: string;
  expectText: string;
  chooseLabel: string;
  expectAfter: string;
  secondChoice: string;
  expectSecond: string;
  expectVariables: boolean;
  expectSnapshot: boolean;
  expectBack: boolean;
}

const CASES: Case[] = [
  { name: 'sugarcube', expectFormat: 'sugarcube', expectText: 'small room', chooseLabel: 'Open the door', expectAfter: 'hall is long', secondChoice: 'Continue', expectSecond: 'made it out', expectVariables: true, expectSnapshot: true, expectBack: true },
  { name: 'harlowe', expectFormat: 'harlowe', expectText: 'cold room', chooseLabel: 'Open the door', expectAfter: 'long corridor', secondChoice: 'Continue', expectSecond: 'escape', expectVariables: false, expectSnapshot: false, expectBack: true },
  { name: 'snowman', expectFormat: 'snowman', expectText: 'entrance', chooseLabel: 'Enter', expectAfter: 'hall is quiet', secondChoice: 'Go on', expectSecond: 'You leave', expectVariables: true, expectSnapshot: true, expectBack: false },
  { name: 'chapbook', expectFormat: 'chapbook', expectText: 'small room', chooseLabel: 'Open the door', expectAfter: 'hall is long', secondChoice: 'Continue', expectSecond: 'The end', expectVariables: true, expectSnapshot: true, expectBack: false }
];

let failures = 0;
const check = (prefix: string, name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} [${prefix}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const varDiff = (a: unknown, b: unknown): string[] => {
  const diff: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) {
      diff.push(`${p}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
      return;
    }
    const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
    for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${p}.${k}`);
  };
  walk(a, b, '$');
  return diff;
};

const manager = new SessionManager();

for (const c of CASES) {
  console.log(`\n=== ${c.name} (${c.expectFormat}) ===`);
  try {
    const session = await manager.open({ source: fixture(c.name), headless: true, waitTimeoutMs: 15000 });
    const obs = session.lastObservation!;
    check(c.name, 'format detected', obs.format === c.expectFormat, obs.format);
    if (c.expectFormat === 'harlowe') console.log(`    passage name => ${obs.passage ?? 'unavailable (Harlowe keeps it inside its engine)'}`);
    else check(c.name, 'passage name', !!obs.passage, String(obs.passage));
    check(c.name, 'text extracted', obs.text.toLowerCase().includes(c.expectText.toLowerCase()), `${obs.text.length} chars`);
    check(c.name, 'choices found', obs.choices.length >= 2, obs.choices.map((x) => x.label).join(' | '));
    check(c.name, 'variables readable', c.expectVariables ? !!obs.variables : true, `${obs.variables === null ? 'null' : JSON.stringify(obs.variables).slice(0, 120)}`);

    const res = await manager.choose(session, c.chooseLabel);
    check(c.name, 'choose by label', res.ok, res.ok ? '' : `${res.error} ${res.message ?? ''}`);
    check(c.name, 'passage advanced', session.lastObservation!.text.toLowerCase().includes(c.expectAfter.toLowerCase()));

    const beforeBack = session.lastObservation!;
    const back = await manager.back(session);
    if (c.expectBack) {
      check(c.name, 'back works', back.ok && (back.observation?.text.toLowerCase().includes(c.expectText.toLowerCase()) ?? false), back.ok ? `-> ${back.observation?.passage}` : `${back.error}`);
      await manager.choose(session, c.chooseLabel);
    } else {
      console.log(`    back => ${back.ok ? `works (${back.observation?.passage})` : `not supported: ${back.message ?? back.error}`}`);
    }
    check(c.name, 'passage after back+rechoose', session.lastObservation!.text.toLowerCase().includes(c.expectAfter.toLowerCase()), String(session.lastObservation!.passage));

    const savedVars = beforeBack.variables;
    const save = await manager.saveState(session, 'fmt');
    if (c.expectSnapshot) {
      check(c.name, 'snapshot saved', save.ok, save.ok ? `${save.bytes} chars` : `${save.error}`);
      await manager.choose(session, c.secondChoice);
      check(c.name, 'moved away for restore test', session.lastObservation!.text.toLowerCase().includes(c.expectSecond.toLowerCase()));
      const load = await manager.loadState(session, 'fmt');
      check(c.name, 'snapshot restored', load.ok, load.ok ? '' : `${load.error} ${load.message ?? ''}`);
      const afterText = session.lastObservation!.text.toLowerCase();
      check(c.name, 'restored passage matches', afterText.includes(c.expectAfter.toLowerCase()), afterText.slice(0, 60).replace(/\n/g, ' '));
      const diff = varDiff(savedVars, session.lastObservation!.variables);
      check(c.name, 'restored state matches', diff.length <= 3, diff.slice(0, 3).join('; '));
    } else {
      check(c.name, 'snapshot reports unsupported', !save.ok && save.error === 'unsupported', save.error ?? '');
    }

    const errs = session.console.filter((e) => e.type !== 'warning');
    check(c.name, 'no console issues', errs.length === 0, errs.slice(0, 2).map((e) => e.text.slice(0, 100)).join(' | '));

    await manager.close(session.id);
  } catch (err) {
    check(c.name, 'session', false, String((err as Error)?.message ?? err));
  }
}

console.log(`\n===== format checks: ${failures === 0 ? 'all passed' : failures + ' FAILED'} =====`);
await manager.closeAll();
process.exit(failures ? 1 : 0);
