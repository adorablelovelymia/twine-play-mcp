import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionManager, type ChoiceInfo, type DialogInfo, type GameSession, type Observation } from './session.js';
import { renderConsole, renderObservation, renderOpen } from './render.js';

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (body: string, isError = false): TextResult => ({
  content: [{ type: 'text', text: body }],
  ...(isError ? { isError: true } : {})
});

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const errorText = (error: string, message?: string): TextResult =>
  text(`ERROR: ${error}${message ? ` — ${message}` : ''}`, true);

/** Compact error: no full observation dump, just the message + an optional hint + what can be chosen right now. */
function errResult(
  code: string,
  message?: string,
  extra?: { hint?: string; choices?: ChoiceInfo[]; dialog?: DialogInfo | null; passage?: string | null }
): TextResult {
  const lines = [`ERROR: ${code}${message ? ` — ${message}` : ''}`];
  if (extra?.hint) lines.push(`Hint: ${extra.hint}`);
  if (extra?.passage) lines.push(`(still at passage: ${extra.passage})`);
  const cs = extra?.choices ?? [];
  if (cs.length) {
    const shown = cs
      .slice(0, 12)
      .map((c, i) => `${i + 1}) ${oneLine(c.label)}${c.disabled ? ' (disabled)' : ''}${c.dialog ? ' [dialog]' : ''}`);
    lines.push(`Available choices: ${shown.join('  ')}${cs.length > 12 ? `  … +${cs.length - 12} more` : ''}`);
  }
  if (extra?.dialog?.buttons?.length) {
    lines.push('Dialog buttons: ' + extra.dialog.buttons.map((b) => `${b.n}) ${oneLine(b.label)}`).join('  '));
  }
  return text(lines.join('\n').slice(0, 2500), true);
}

/** Structured observation for format:"json" callers (returned as a JSON string; use JSON.parse). */
function jsonPayload(session: GameSession, obs: Observation, action?: Record<string, unknown>): string {
  return JSON.stringify({
    ok: true,
    passage: obs.passage,
    format: obs.format,
    step: session.step,
    engineState: obs.engineState,
    text: obs.text,
    choices: obs.choices.map((c, i) => ({
      n: i + 1,
      label: c.label,
      target: c.target,
      dialog: !!c.dialog,
      disabled: !!c.disabled,
      external: !!c.external
    })),
    inputs: obs.inputs.map((i) => ({
      ref: i.ref,
      kind: i.kind,
      label: i.label ?? null,
      name: i.name,
      value: i.value,
      checked: i.checked ?? null,
      dialog: !!i.dialog
    })),
    inputsTotal: obs.inputsTotal ?? obs.inputs.length,
    inputsOffset: obs.inputsOffset ?? 0,
    ui: obs.ui.map((u) => ({ ref: u.ref, label: u.label })),
    uiTotal: obs.uiTotal ?? obs.ui.length,
    dialog: obs.dialog ? { title: obs.dialog.title, text: obs.dialog.text, buttons: obs.dialog.buttons } : null,
    status: obs.status,
    action: action ?? null
  });
}

function observationResult(
  session: GameSession,
  obs: Observation,
  opts: { format?: 'text' | 'json'; prefix?: string; sinceLast?: boolean; previous?: Observation | null; action?: Record<string, unknown> } = {}
): TextResult {
  if (opts.format === 'json') return text(jsonPayload(session, obs, opts.action));
  const body = observationText(session, obs, opts.sinceLast ?? false, opts.previous ?? null);
  return text((opts.prefix ? opts.prefix + '\n\n' : '') + body);
}

const formatParam = z
  .enum(['text', 'json'])
  .optional()
  .describe('Output format: "text" (default, human-readable) or "json" (JSON string for programmatic use).');


const gameId = z.string().describe('Session id returned by open_game.');

function consoleErrors(session: GameSession): number {
  return session.console.filter((c) => c.type !== 'warning').length;
}

function observationText(session: GameSession, obs: Observation, sinceLast: boolean, previous: Observation | null): string {
  return renderObservation(obs, {
    step: session.step,
    consoleCount: consoleErrors(session),
    sinceLast,
    previous
  });
}

