/** Save a screenshot of a game passage for manual inspection. npx tsx scripts/shot.ts */
import { SessionManager } from '../src/session.js';

const GAME = process.env.TWMCP_GAME ?? '/home/qiyue/Projects/ts_ero_trap_dungeon-1.0.6/build/TS-Ero-Trap-Dungeon.html';
const OUT = process.env.TWMCP_OUT ?? '/tmp/opencode/passage125.png';
const STEPS = Number(process.env.TWMCP_STEPS ?? 3);

const manager = new SessionManager();
const session = await manager.open({ source: GAME, headless: true });
for (let i = 0; i < STEPS; i++) {
  const obs = session.lastObservation!;
  const idx = obs.choices.findIndex((c) => !c.external && !c.disabled);
  if (idx < 0) break;
  await manager.choose(session, idx + 1);
}
console.log('passage:', session.lastObservation?.passage);
const png = await manager.screenshot(session);
const fs = await import('node:fs');
fs.writeFileSync(OUT, png);
console.log('saved', OUT, png.length, 'bytes');
await manager.closeAll();
