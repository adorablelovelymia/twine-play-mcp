import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionManager, type GameSession, type Observation } from './session.js';
import { renderConsole, renderObservation, renderOpen } from './render.js';

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (body: string, isError = false): TextResult => ({
  content: [{ type: 'text', text: body }],
  ...(isError ? { isError: true } : {})
});

const errorText = (error: string, message?: string): TextResult =>
  text(`ERROR: ${error}${message ? ` — ${message}` : ''}`, true);

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
        'Open a Twine / interactive-fiction HTML game and return the first observation (passage text, choices, inputs, variables). ' +
        'Accepts a local .html file, a game folder (index.html or a single html is picked), or an http(s) URL. ' +
        'Local games are served over 127.0.0.1 so saves work. Use observe/choose afterwards.',
      inputSchema: {
        source: z.string().describe('Path to an .html file or folder, or an http(s) URL.'),
        headless: z.boolean().optional().describe('Run browser headless (default true). Set false to watch the game.'),
        seed: z.string().optional().describe('Seed SugarCube PRNG (State.prng) for reproducible runs; game must use SugarCube randomness to be deterministic.'),
        include_variables: z.boolean().optional().describe('Include story variables in observations (default true).'),
        block_trackers: z.boolean().optional().describe('Block analytics/tracker requests for a quiet session (default true).'),
        wait_timeout_ms: z.number().int().min(1000).max(120000).optional().describe('How long to wait for the game to settle after load (default 20000).')
      }
    },
    async ({ source, headless, seed, include_variables, wait_timeout_ms, block_trackers }) => {
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
        if (include_variables === false) {
          session.lastObservation = { ...obs, variables: null };
        }
        return text(
          renderOpen(session, session.lastObservation ?? obs) +
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
        'Read the current passage: text, numbered choices, input fields, status text and (optionally) story variables. ' +
        'Use since_last=true when polling to save tokens.',
      inputSchema: {
        game_id: gameId,
        since_last: z.boolean().optional().describe('If true and nothing changed, return only a short "no change" note (default true).'),
        include_variables: z.boolean().optional().describe('Include story variables (default true).'),
        include_status: z.boolean().optional().describe('Include status/caption text (default true).'),
        max_text_chars: z.number().int().min(200).max(100000).optional().describe('Cap passage text length (default 12000).')
      }
    },
    async ({ game_id, since_last, include_variables, include_status, max_text_chars }) => {
      try {
        const session = manager.get(game_id);
        const previous = session.lastObservation;
        const obs = await manager.observe(session, {
          includeVariables: include_variables ?? true,
          includeStatus: include_status ?? true,
          maxTextChars: max_text_chars ?? 12000
        });
        return text(observationText(session, obs, since_last ?? true, previous));
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
        'Click a choice in the current passage by its 1-based number from the last observation, or by (partial) label text. ' +
        'Waits for the game to settle and returns the new observation. Pass expected to guard against clicking the wrong link.',
      inputSchema: {
        game_id: gameId,
        choice: z.union([z.number(), z.string()]).describe('1-based choice number from the last observation, or label text (case-insensitive, may be partial if unambiguous).'),
        expected: z.string().optional().describe('Substring the clicked choice label must contain; fails safely if it does not match.'),
        allow_external: z.boolean().optional().describe('Allow following links that leave the game (default false, they are blocked).')
      }
    },
    async ({ game_id, choice, expected, allow_external }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.choose(session, choice, expected, allow_external ?? false);
        if (!res.ok) {
          return text(
            `ERROR: ${res.error}${res.message ? ` — ${res.message}` : ''}\n\n` + observationText(session, res.observation ?? session.lastObservation!, false, null),
            true
          );
        }
        return text(
          `Clicked: "${res.clicked?.label ?? ''}"${res.clicked?.target ? ` -> ${res.clicked.target}` : ''}\n\n` +
            observationText(session, res.observation!, false, null)
        );
      } catch (err) {
        return errorText('choose-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'wait',
    {
      title: 'Wait for the game',
      description: 'Wait for time (ms), for a text to appear, and/or for the page to settle, then return the new observation. Useful for timed passages and animations.',
      inputSchema: {
        game_id: gameId,
        ms: z.number().int().min(0).max(60000).optional().describe('Milliseconds to wait.'),
        for_text: z.string().optional().describe('Wait until this text appears anywhere on the page (up to timeout_ms).'),
        timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Timeout for for_text (default 15000).')
      }
    },
    async ({ game_id, ms, for_text, timeout_ms }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.wait(session, { ms, forText: for_text, timeoutMs: timeout_ms });
        const note = for_text ? (res.matched ? `Text found after ${res.waitedMs}ms.` : `Text NOT found within ${res.waitedMs}ms.`) : `Waited ${res.waitedMs}ms.`;
        return text(`${note}\n\n` + observationText(session, res.observation!, false, null));
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
        'Interact with input fields or keyboard: set a value on an input/textarea/select by ref, or press a key (e.g. "Enter", "ArrowUp"). ' +
        'Returns the new observation.',
      inputSchema: {
        game_id: gameId,
        ref: z.string().optional().describe('Input ref from the last observation (e.g. "i1"). Optional when only pressing a key.'),
        value: z.string().optional().describe('Value to set on the input/select.'),
        key: z.string().optional().describe('Keyboard key to press, e.g. "Enter", "a", "ArrowDown".')
      }
    },
    async ({ game_id, ref, value, key }) => {
      try {
        const session = manager.get(game_id);
        if (!ref && !key) return errorText('missing-argument', 'Provide ref (with value) and/or key.');
        if (key) {
          const res = await manager.press(session, key, ref);
          return text(`Pressed "${key}".\n\n` + observationText(session, res.observation!, false, null));
        }
        const res = await manager.interact(session, ref!, value);
        if (!res.ok) {
          return text(`ERROR: ${res.error}${res.message ? ` — ${res.message}` : ''}\n\n` + observationText(session, res.observation!, false, null), true);
        }
        return text(`Set ${ref} = "${value ?? ''}".\n\n` + observationText(session, res.observation!, false, null));
      } catch (err) {
        return errorText('interact-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'back',
    {
      title: 'Go back one step',
      description: 'Undo the last passage navigation when the story format supports it (SugarCube: Engine.backward). Returns the new observation.',
      inputSchema: { game_id: gameId }
    },
    async ({ game_id }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.back(session);
        if (!res.ok) return text(`ERROR: ${res.error}${res.message ? ` — ${res.message}` : ''}`, true);
        return text('Went back one step.\n\n' + observationText(session, res.observation!, false, null));
      } catch (err) {
        return errorText('back-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'restart',
    {
      title: 'Restart the game',
      description: 'Restart the story from the beginning (optionally with a new PRNG seed). Returns the first observation.',
      inputSchema: {
        game_id: gameId,
        seed: z.string().optional().describe('New SugarCube PRNG seed.')
      }
    },
    async ({ game_id, seed }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.restart(session, seed);
        return text(`Restarted${res.seeded ? ` with seed "${seed}"` : ''}.\n\n` + observationText(session, res.observation!, false, null));
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
      description: 'Restore a snapshot created by save_state and return the resulting observation.',
      inputSchema: {
        game_id: gameId,
        name: z.string().optional().describe('Snapshot name (default "default").')
      }
    },
    async ({ game_id, name }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.loadState(session, name ?? 'default');
        if (!res.ok) return errorText(res.error ?? 'load-failed', res.message);
        return text(`Loaded snapshot "${name ?? 'default'}".\n\n` + observationText(session, res.observation!, false, null));
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
        'Returns the new observation. Use choose() for passage choices instead.',
      inputSchema: {
        game_id: gameId,
        ref: z.string().optional().describe('UI ref from an observation (e.g. "u1" or "x3").'),
        text: z.string().optional().describe('Visible text of the target (case-insensitive, partial match; the shortest match wins).'),
        selector: z.string().optional().describe('CSS selector, if you know the exact element.'),
        exact: z.boolean().optional().describe('Require an exact text match (default false).')
      }
    },
    async ({ game_id, ref, text: uiText, selector, exact }) => {
      try {
        const session = manager.get(game_id);
        if (!ref && !uiText && !selector) return errorText('missing-argument', 'Provide ref, text or selector.');
        const res = await manager.clickUi(session, { ref, text: uiText, selector, exact });
        if (!res.ok) {
          return text(`ERROR: ${res.error}${res.message ? ` — ${res.message}` : ''}\n\n` + observationText(session, res.observation!, false, null), true);
        }
        const note = `Clicked UI: ${res.label ?? '(element)'}${res.matches && res.matches > 1 ? ` (${res.matches} matches; alternatives: ${(res.alternatives ?? []).slice(0, 4).join(' | ')})` : ''}`;
        return text(note + '\n\n' + observationText(session, res.observation!, false, null));
      } catch (err) {
        return errorText('click-ui-failed', String((err as Error)?.message ?? err));
      }
    }
  );

  server.registerTool(
    'upload_file',
    {
      title: 'Upload a file into the game',
      description:
        'Upload a local file (mod .zip, exported .save, image) into an <input type=file> in the game. ' +
        'Provide trigger_text/trigger_ref for buttons that open a picker ("Load from File…", "Import"), or let it target the file input directly.',
      inputSchema: {
        game_id: gameId,
        path: z.string().describe('Absolute path of the file on the machine running this MCP server.'),
        trigger_text: z.string().optional().describe('Visible text of the button that opens the file picker.'),
        trigger_ref: z.string().optional().describe('Ref of the trigger button (alternative to trigger_text).'),
        trigger_selector: z.string().optional().describe('CSS selector of the trigger button (e.g. "#saves-import").'),
        selector: z.string().optional().describe('CSS selector of an <input type=file> (used when no trigger is given).'),
        ref: z.string().optional().describe('Ref of a file input from inspect_ui (alternative to selector).')
      }
    },
    async ({ game_id, path, trigger_text, trigger_ref, trigger_selector, selector, ref }) => {
      try {
        const session = manager.get(game_id);
        const res = await manager.uploadFile(session, { path, ref, triggerText: trigger_text, triggerRef: trigger_ref, triggerSelector: trigger_selector, selector });
        if (!res.ok) {
          return text(`ERROR: ${res.error}${res.message ? ` — ${res.message}` : ''}\n\n` + observationText(session, res.observation!, false, null), true);
        }
        return text(`Uploaded "${path}".\n\n` + observationText(session, res.observation!, false, null));
      } catch (err) {
        return errorText('upload-failed', String((err as Error)?.message ?? err));
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
              `  ${inp.ref || '(file input — use upload_file)'} ${inp.kind}${inp.name ? ` name="${inp.name}"` : ''}${inp.value ? ` value="${String(inp.value).slice(0, 40)}"` : ''}` +
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
