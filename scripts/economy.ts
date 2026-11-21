/**
 * Runtime output budget: the counterpart to scripts/tools.ts.
 *
 * tools.ts defends the *tool surface* — the JSON every client downloads once per session.
 * This one defends *what the tools return*, which is where a session actually spends its
 * tokens: a 20-step run through The Hundredth Floor used to cost ~100 KB of observations
 * against a 12 KB tool surface. Nothing measured that, so it grew unnoticed.
 *
 *   npx tsx scripts/economy.ts            # print the table
 *   npx tsx scripts/economy.ts --check    # exit 1 when a budget is exceeded
 *
 * Measured through a real MCP client over stdio, against the fixtures in test/fixtures.
 * Every case opens its own session: sharing one lets an earlier case play the story forward
 * and makes a later case measure an error message instead of the thing it claims to measure.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpClient, textOf } from './_harness.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(HERE, '..', 'test', 'fixtures', 'compiled', `${name}.html`);

/**
 * Budgets, in bytes of tool-result text. Every number here was measured, then given headroom;
 * they exist to catch a regression, not to describe today's exact output.
 */
export const BUDGETS = {
  /**
  * observe() on an unchanged passage: header + "(no change)" + choices.
  *
  * This is the *only* case where the passage is omitted, and it is honest: the agent saw this
  * exact state in the immediately preceding observation. Collapsing there is worth ~1.4 KB per
  * redundant call; collapsing anywhere else was hiding text the agent had never been shown.
  */
  observeUnchanged: 400,
  /** observe() that genuinely has new text to show — the normal path, not a regression. */
  observeWithText: 2_500,
  /** An action result (choose) carries no story variables by default. */
  actionNoVariables: 2_600,
  /** A cached revisit prints a handle instead of re-rendering the passage. */
  revisitCached: 700,
  /** engine(include:"summary") — the cheapest way to ask "where am I". */
  engineSummary: 400,
  /** A six-step play() run: one log plus the final observation. */
  playSixSteps: 2_000,
  /** The same six steps as separate observe+choose calls — the baseline play() beats. */
  playSixStepsManual: 9_000,
  /** visited-passage list after a short run. */
  engineVisited: 500,
  /** A screenshot going to the model: capped by the JPEG fallback, whatever the page. */
  screenshotToModel: 500_000
} as const;

interface Row {
  label: string;
  bytes: number;
  budget: number;
  detail: string;
}

