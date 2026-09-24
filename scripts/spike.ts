/**
 * M0 spike: validate the core runtime against a real SugarCube game.
 *   npm run spike
 */
import { SessionManager } from '../src/session.js';
import { renderObservation } from '../src/render.js';

const GAME = process.env.TWMCP_GAME ?? '/home/qiyue/Projects/ts_ero_trap_dungeon-1.0.6/build/TS-Ero-Trap-Dungeon.html';
const STEPS = Number(process.env.TWMCP_STEPS ?? 25);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const manager = new SessionManager();
  const t0 = Date.now();

  console.log(`\n[1] Opening ${GAME}`);
  const session = await manager.open({ source: GAME, headless: true });
  const first = session.lastObservation!;
  console.log(renderObservation(first, { step: 0 }).slice(0, 1200));
  console.log('  …');

  check('format detected as sugarcube', first.format === 'sugarcube', first.format);
  check('passage name available', !!first.passage, String(first.passage));
  check('passage text extracted', first.text.length > 100, `${first.text.length} chars`);
  check('choices found', first.choices.length > 0, `${first.choices.length} choices`);
  check('variables readable', !!first.variables, first.variables ? `${JSON.stringify(first.variables).length} chars` : 'null');
  check('story metadata', !!first.story?.title, String(first.story?.title));
  check('engine idle after load', first.engineState === 'idle' || first.engineState === null, String(first.engineState));

  console.log('\n[2] Snapshot round trip (Save.base64)');
  const save1 = await manager.saveState(session, 'spike');
  check('snapshot captured', save1.ok, `${save1.bytes ?? 0} chars`);
  const beforeVars = JSON.stringify(session.lastObservation?.variables ?? null);
  const beforePassage = session.lastObservation?.passage ?? null;

  console.log('\n[3] Playing up to ' + STEPS + ' steps (first internal choice)');
  let steps = 0;
  let errors = 0;
  let endings = 0;
  for (let i = 0; i < STEPS; i++) {
    const obs = session.lastObservation!;
    const idx = obs.choices.findIndex((c) => !c.external && !c.disabled);
    if (idx < 0) {
      endings++;
      console.log(`  ... stopped at step ${steps}: no internal choices (passage=${obs?.passage ?? '?'})`);
      break;
    }
    const res = await manager.choose(session, idx + 1);
    if (!res.ok) {
      console.log(`  ... step ${steps + 1} failed: ${res.error} ${res.message ?? ''}`);
      errors++;
      break;
    }
    steps++;
    if (steps % 5 === 0) console.log(`  ... step ${steps}: passage=${res.observation?.passage ?? '?'}`);
  }
  check('played multiple steps', steps >= 5, `${steps} steps`);
  check('no click failures', errors === 0, `${errors} failures`);

  console.log('\n[4] Back navigation');
  const back = await manager.back(session);
  check('back works', back.ok, back.ok ? `now at ${back.observation?.passage}` : String(back.message));

  console.log('\n[5] Restore snapshot');
  const load = await manager.loadState(session, 'spike');
  const diff: string[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
      diff.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      return;
    }
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
  };
  walk(JSON.parse(beforeVars), session.lastObservation?.variables, '$');
  check('snapshot restored', load.ok, load.ok ? `passage=${session.lastObservation?.passage}` : String(load.message));
  check('passage matches snapshot', beforePassage === session.lastObservation?.passage, `${beforePassage} -> ${session.lastObservation?.passage}`);
  check('state matches snapshot (re-render deltas allowed)', diff.length <= 3, diff.length ? diff.slice(0, 3).join('; ') : '');

  console.log('\n[6] Console / network issues');
  const jsExceptions = session.console.filter((c) => c.type === 'pageerror');
  const issues = session.console.filter((c) => c.type !== 'warning');
  check('no JS exceptions', jsExceptions.length === 0, `${jsExceptions.length}`);
  check('no console/network issues', issues.length === 0, `${issues.length}`);
  for (const e of issues.slice(0, 3)) console.log(`      [${e.type}] ${e.text.slice(0, 160)}`);

  console.log('\n[7] Screenshot');
  const shot = await manager.screenshot(session);
  check('screenshot bytes', shot.length > 1000, `${shot.length} bytes`);

  await manager.closeAll();
  const failed = results.filter((r) => !r[1]);
  console.log(`\n===== ${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s =====`);
  if (failed.length) {
    for (const f of failed) console.log(`FAILED: ${f[0]} ${f[2]}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('\nSPIKE CRASHED:', err);
  process.exit(1);
});
