/**
 * Tool-surface snapshot and budget check.
 *
 *   npx tsx scripts/tools.ts            # print the surface + refresh test/tools.snapshot.json
 *   npx tsx scripts/tools.ts --check    # fail (exit 1) when the surface differs from the snapshot
 *
 * Why this exists: every tool definition costs context in *every* agent session, so the surface is
 * a budget to be defended. The snapshot pins the tool names and parameter names (so an accidental
 * rename cannot slip through) and the byte budget keeps descriptions from creeping back up.
 *
 * Measured through a real MCP client over stdio on purpose: that is the exact JSON a client
 * receives, including the Zod-derived schemas — reading the server internals would undercount them.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mcpClient, REPO_ROOT } from './_harness.js';

const SNAPSHOT = path.join(REPO_ROOT, 'test', 'tools.snapshot.json');

/** Byte budget for the whole tool surface (schemas + descriptions + names). */
export const SURFACE_BUDGET_BYTES = 12_500;
/** Upper bound for a single tool description; longer ones get repeated in every session. */
export const DESC_BUDGET_BYTES = 320;

interface SurfaceTool {
  name: string;
  params: string[];
  descBytes: number;
  schemaBytes: number;
}

interface Surface {
  toolCount: number;
  totalBytes: number;
  tools: SurfaceTool[];
}

async function measure(): Promise<Surface> {
  if (!existsSync(path.join(REPO_ROOT, 'dist', 'index.js'))) {
    throw new Error('dist/ is missing — run `npm run build` first.');
  }
  const client = await mcpClient('tools-surface');
  const { tools } = await client.listTools();
  await client.close();

  const out: SurfaceTool[] = [];
  let totalBytes = 0;
  for (const t of tools) {
    const params = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort();
    const descBytes = (t.description ?? '').length;
    const schemaBytes = JSON.stringify(t.inputSchema).length;
    totalBytes += t.name.length + descBytes + schemaBytes;
    out.push({ name: t.name, params, descBytes, schemaBytes });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { toolCount: tools.length, totalBytes, tools: out };
}

function print(surface: Surface): void {
  console.log(`\nTool surface: ${surface.toolCount} tools, ${surface.totalBytes} bytes (budget ${SURFACE_BUDGET_BYTES})`);
  console.log('tool'.padEnd(20) + 'params  descB  schemaB');
  for (const t of surface.tools) {
    const over = t.descBytes > DESC_BUDGET_BYTES ? '  <- description over budget' : '';
    console.log(
      t.name.padEnd(20) + String(t.params.length).padStart(6) + String(t.descBytes).padStart(7) + String(t.schemaBytes).padStart(9) + over
    );
  }
}

const check = process.argv.includes('--check');
const budget = process.argv.includes('--budget');
const surface = await measure();
print(surface);

let failures = 0;
const fail = (msg: string) => {
  console.log(`  x ${msg}`);
  failures++;
};
const pass = (msg: string) => console.log(`  ✓ ${msg}`);

if (budget) {
  if (surface.totalBytes > SURFACE_BUDGET_BYTES) {
    fail(`tool surface is ${surface.totalBytes} bytes — over the ${SURFACE_BUDGET_BYTES} budget by ${surface.totalBytes - SURFACE_BUDGET_BYTES}`);
  } else {
    pass(`tool surface within budget (${surface.totalBytes} <= ${SURFACE_BUDGET_BYTES})`);
  }
  for (const t of surface.tools) {
    if (t.descBytes > DESC_BUDGET_BYTES) fail(`${t.name}: description is ${t.descBytes} bytes (limit ${DESC_BUDGET_BYTES})`);
  }
}

if (check) {
  if (!existsSync(SNAPSHOT)) {
    fail(`no snapshot at ${path.relative(REPO_ROOT, SNAPSHOT)} — run \`npx tsx scripts/tools.ts\` to create it`);
  } else {
    const previous = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Surface;
    const before = new Map(previous.tools.map((t) => [t.name, t]));
    const after = new Map(surface.tools.map((t) => [t.name, t]));
    for (const name of before.keys()) if (!after.has(name)) fail(`tool removed: ${name}`);
    for (const name of after.keys()) if (!before.has(name)) fail(`tool added: ${name}`);
    for (const [name, t] of after) {
      const prev = before.get(name);
      if (!prev) continue;
      const added = t.params.filter((p) => !prev.params.includes(p));
      const removed = prev.params.filter((p) => !t.params.includes(p));
      if (added.length) fail(`${name}: parameter(s) added: ${added.join(', ')}`);
      if (removed.length) fail(`${name}: parameter(s) removed: ${removed.join(', ')}`);
    }
    if (failures === 0) pass(`snapshot matches (${previous.toolCount} tools pinned)`);
  }
  if (failures) {
    console.log('\nIf the change is intentional, refresh the snapshot: npx tsx scripts/tools.ts');
    process.exit(1);
  }
} else {
  writeFileSync(SNAPSHOT, JSON.stringify(surface, null, 2) + '\n');
  console.log(`\nSnapshot written: ${path.relative(REPO_ROOT, SNAPSHOT)}`);
  if (failures) process.exit(1);
}