export function buildServer(manager: SessionManager): McpServer {
  const server = new McpServer({ name: 'twine-play-mcp', version: '0.1.0' });

  server.registerTool(
    'open_game',
    {
      title: 'Open a Twine game',
      description:
        'Open a Twine / interactive-fiction HTML game and return the first observation (passage text, numbered choices, inputs, dialog). ' +
        'Accepts a local .html file, a game folder (index.html or a single html is picked), or an http(s) URL. ' +
        'Local games are served over 127.0.0.1 so saves work. ' +
        'Returns a formatted text observation (string); pass format:"json" for a JSON string. ' +
        'Inputs are listed in windows of 40 (see inputs_offset/inputs_limit on observe) and find_ui(text) locates any control by label.',
      inputSchema: {
        source: z.string().describe('Path to an .html file or folder, or an http(s) URL.'),
        headless: z.boolean().optional().describe('Run browser headless (default true). Set false to watch the game.'),
        seed: z.string().optional().describe('Seed SugarCube PRNG (State.prng) for reproducible runs; game must use SugarCube randomness to be deterministic.'),
        include_variables: z.boolean().optional().describe('Embed the (truncated) story variables in the observation (default false; prefer get_variables for specific keys).'),
        format: formatParam,
        block_trackers: z.boolean().optional().describe('Block analytics/tracker requests for a quiet session (default true).'),
        wait_timeout_ms: z.number().int().min(1000).max(120000).optional().describe('How long to wait for the game to settle after load (default 20000).')
      }
    },
    async ({ source, headless, seed, include_variables, format, wait_timeout_ms, block_trackers }) => {
      try {
        const session = await manager.open({
          source,
          headless: headless ?? true,
          seed,
          waitTimeoutMs: wait_timeout_ms,
          blockTrackers: block_trackers ?? true
        });
        const obs = session.lastObservation;
        if (!obs) return errorText('no-observation', 'Game loaded but produced no observation.');
        if (include_variables !== true) {
          session.lastObservation = { ...obs, variables: null };
        }
        const finalObs = session.lastObservation ?? obs;
        if (format === 'json') return observationResult(session, finalObs, { format });
        return text(
          renderOpen(session, finalObs) +
            '\n\nTip: choose(game_id, 1) clicks the first choice; every action returns a fresh observation.'
        );
      } catch (err) {
        return errorText('open-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'observe',
    {
      title: 'Observe current game state',
      description:
        'Read the current passage: text, numbered choices, input fields, dialog state and status text. ' +
        'Returns a formatted text observation (string); pass format:"json" for a JSON string. ' +
        'Inputs are paginated in windows of 40: when truncated, the header says e.g. "Inputs (41-80 of 132)" — call again with inputs_offset=80. ' +
        'Use find_ui(text) to jump to a specific control, get_variables for specific story variables, and since_last=true when polling to save tokens.',
      inputSchema: {
        game_id: gameId,
        since_last: z.boolean().optional().describe('If true and nothing changed, return only a short "no change" note (default true; ignored in json format).'),
        include_variables: z.boolean().optional().describe('Embed the (truncated) story variables (default false; prefer get_variables for specific keys).'),
        include_status: z.boolean().optional().describe('Include status/caption text (default true).'),
        max_text_chars: z.number().int().min(200).max(100000).optional().describe('Cap passage text length (default 12000).'),
        inputs_offset: z.number().int().min(0).max(1000).optional().describe('Skip this many inputs before listing (default 0).'),
        inputs_limit: z.number().int().min(1).max(500).optional().describe('How many inputs to list (default 40).'),
        format: formatParam
      }
    },
    async ({ game_id, since_last, include_variables, include_status, max_text_chars, inputs_offset, inputs_limit, format }) => {
      try {
        const session = manager.get(game_id);
        const previous = session.lastObservation;
        const obs = await manager.observe(session, {
          includeVariables: include_variables ?? false,
          includeStatus: include_status ?? true,
          maxTextChars: max_text_chars ?? 12000,
          inputsOffset: inputs_offset ?? 0,
          inputsLimit: inputs_limit ?? 40
        });
        return observationResult(session, obs, { format, sinceLast: since_last ?? true, previous });
      } catch (err) {
        return errorText('observe-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'choose',
    {
      title: 'Click a choice',
      description:
        'Click a passage choice by its 1-based number from the last observation, or by (partial) label text. ' +
        'Numbered choices include dialog buttons (tagged [dialog] in observations) — so choose() answers dialogs too. ' +
        'Waits for the game to settle and returns the new observation. Pass expected to guard against clicking the wrong link.',
      inputSchema: {
        game_id: gameId,
        choice: z.union([z.number(), z.string()]).describe('1-based choice number from the last observation, or label text (case-insensitive, may be partial if unambiguous).'),
        expected: z.string().optional().describe('Substring the clicked choice label must contain; fails safely if it does not match.'),
        allow_external: z.boolean().optional().describe('Allow following links that leave the game (default false, they are blocked).'),
        format: formatParam
      }
    },
    async ({ game_id, choice, expected, allow_external, format }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.choose(session, choice, expected, allow_external ?? false);
        if (!res.ok) {
          const last = session.lastObservation;
          const hints: Record<string, string> = {
            'no-such-choice':
              'Use a number from the last observation, or observe() to refresh labels. Dialog buttons are listed in the choices with [dialog].',
            'bad-index': 'Number must be within 1..N of the last observation.',
            'stale-ref': 'The passage changed; call observe() and retry.',
            'ambiguous-choice': 'Use the 1-based number instead of a short label.',
            'external-link-blocked': 'Pass allow_external=true if the link is intended.',
            'expectation-failed': 'The label did not contain the expected text; nothing was clicked.'
          };
          return errResult(res.error ?? 'choose-failed', res.message, {
            hint: hints[res.error ?? ''] ?? 'Call observe() to see the current choices.',
            choices: last?.choices,
            dialog: last?.dialog ?? null,
            passage: last?.passage ?? null
          });
        }
        return observationResult(session, res.observation!, {
          format,
          prefix: `Clicked: "${res.clicked?.label ?? ''}"${res.clicked?.target ? ` -> ${res.clicked.target}` : ''}`,
          action: { label: res.clicked?.label ?? null, target: res.clicked?.target ?? null, kind: res.clicked?.kind ?? null }
        });
      } catch (err) {
        return errorText('choose-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'wait',
    {
      title: 'Wait for the game',
      description: 'Wait for time (ms), for a text to appear, and/or for the page to settle, then return the new observation. Useful for timed passages and animations. Returns text; pass format:"json" for a JSON string.',
      inputSchema: {
        game_id: gameId,
        ms: z.number().int().min(0).max(60000).optional().describe('Milliseconds to wait.'),
        for_text: z.string().optional().describe('Wait until this text appears anywhere on the page (up to timeout_ms).'),
        timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Timeout for for_text (default 15000).'),
        format: formatParam
      }
    },
    async ({ game_id, ms, for_text, timeout_ms, format }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.wait(session, { ms, forText: for_text, timeoutMs: timeout_ms });
        const note = for_text ? (res.matched ? `Text found after ${res.waitedMs}ms.` : `Text NOT found within ${res.waitedMs}ms.`) : `Waited ${res.waitedMs}ms.`;
        return observationResult(session, res.observation!, { format, prefix: note });
      } catch (err) {
        return errorText('wait-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'interact',
    {
      title: 'Fill an input or press a key',
      description:
        'Interact with input fields or the keyboard: set a value on an input/textarea/select by ref, or press a key (e.g. "Enter", "ArrowUp"). ' +
        'For radios/checkboxes pass value "true" or "false". Inputs are refs from the last observation (or find_ui). ' +
        'Returns the new observation; pass format:"json" for a JSON string.',
      inputSchema: {
        game_id: gameId,
        ref: z.string().optional().describe('Input ref from the last observation (e.g. "i1"). Optional when only pressing a key.'),
        value: z.string().optional().describe('Value to set on the input/select. Radios/checkboxes: "true" or "false".'),
        key: z.string().optional().describe('Keyboard key to press, e.g. "Enter", "a", "ArrowDown".'),
        format: formatParam
      }
    },
    async ({ game_id, ref, value, key, format }) => {
      try {
        const session = manager.get(game_id);
        if (!ref && !key) return errorText('missing-argument', 'Provide ref (with value) and/or key.');
        if (key) {
          const res = await manager.press(session, key, ref);
          return observationResult(session, res.observation!, { format, prefix: `Pressed "${key}".` });
        }
        const res = await manager.interact(session, ref!, value);
        if (!res.ok) {
          return errResult(res.error ?? 'interact-failed', res.message, {
            hint:
              res.error === 'stale-ref'
                ? 'Refs are refreshed by every observe(); call observe() and use the new ref (or find_ui to locate it).'
                : 'Check the input ref in the last observation; find_ui(text) can locate controls by label.',
            passage: session.lastObservation?.passage ?? null
          });
        }
        return observationResult(session, res.observation!, { format, prefix: `Set ${ref} = "${value ?? ''}".` });
      } catch (err) {
        return errorText('interact-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'back',
    {
      title: 'Go back one step',
      description: 'Undo the last passage navigation when the story format supports it (SugarCube: Engine.backward). Returns the new observation (text; format:"json" for JSON).',
      inputSchema: { game_id: gameId, format: formatParam }
    },
    async ({ game_id, format }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.back(session);
        if (!res.ok) return errorText(res.error ?? 'back-failed', res.message);
        return observationResult(session, res.observation!, { format, prefix: 'Went back one step.' });
      } catch (err) {
        return errorText('back-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'restart',
    {
      title: 'Restart the game',
      description: 'Restart the story from the beginning (optionally with a new PRNG seed). Returns the first observation (text; format:"json" for JSON).',
      inputSchema: {
        game_id: gameId,
        seed: z.string().optional().describe('New SugarCube PRNG seed.'),
        format: formatParam
      }
    },
    async ({ game_id, seed, format }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.restart(session, seed);
        return observationResult(session, res.observation!, { format, prefix: `Restarted${res.seeded ? ` with seed "${seed}"` : ''}.` });
      } catch (err) {
        return errorText('restart-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'save_state',
    {
      title: 'Save an in-session snapshot',
      description:
        'Save the full game state under a name so you can branch: save -> try a path -> load_state -> try another path. ' +
        'Supported natively by SugarCube; other formats report unsupported.',
      inputSchema: {
        game_id: gameId,
        name: z.string().optional().describe('Snapshot name (default "default").')
      }
    },
    async ({ game_id, name }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.saveState(session, name ?? 'default');
        if (!res.ok) return errorText(res.error ?? 'save-failed', res.message);
        return text(`Saved snapshot "${name ?? 'default'}" (${res.bytes} chars). Snapshots in this session: ${[...session.snapshots.keys()].join(', ')}.`);
      } catch (err) {
        return errorText('save-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'load_state',
    {
      title: 'Load an in-session snapshot',
      description: 'Restore a snapshot created by save_state and return the resulting observation (text; format:"json" for JSON).',
      inputSchema: {
        game_id: gameId,
        name: z.string().optional().describe('Snapshot name (default "default").'),
        format: formatParam
      }
    },
    async ({ game_id, name, format }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.loadState(session, name ?? 'default');
        if (!res.ok) return errorText(res.error ?? 'load-failed', res.message);
        return observationResult(session, res.observation!, { format, prefix: `Loaded snapshot "${name ?? 'default'}".` });
      } catch (err) {
        return errorText('load-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'click_ui',
    {
      title: 'Click UI outside the passage',
      description:
        'Click dialogs, sidebar buttons and menus (SAVES, OPTIONS, ModLoader banner, modal buttons) by ref, CSS selector or visible text. ' +
        'Text matching covers <label>-based controls too (SugarCube radio/checkbox options like "Jet black" or "Punch"); shortest match wins, exact=true for exact text. ' +
        'Returns the new observation (text; format:"json" for JSON). Use choose() for numbered passage choices and dialog buttons.',
      inputSchema: {
        game_id: gameId,
        ref: z.string().optional().describe('UI ref from an observation (e.g. "u1" or "x3").'),
        text: z.string().optional().describe('Visible text of the target (case-insensitive, partial match; the shortest match wins).'),
        selector: z.string().optional().describe('CSS selector, if you know the exact element.'),
        exact: z.boolean().optional().describe('Require an exact text match (default false).'),
        format: formatParam
      }
    },
    async ({ game_id, ref, text: uiText, selector, exact, format }) => {
      try {
        const session = manager.get(game_id);
        if (!ref && !uiText && !selector) return errorText('missing-argument', 'Provide ref, text or selector.');
        const res = await manager.clickUi(session, { ref, text: uiText, selector, exact });
        if (!res.ok) {
          return errResult(res.error ?? 'no-match', res.message, {
            hint:
              res.error === 'stale-ref'
                ? 'Refs are refreshed by observe(); call observe() again or use find_ui(text).'
                : 'Locate the control with find_ui(text) or pass a CSS selector. Numbered passage choices/dialog buttons use choose().',
            choices: session.lastObservation?.choices,
            passage: session.lastObservation?.passage ?? null
          });
        }
        const note = `Clicked UI: ${res.label ?? '(element)'}${res.matches && res.matches > 1 ? ` (${res.matches} matches; alternatives: ${(res.alternatives ?? []).slice(0, 4).join(' | ')})` : ''}`;
        return observationResult(session, res.observation!, { format, prefix: note, action: { label: res.label ?? null } });
      } catch (err) {
        return errorText('click-ui-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'find_ui',
    {
      title: 'Find a control by text',
      description:
        'Search visible controls (buttons, links, labels, inputs) by label text and/or input name; returns refs usable with click_ui(ref), interact(ref, value) and upload_file(ref). ' +
        'This is the fastest way to reach radio/checkbox options (e.g. "Jet black", "Punch") and any input beyond the 40-item observation window. ' +
        'Results are capped by limit; no game state changes.',
      inputSchema: {
        game_id: gameId,
        text: z.string().optional().describe('Label text to search for (case-insensitive, partial by default).'),
        exact: z.boolean().optional().describe('Require an exact label match (default false).'),
        kind: z.string().optional().describe('Filter by kind: button, link, label, input, radio, checkbox, select, textarea.'),
        name: z.string().optional().describe('Filter by input name attribute (exact).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max matches to return (default 20).')
      }
    },
    async ({ game_id, text: q, exact, kind, name, limit }) => {
      try {
        const session = manager.get(game_id);
        if (!q && !name) return errorText('missing-argument', 'Provide text and/or name to search for.');
        const res = await manager.findUi(session, { text: q, exact, kind, name, limit });
        if (!res.ok) return errorText(res.error ?? 'find-failed', res.message);
        const matches = res.matches ?? [];
        if (!matches.length) {
          return text(
            `No visible control matches${q ? ` "${q}"` : ''}${name ? ` name="${name}"` : ''}. ` +
              'Try observe() for numbered inputs/choices, or inspect_ui(selector) for panels.'
          );
        }
        const lines = [
          `Found ${matches.length}${res.total && res.total > matches.length ? ` of ${res.total}` : ''} control(s) — click_ui(ref) to click, interact(ref, value) to set:`
        ];
        for (const m of matches) {
          const bits = [`[${m.ref}]`, m.kind];
          if (m.label) bits.push(`"${m.label.slice(0, 50)}"`);
          if (m.name) bits.push(`name="${m.name}"`);
          if (m.checked !== undefined) bits.push(m.checked ? '[checked]' : '[unchecked]');
          if (m.disabled) bits.push('(disabled)');
          if (m.value) bits.push(`value="${m.value.slice(0, 40)}"`);
          lines.push('  ' + bits.join(' '));
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorText('find-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'get_variables',
    {
      title: 'Read story variables',
      description:
        'Read specific story variables (SugarCube State.variables) by dot path, e.g. ["haircolour", "background", "player.background"]. ' +
        'Accepts "V.x", "variables.x" or plain "x". With no paths, returns a shallow summary of the top-level keys. Output is JSON.',
      inputSchema: {
        game_id: gameId,
        paths: z.array(z.string()).max(50).optional().describe('Dot paths to read (default: top-level key summary).')
      }
    },
    async ({ game_id, paths }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.getVariables(session, paths);
        if (!res.ok) return errorText(res.error ?? 'variables-failed', res.message);
        return text(JSON.stringify(res));
      } catch (err) {
        return errorText('variables-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'upload_file',
    {
      title: 'Upload a file into the game',
      description:
        'Upload a local file (mod .zip, exported .save, image) into an <input type=file> in the game. ' +
        'Provide trigger_text/trigger_ref for buttons that open a picker ("Load from File…", "Import"), or let it target the file input directly. ' +
        'If a hardcoded selector like #saves-import does not exist in the build, use find_ui("Load from File") and pass its ref as trigger_ref. ' +
        'Returns the new observation (text; format:"json" for JSON).',
      inputSchema: {
        game_id: gameId,
        path: z.string().describe('Absolute path of the file on the machine running this MCP server.'),
        trigger_text: z.string().optional().describe('Visible text of the button that opens the file picker.'),
        trigger_ref: z.string().optional().describe('Ref of the trigger button (alternative to trigger_text).'),
        trigger_selector: z.string().optional().describe('CSS selector of the trigger button (e.g. "#saves-import").'),
        selector: z.string().optional().describe('CSS selector of an <input type=file> (used when no trigger is given).'),
        ref: z.string().optional().describe('Ref of a file input from inspect_ui (alternative to selector).'),
        format: formatParam
      }
    },
    async ({ game_id, path, trigger_text, trigger_ref, trigger_selector, selector, ref, format }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.uploadFile(session, { path, ref, triggerText: trigger_text, triggerRef: trigger_ref, triggerSelector: trigger_selector, selector });
        if (!res.ok) {
          return errResult(res.error ?? 'upload-failed', res.message, {
            hint:
              res.error === 'no-file-input'
                ? 'Find the import button with find_ui("Load from File") / find_ui("Import") and pass its ref as trigger_ref.'
                : 'Check the file path and the trigger selector/ref.',
            passage: session.lastObservation?.passage ?? null
          });
        }
        return observationResult(session, res.observation!, { format, prefix: `Uploaded "${path}".`, action: { upload: path } });
      } catch (err) {
        return errorText('upload-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'download_file',
    {
      title: 'Save a captured browser download to a file',
      description:
        'Browser file control for any game: every download is captured into the tool\'s download folder (see list_downloads). ' +
        'Three modes: (a) pass trigger_text/trigger_ref/trigger_selector to click the game\'s download button and take that file; ' +
        '(b) pass name or index to take an already-captured file from the folder; (c) pass none of those to take the newest file in the folder. ' +
        'Without `path` the file stays in the download folder (path = its location); with `path` (a file or a directory) a copy is placed there too. ' +
        'Returns the path, size and the new observation.',
      inputSchema: {
        game_id: gameId,
        path: z.string().optional().describe('Destination file or directory (default <cwd>/downloads/<name>).'),
        trigger_text: z.string().optional().describe('Visible text of the button that starts the download (optional).'),
        trigger_ref: z.string().optional().describe('Ref of the download button (alternative to trigger_text).'),
        trigger_selector: z.string().optional().describe('CSS selector of the download button (alternative to trigger_text).'),
        name: z.string().optional().describe('Name of an already-captured file from list_downloads (exact, suffix, or unique substring).'),
        index: z.number().int().min(1).max(200).optional().describe('1-based index from list_downloads (newest first).'),
        timeout_ms: z.number().int().min(1000).max(120000).optional().describe('How long to wait for the download after clicking (default 30000).'),
        format: formatParam
      }
    },
    async ({ game_id, path: dest, trigger_text, trigger_ref, trigger_selector, name, index, timeout_ms, format }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.downloadFile(session, {
          path: dest,
          ref: trigger_ref,
          text: trigger_text,
          selector: trigger_selector,
          name,
          index,
          timeoutMs: timeout_ms
        });
        if (!res.ok) {
          return errResult(res.error ?? 'download-failed', res.message, {
            hint:
              res.error === 'no-download'
                ? 'Run list_downloads to see captured files, or pass trigger_text/trigger_ref to click the game\'s download button.'
                : 'Check the file name/index (list_downloads) or the trigger.',
            passage: session.lastObservation?.passage ?? null
          });
        }
        const prefix = `Saved "${res.filename ?? 'file'}" -> ${res.path} (${res.bytes ?? 0} B${res.copied ? ', copied' : ''}${res.overwrote ? ', overwrote existing file' : ''})`;
        return observationResult(session, res.observation!, {
          format,
          prefix,
          action: { path: res.path ?? null, source: res.source ?? null, filename: res.filename ?? null, bytes: res.bytes ?? 0, copied: !!res.copied }
        });
      } catch (err) {
        return errorText('download-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'list_downloads',
    {
      title: 'List captured browser downloads',
      description:
        'List files captured from the browser into the tool\'s download folder (any game; the folder persists across sessions and MCP restarts). ' +
        'Use download_file(name|index, path) to copy one anywhere. Shows name, size, capture time and the absolute folder path.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Max files to list (default 20, newest first).')
      }
    },
    async ({ limit }) => {
      try {
        const res = await manager.listDownloads(limit ?? 20);
        if (!res.files.length) {
          return text(`Download folder: ${res.dir}\n(empty — trigger a download first, e.g. the game's save/export button)`);
        }
        const lines = [
          `Download folder: ${res.dir} (${res.total} file${res.total === 1 ? '' : 's'}, newest first${res.total > res.files.length ? `, showing ${res.files.length}` : ''}):`
        ];
        res.files.forEach((f, i) => {
          const when = new Date(f.mtime).toISOString().replace('T', ' ').slice(0, 16);
          lines.push(`  ${i + 1}. ${f.name} — ${f.bytes} B — ${when}`);
        });
        lines.push('Use download_file(name=..., path=...) to copy one anywhere.');
        return text(lines.join('\n'));
      } catch (err) {
        return errorText('list-downloads-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'inspect_ui',
    {
      title: 'Inspect a UI panel',
      description:
        'Inspect DOM outside the passage. Pass a CSS selector to get its text, buttons (with refs usable in click_ui) and inputs (file inputs usable in upload_file). ' +
        'Without a selector, lists overlay panels (mod GUIs, dev panels) that contain buttons or file inputs.',
      inputSchema: {
        game_id: gameId,
        selector: z.string().optional().describe('CSS selector of the panel to inspect; omit to discover overlay panels.')
      }
    },
    async ({ game_id, selector }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.inspectUi(session, selector);
        if (!res.ok) return errorText(res.error ?? 'inspect-failed', res.message);
        if (!selector) {
          const cands = (res.candidates ?? []) as Array<Record<string, unknown>>;
          if (!cands.length) return text('No overlay panels discovered. Pass a CSS selector to inspect a specific element.');
          return text(
            'Panels:\n' +
              cands
                .map(
                  (c, i) =>
                    `${i + 1}. ${c.frame ? '[iframe] ' : ''}${c.selector} — ${c.buttons} buttons, ${c.inputs} inputs, ${c.fileInputs} file inputs: ${String(c.text ?? '').slice(0, 90)}`
                )
                .join('\n') +
              '\n\nTip: upload_file without a selector searches all frames for a file input; click_ui by text also works inside iframes.'
          );
        }
        const lines = [`# ${res.selector}${res.frame ? ' (iframe)' : ''}`, res.text ?? ''];
        if (res.buttons?.length) {
          lines.push('', 'Buttons:');
          res.buttons.forEach((b, i) => lines.push(`  ${i + 1}. ${b.label}${b.ref ? ` [${b.ref}]` : ' (use click_ui text)'}`));
        }
        if (res.inputs?.length) {
          lines.push('', 'Inputs:');
          for (const inp of res.inputs) {
            lines.push(
              `  ${inp.ref || '(file input — use upload_file)'} ${inp.kind}${inp.label ? ` "${inp.label.slice(0, 40)}"` : ''}${inp.name ? ` name="${inp.name}"` : ''}${inp.value ? ` value="${String(inp.value).slice(0, 40)}"` : ''}` +
                (inp.checked !== undefined ? ` checked=${inp.checked}` : '')
            );
          }
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorText('inspect-ui-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot the game',
      description: 'Take a PNG screenshot of the game viewport. Useful for canvas/image-driven games and visual QA. Pass path to save it to a file (returns the path instead of the image).',
      inputSchema: {
        game_id: gameId,
        path: z.string().optional().describe('Optional output file path; when set, the PNG is written there and only the path is returned.')
      }
    },
    async ({ game_id, path }) => {
      try {
        const session = manager.get(game_id);
        const buf = await manager.screenshot(session, path);
        if (path) return text(`Screenshot saved: ${path} (${buf.length} bytes)`);
        return { content: [{ type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' }] };
      } catch (err) {
        return errorText('screenshot-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'get_console_errors',
    {
      title: 'Get console errors',
      description: 'Return JavaScript errors/warnings captured from the page (useful for playtesting / QA).',
      inputSchema: {
        game_id: gameId,
        clear: z.boolean().optional().describe('Clear the buffer after reading (default false).')
      }
    },
    async ({ game_id, clear }) => {
      try {
        const session = manager.get(game_id);
        const body = renderConsole(session.console);
        if (clear) session.console = [];
        return text(body);
      } catch (err) {
        return errorText('console-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'get_journal',
    {
      title: 'Get the play journal',
      description:
        'Return this session\'s action history: every passage visited and every choice taken (including back/load events). ' +
        'Useful to summarise a playthrough, resume a run, or report coverage for QA.',
      inputSchema: {
        game_id: gameId,
        limit: z.number().int().min(1).max(500).optional().describe('Show the last N entries (default 50).'),
        clear: z.boolean().optional().describe('Clear the journal after reading (default false).')
      }
    },
    async ({ game_id, limit, clear }) => {
      try {
        const session = manager.get(game_id);
        const entries = session.journal;
        if (!entries.length) return text('Journal is empty (no actions taken yet).');
        const shown = entries.slice(-(limit ?? 50));
        const visited = new Set(entries.map((e) => e.passage).filter(Boolean));
        const lines = shown.map(
          (e) => `#${e.step} ${e.passage ?? '?'} — ${e.action}${e.target ? ` -> ${e.target}` : ''}`
        );
        const header = `Journal: ${entries.length} action(s), ${visited.size} distinct passage(s) visited. Showing last ${shown.length}.`;
        if (clear) session.journal = [];
        return text(header + '\n' + lines.join('\n'));
      } catch (err) {
        return errorText('journal-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'list_games',
    {
      title: 'List open games',
      description: 'List the currently open game sessions with their id, source, story title and step count.',
      inputSchema: {}
    },
    async () => {
      if (!manager.sessions.size) return text('No open games.');
      const lines = [...manager.sessions.values()].map(
        (s) =>
          `${s.id} · ${s.lastObservation?.story?.title ?? s.lastObservation?.title ?? '(unknown)'} · ${s.lastObservation?.format ?? '?'} · step ${s.step} · ${s.source}`
      );
      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'close_game',
    {
      title: 'Close a game',
      description: 'Close the browser tab and static server for a game session.',
      inputSchema: { game_id: gameId }
    },
    async ({ game_id }) => {
      try {
        const ok = await manager.close(game_id);
        return text(ok ? `Closed ${game_id}.` : `No such game: ${game_id}.`, !ok);
      } catch (err) {
        return errorText('close-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  return server;
}
