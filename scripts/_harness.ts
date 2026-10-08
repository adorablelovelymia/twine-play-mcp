/**
 * Shared test helpers for the scripts/ self-checks.
 *
 * The check/report frame, the variable-tree diff and the MCP client bootstrap used to be
 * copy-pasted into spike.ts, clarity-check.ts, formats.ts and mcp-smoke.ts. They live here
 * once so a check that prints differently in one script cannot happen.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Checker {
  /** Record one assertion. `detail` is only printed for failures and for verbose passes. */
  check: (name: string, ok: boolean, detail?: string) => boolean;
  /** Same, with a per-case prefix (used by the per-format runs). */
  checkp: (prefix: string, name: string, ok: boolean, detail?: string) => boolean;
  /** Number of failed assertions so far. */
  readonly failures: number;
  /** Print the closing summary. Returns the failure count (caller decides the exit code). */
  report: () => number;
}

/** Create a checker that prints `✓`/`✗` per assertion and a closing summary. */
export function createChecker(label: string): Checker {
  let failures = 0;
  let total = 0;
  const emit = (prefix: string, name: string, ok: boolean, detail: string): boolean => {
    total++;
    if (!ok) failures++;
    const tag = prefix ? ` [${prefix}]` : '';
    console.log(`  ${ok ? '✓' : '✗'}${tag} ${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };
  return {
    check: (name, ok, detail = '') => emit('', name, ok, detail),
    checkp: (prefix, name, ok, detail = '') => emit(prefix, name, ok, detail),
    get failures() {
      return failures;
    },
    report() {
      console.log(`\n===== ${label}: ${failures === 0 ? `all ${total} checks passed` : `${failures}/${total} checks FAILED`} =====`);
      return failures;
    }
  };
}

/** Recursive structural diff of two plain values, as `path: old -> new` lines. */
export function varDiff(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) {
      out.push(`${p}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
      return;
    }
    const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
    for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${p}.${k}`);
  };
  walk(a, b, '$');
  return out;
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Spawn the built server over stdio and drive it exactly like a real MCP client would. */
export async function mcpClient(name = 'twine-play-check'): Promise<Client> {
  const client = new Client({ name, version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'dist', 'index.js')],
      cwd: REPO_ROOT,
      stderr: 'inherit',
      // Pass the environment through so TWMCP_* overrides reach the server. The SDK otherwise
      // sends a minimal default env, silently dropping e.g. TWMCP_DOWNLOAD_DIR.
      env: process.env as Record<string, string>
    })
  );
  return client;
}

/** Text of a tool result (all text parts joined; non-text parts become `[type]`). */
export function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? `[${c.type}]`).join('\n');
}

/**
 * Print a skip notice and return false when an external game (spike / smoke / clarity) is missing,
 * so `npm run smoke` on a machine without that game reports "skipped" instead of crashing.
 */
export function requireGame(gamePath: string, scriptName: string): boolean {
  if (!gamePath) {
    console.log(
      `\n${scriptName}: SKIPPED — no game selected.\n` +
        `  Pass one with TWMCP_GAME=/path/to/game.html (or a folder containing index.html).\n`
    );
    return false;
  }
  if (!existsSync(gamePath)) {
    console.log(`\n${scriptName}: SKIPPED — ${gamePath} does not exist.\n  Set TWMCP_GAME to a game you have locally.\n`);
    return false;
  }
  return true;
}
