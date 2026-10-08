/**
 * Multi-format adapter checks against compiled fixtures (Tweego).
 *   npm test
 *
 * Covers: format detection, text/choice extraction, navigation, variables,
 * backtracking and snapshot round trips per story-format adapter.
 *
 * This is the one self-check with no external dependencies — the fixtures live in
 * test/fixtures/compiled/, so a fresh clone can run it (and CI can gate on it).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SessionManager } from '../src/session.js';
import { createChecker, varDiff } from './_harness.js';

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
const suite = createChecker('format checks');
const check = suite.checkp;

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

// ---------------------------------------------------------------------------
// Agent-facing regressions: state hygiene and clean degradation.
// These used to be silent bugs, so they are pinned here on the fixtures.
// ---------------------------------------------------------------------------
console.log('\n=== agent-facing regressions (sugarcube fixture) ===');
try {
  const session = await manager.open({ source: fixture('sugarcube'), headless: true, waitTimeoutMs: 15000 });
  const id = session.id;

  // The next observation must be complete even when the caller hides variables: hiding them is a
  // rendering choice, not a mutation of the session state.
  const lean = await manager.observe(session, { includeVariables: false });
  check('regress', 'includeVariables:false returns no variables in that observation', lean.variables === null, JSON.stringify(lean.variables));
  const full = await manager.observe(session, { includeVariables: true });
  check('regress', 'a later includeVariables:true still sees the story variables', full.variables !== null, JSON.stringify(full.variables).slice(0, 120));

  // session.step is the public step counter, and journal entries must stay consistent with it.
  const before = session.journal.length;
  await manager.choose(session, 'Open the door');
  check('regress', 'choose appends exactly one journal entry', session.journal.length === before + 1, `${before} -> ${session.journal.length}`);

  // Unknown game ids must list what is open instead of a bare "unknown".
  let unknownMsg = '';
  try {
    manager.get('game_nope');
  } catch (err) {
    unknownMsg = String((err as Error)?.message ?? err);
  }
  check('regress', 'unknown game_id lists the open sessions', unknownMsg.includes(id), unknownMsg);

  await manager.close(id);
} catch (err) {
  check('regress', 'regression session', false, String((err as Error)?.message ?? err));
}

failures = suite.report();
await manager.closeAll();
process.exit(failures ? 1 : 0);
