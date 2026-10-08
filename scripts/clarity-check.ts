/**
 * Clarity regression against the real Degrees of Lewdity character-creation page.
 * Verifies the agent-ergonomics fixes:
 *   - inputs are paginated (inputsTotal / inputs_offset) instead of silently capped at 40
 *   - find_ui(text) reaches SugarCube radio labels ("Jet black") and returns refs
 *   - click_ui(text) matches <label>-based controls (was no-match before)
 *   - get_variables reads story variables by dot path
 *   - failures stay clean (no full-observation dump)
 *
 *   TWMCP_GAME=/path/to/game.html npm run clarity
 *
 * Needs a game you have locally — without TWMCP_GAME this skips instead of crashing.
 */
import { SessionManager, type GameSession } from '../src/session.js';
import { renderObservation } from '../src/render.js';
import { createChecker, requireGame } from './_harness.js';

const GAME = process.env.TWMCP_GAME ?? '';
if (!requireGame(GAME, 'clarity-check')) process.exit(0);

const suite = createChecker('clarity checks');
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  const passed = suite.check(name, ok, detail);
  results.push([name, passed, detail]);
  return passed;
};

async function main() {
  const manager = new SessionManager();
  console.log(`\n[1] Opening ${GAME}`);
  const session = await manager.open({ source: GAME, headless: true, waitTimeoutMs: 45000 });
  const opened = session.lastObservation!;
  check('game opened', !!opened.passage, `${opened.passage} (${opened.format})`);

  console.log('\n[2] Age dialog: checkbox label + numbered dialog button');
  const cb = opened.inputs.find((i) => i.kind === 'checkbox');
  check('dialog checkbox has a label', !!cb?.label, cb ? `${cb.ref} "${cb.label}"` : 'none');
  if (cb) await manager.interact(session, cb.ref, 'true');
  const dlgBtn = session.lastObservation?.choices.find((c) => c.dialog);
  check('dialog button exposed as a choice', !!dlgBtn, dlgBtn ? `${dlgBtn.label}` : 'none');
  const dlgNumber = dlgBtn ? session.lastObservation!.choices.indexOf(dlgBtn) + 1 : 0;
  if (dlgNumber) await manager.choose(session, dlgNumber);

  console.log('\n[3] Character creation + input pagination');
  const ccIdx = session.lastObservation!.choices.findIndex((c) => /character creation/i.test(c.label));
  if (ccIdx < 0) {
    console.log('  choices: ' + session.lastObservation!.choices.map((c) => c.label).join(' | '));
    throw new Error('Character Creation link not found');
  }
  const r1 = await manager.choose(session, ccIdx + 1);
  const cc = r1.observation!;
  check('character creation reached', /Body|Breast Size|Demeanour/i.test(cc.text), `passage=${cc.passage}`);
  check(
    'inputs paginated, total exposed',
    (cc.inputsTotal ?? 0) > cc.inputs.length,
    `shown=${cc.inputs.length} total=${cc.inputsTotal} (was hard-capped at 40)`
  );
  const rendered = renderObservation(cc, { step: 0 });
  check(
    'render names the window + offset hint',
    /Inputs \(\d+-\d+ of \d+\)/.test(rendered) && /inputs_offset=/.test(rendered),
    rendered.match(/Inputs \([^\n]*/)?.[0] ?? '(missing)'
  );
  check(
    'sidebar listed in observation (always, no hiding)',
    /^UI: \S/m.test(rendered) && /\[u\d+\]/.test(rendered),
    (rendered.match(/^UI: .*/m)?.[0] ?? '(no UI line)').slice(0, 160)
  );

  console.log('\n[4] find_ui on a SugarCube radio label');
  const f1 = await manager.findUi(session, { text: 'Jet black' });
  check('find_ui finds "Jet black"', !!f1.ok && (f1.matches?.length ?? 0) > 0, JSON.stringify(f1.matches?.slice(0, 2)));
  check('find_ui reports the radio input state', !!f1.matches?.some((m) => m.checked !== undefined), '');

  console.log('\n[5] click_ui by label text (previously no-match)');
  const click = await manager.clickUi(session, { text: 'Jet black' });
  check('click_ui("Jet black") works', !!click.ok, click.ok ? String(click.label) : `${click.error} — ${click.message}`);
  const f2 = await manager.findUi(session, { text: 'Jet black', kind: 'radio' });
  check('hair colour radio is now checked', !!f2.matches?.some((m) => m.checked), JSON.stringify(f2.matches?.slice(0, 3)));

  console.log('\n[6] get_variables by path + key summary');
  const gv = await manager.getVariables(session, ['hairlength', 'background', 'no_such_var_xyz']);
  check(
    'get_variables returns requested paths',
    !!gv.ok && gv.values?.hairlength !== undefined && gv.values?.background !== undefined,
    JSON.stringify(gv.values)
  );
  check('get_variables reports missing paths', (gv.missing ?? []).includes('no_such_var_xyz'), JSON.stringify(gv.missing));
  const gk = await manager.getVariables(session);
  check('get_variables key summary', !!gk.ok && (gk.totalKeys ?? 0) > 20, `totalKeys=${gk.totalKeys}`);
  const hairKeys = Object.keys(gk.summary ?? {}).filter((k) => /hair/i.test(k));
  check('key summary covers hair* variables', hairKeys.length > 0, hairKeys.join(', '));

  console.log('\n[7] Clean failure (no observation dump)');
  const bad = await manager.choose(session, 'definitely-not-a-real-choice-xyz');
  check('bad choice reports no-such-choice', !bad.ok && bad.error === 'no-such-choice', String(bad.error));

  await manager.close(session.id);
  const failed = results.filter((r) => !r[1]);
  console.log(`\n===== ${results.length - failed.length}/${results.length} checks passed =====`);
  if (failed.length) {
    for (const [name, , detail] of failed) console.log(`  ✗ ${name} — ${detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('clarity-check failed:', err);
  process.exit(1);
});