/** Each case gets a clean session, so it measures what it claims to measure. */
async function withGame(
  client: Client,
  name: string,
  fn: () => Promise<{ bytes: number; detail: string }>
): Promise<{ bytes: number; detail: string }> {
  await client.callTool({ name: 'open_game', arguments: { source: fixture(name) } });
  try {
    return await fn();
  } finally {
    await client.callTool({ name: 'session', arguments: { action: 'close' } }).catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const client = await mcpClient('economy');
  const rows: Row[] = [];

  const measure = async (label: string, budget: number, fn: () => Promise<{ bytes: number; detail: string }>) => {
    try {
      rows.push({ label, budget, ...(await fn()) });
    } catch (err) {
      rows.push({ label, budget, bytes: -1, detail: `threw: ${String((err as Error)?.message ?? err).slice(0, 80)}` });
    }
  };

  await measure('observe unchanged', BUDGETS.observeUnchanged, () =>
    withGame(client, 'sugarcube', async () => {
      await client.callTool({ name: 'observe', arguments: {} });
      const again = textOf(await client.callTool({ name: 'observe', arguments: {} }));
      return { bytes: again.length, detail: again.split('\n')[0] ?? '' };
    })
  );

  await measure('observe shows new text', BUDGETS.observeWithText, () =>
    withGame(client, 'sugarcube', async () => {
      // The whole point: after an action, an observe must deliver the passage body.
      await client.callTool({ name: 'choose', arguments: { choice: 1 } });
      const res = textOf(await client.callTool({ name: 'observe', arguments: {} }));
      const body = res.split('\n')[1] ?? '';
      const collapsed = /no change|cached/.test(body);
      return { bytes: res.length, detail: collapsed ? 'COLLAPSED — text lost!' : 'passage delivered' };
    })
  );

  await measure('action omits variables', BUDGETS.actionNoVariables, () =>
    withGame(client, 'sugarcube', async () => {
      const res = textOf(await client.callTool({ name: 'choose', arguments: { choice: 1 } }));
      return { bytes: res.length, detail: /Variables/.test(res) ? 'carries variables!' : 'lean' };
    })
  );

  await measure('revisit is cached', BUDGETS.revisitCached, () =>
    withGame(client, 'sugarcube', async () => {
      // Render Hall, come back to Start, then return to Hall: the second Hall is a handle.
      await client.callTool({ name: 'choose', arguments: { choice: 1 } });
      await client.callTool({ name: 'navigate', arguments: { action: 'back' } });
      await client.callTool({ name: 'choose', arguments: { choice: 1 } });
      const res = textOf(await client.callTool({ name: 'navigate', arguments: { action: 'back' } }));
      const cached = /cached/i.test(res);
      return { bytes: res.length, detail: cached ? 'handle used' : 'full re-render' };
    })
  );

  await measure('engine summary', BUDGETS.engineSummary, () =>
    withGame(client, 'sugarcube', async () => {
      const res = textOf(await client.callTool({ name: 'engine', arguments: {} }));
      return { bytes: res.length, detail: res.slice(0, 90) };
    })
  );

  await measure('play six steps', BUDGETS.playSixSteps, () =>
    withGame(client, 'sugarcube', async () => {
      const res = textOf(await client.callTool({ name: 'play', arguments: { steps: [1, 1, 1, 1, 1, 1] } }));
      return { bytes: res.length, detail: res.split('\n')[0] ?? '' };
    })
  );

  await measure('same steps, manual', BUDGETS.playSixStepsManual, () =>
    withGame(client, 'sugarcube', async () => {
      let bytes = 0;
      for (let i = 0; i < 6; i++) {
        const obs = textOf(await client.callTool({ name: 'observe', arguments: {} }));
        const n = Number(obs.match(/Choices \((\d+)\)/)?.[1] ?? 0);
        if (!n) break;
        bytes += obs.length;
        bytes += textOf(await client.callTool({ name: 'choose', arguments: { choice: 1 } })).length;
      }
      return { bytes, detail: 'observe + choose per step' };
    })
  );

  await measure('engine visited', BUDGETS.engineVisited, () =>
    withGame(client, 'sugarcube', async () => {
      await client.callTool({ name: 'play', arguments: { steps: [1, 1] } });
      const res = textOf(await client.callTool({ name: 'engine', arguments: { include: 'visited' } }));
      const named = /"[A-Za-z]/.test(res);
      return { bytes: res.length, detail: named ? 'names, not ids' : 'ids only!' };
    })
  );

  await measure('json carries variables', BUDGETS.observeUnchanged * 4, () =>
    withGame(client, 'sugarcube', async () => {
      const res = textOf(
        await client.callTool({ name: 'observe', arguments: { format: 'json', include_variables: true } })
      );
      let has = false;
      try {
        has = 'variables' in (JSON.parse(res) as Record<string, unknown>);
      } catch {
        has = false;
      }
      return { bytes: res.length, detail: has ? 'variables present' : 'variables DROPPED' };
    })
  );

  await measure('screenshot to model', BUDGETS.screenshotToModel, () =>
    withGame(client, 'sugarcube', async () => {
      const res = (await client.callTool({ name: 'screenshot', arguments: {} })) as {
        content?: Array<{ type: string; data?: string; mimeType?: string }>;
      };
      const img = res.content?.find((x) => x.type === 'image');
      const bytes = img?.data?.length ?? 0;
      return { bytes, detail: `${img?.mimeType ?? '?'} — capped so one shot cannot flood the context` };
    })
  );

  await client.close();

  // --- report ---------------------------------------------------------------
  console.log(`\nRuntime output budget (bytes of tool-result text):\n`);
  console.log('case'.padEnd(24) + 'bytes'.padStart(8) + 'budget'.padStart(9) + '  verdict  detail');
  let failures = 0;
  for (const r of rows) {
    const over = r.bytes < 0 || r.bytes > r.budget;
    if (over) failures++;
    console.log(
      r.label.padEnd(24) +
        String(r.bytes).padStart(8) +
        String(r.budget).padStart(9) +
        (over ? '  OVER   ' : '  ok     ') +
        r.detail.slice(0, 70)
    );
  }

  const play = rows.find((r) => r.label === 'play six steps');
  const manual = rows.find((r) => r.label === 'same steps, manual');
  if (play && manual && play.bytes > 0 && manual.bytes > 0) {
    console.log(`\nplay() vs manual: ${play.bytes} B vs ${manual.bytes} B — ${Math.round(100 - (100 * play.bytes) / manual.bytes)}% saved`);
  }

  const check = process.argv.includes('--check');
  if (failures) {
    console.log(`\n${failures} case(s) over budget. Either the renderer regressed or the budget needs a deliberate bump.`);
    return check ? 1 : 0;
  }
  console.log('\n  ✓ every case within budget');
  return 0;
}

process.exit(await main());
