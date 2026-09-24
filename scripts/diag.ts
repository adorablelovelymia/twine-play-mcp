/**
 * Network/console diagnostics for a game.  npx tsx scripts/diag.ts [path-or-url] [steps]
 */
import { SessionManager } from '../src/session.js';

const GAME = process.argv[2] ?? '/home/qiyue/Projects/ts_ero_trap_dungeon-1.0.6/build/TS-Ero-Trap-Dungeon.html';
const STEPS = Number(process.argv[3] ?? 5);

const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true });

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
for (let i = 0; i < STEPS; i++) {
  const obs = session.lastObservation!;
  const internal = obs.choices.find((c) => !c.external && !c.disabled);
  if (!internal) break;
  const res = await manager.choose(session, internal.label);
  if (!res.ok) {
    console.log('choose failed:', res.error, res.message);
    break;
  }
}

console.log('--- captured console buffer ---');
for (const c of session.console) console.log(`${c.type}: ${c.text.slice(0, 200)} @ ${c.location ?? ''}`);
await manager.closeAll();
