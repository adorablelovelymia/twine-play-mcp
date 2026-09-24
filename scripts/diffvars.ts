/**
 * Diff variables across a snapshot round trip.  npx tsx scripts/diffvars.ts
 */
import { SessionManager } from '../src/session.js';

const GAME = process.argv[2] ?? '/home/qiyue/Projects/ts_ero_trap_dungeon-1.0.6/build/TS-Ero-Trap-Dungeon.html';
const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true });

const before = session.lastObservation!.variables;
const beforeJson = JSON.stringify(before);
console.log('passage at save:', session.lastObservation!.passage);
console.log('variables at save:', beforeJson.slice(0, 600));

await manager.saveState(session, 'diff');
for (let i = 0; i < 3; i++) {
  const obs = session.lastObservation!;
  const c = obs.choices.find((x) => !x.external);
  if (!c) break;
  await manager.choose(session, c.label);
}

await manager.loadState(session, 'diff');
const after = session.lastObservation!.variables;
console.log('passage after load:', session.lastObservation!.passage);

const walk = (a: unknown, b: unknown, path: string, out: string[]) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
};

const diffs: string[] = [];
walk(before, after, '$', diffs);
console.log(`\ndifferences: ${diffs.length}`);
for (const d of diffs.slice(0, 40)) console.log('  ' + d);

await manager.closeAll();
