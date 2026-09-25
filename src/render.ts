import type { GameSession, Observation } from './session.js';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface RenderOptions {
  step?: number;
  consoleCount?: number;
  sinceLast?: boolean;
  previous?: Observation | null;
}

export function renderObservation(obs: Observation, opts: RenderOptions = {}): string {
  const lines: string[] = [];

  const headerBits = [
    obs.format + (obs.formatVersion ? ` ${obs.formatVersion}` : ''),
    `step ${opts.step ?? 0}`,
    obs.engineState ? `engine=${obs.engineState}` : null,
    `passage: ${obs.passage ?? '?'}`
  ].filter(Boolean);
  lines.push(`[${headerBits.join(' · ')}]`);

  const unchanged =
    opts.sinceLast &&
    opts.previous &&
    opts.previous.text === obs.text &&
    opts.previous.passage === obs.passage &&
    (opts.previous.dialog?.text ?? '') === (obs.dialog?.text ?? '') &&
    JSON.stringify(opts.previous.choices.map((c) => c.label)) === JSON.stringify(obs.choices.map((c) => c.label));
  if (unchanged) {
    lines.push('(no change since last observation)');
  } else {
    lines.push('');
    lines.push(obs.text || '(empty passage)');
  }

  if (obs.dialog) {
    lines.push('');
    lines.push(`Dialog${obs.dialog.title ? ` — ${oneLine(obs.dialog.title)}` : ''}:`);
    if (obs.dialog.text) lines.push(obs.dialog.text.slice(0, 800));
    if (obs.dialog.buttons?.length) {
      lines.push(
        'Dialog buttons (use choose): ' +
          obs.dialog.buttons.map((b) => `${b.n}) ${oneLine(b.label)}`).join('  ')
      );
    }
  }

  lines.push('');
  if (obs.choices.length) {
    lines.push(`Choices (${obs.choices.length}):`);
    obs.choices.forEach((c, i) => {
      const bits = [`${i + 1}. ${oneLine(c.label)}`];
      if (c.target) bits.push(`-> ${c.target}`);
      if (c.dialog) bits.push('[dialog]');
      if (c.external) bits.push('[external]');
      if (c.disabled) bits.push('(disabled)');
      lines.push('  ' + bits.join(' '));
    });
  } else {
    lines.push('Choices (0): no visible choices.');
    if (obs.inputs.length) lines.push('  -> fill the inputs and/or press a key, then observe again.');
    else lines.push('  -> try wait, or this may be an ending / dead end.');
  }

  if (obs.ui?.length) {
    const total = obs.uiTotal ?? obs.ui.length;
    lines.push('');
    lines.push(
      'UI: ' +
        obs.ui.map((u) => `${oneLine(u.label)} [${u.ref}]`).join(' · ') +
        (total > obs.ui.length ? ` · … +${total - obs.ui.length} more (inspect_ui '#ui-bar')` : '')
    );
  }

  if (obs.inputs.length) {
    lines.push('');
    const total = obs.inputsTotal ?? obs.inputs.length;
    const offset = obs.inputsOffset ?? 0;
    const last = offset + obs.inputs.length;
    let head = `Inputs (${obs.inputs.length})`;
    if (total > obs.inputs.length) {
      head = last > 0 ? `Inputs (${offset + 1}-${last} of ${total})` : `Inputs (none in this window of ${total})`;
      if (total > last) head += ` — pass inputs_offset=${last} for the rest`;
    }
    lines.push(head + (obs.inputs.length ? ':' : ''));
    for (const inp of obs.inputs) {
      const bits = [`${inp.ref} ${inp.kind}`];
      if (inp.label) bits.push(`"${inp.label.slice(0, 50)}"`);
      if (inp.name) bits.push(`name="${inp.name}"`);
      if (inp.value && inp.kind !== 'checkbox' && inp.kind !== 'radio') bits.push(`value="${inp.value.slice(0, 60)}"`);
      if (inp.checked !== undefined) bits.push(inp.checked ? '[checked]' : '[unchecked]');
      if (inp.placeholder) bits.push(`placeholder="${inp.placeholder.slice(0, 60)}"`);
      if (inp.options?.length) bits.push(`options=[${inp.options.map((o) => o.label).join(' | ').slice(0, 200)}]`);
      if (inp.dialog) bits.push('[dialog]');
      lines.push('  ' + bits.join(' '));
    }
  }

  if (obs.status) {
    lines.push('');
    lines.push('Status:');
    lines.push(obs.status);
  }

  if (obs.variables && typeof obs.variables === 'object') {
    let json: string;
    try {
      json = JSON.stringify(obs.variables);
    } catch {
      json = '(unserializable)';
    }
    if (json && json !== '{}' && json !== 'null') {
      const capped = json.length > 2000 ? json.slice(0, 2000) + ` … [${json.length} chars total]` : json;
      lines.push('');
      lines.push('Variables: ' + capped);
    }
  }

  if (opts.consoleCount) {
    lines.push('');
    lines.push(`⚠ ${opts.consoleCount} console/network issue(s) captured — call get_console_errors for details.`);
  }

  return lines.join('\n');
}

export function renderOpen(session: GameSession, obs: Observation): string {
  const story = obs.story ?? {};
  const lines = [
    `Opened game "${session.id}" (${session.source})`,
    `Story: ${story.title ?? obs.title ?? '(unknown)'} · Format: ${story.format ?? obs.format}${story.formatVersion ? ' ' + story.formatVersion : ''}` +
      (story.ifid ? ` · ifid: ${story.ifid}` : ''),
    session.seed ? `PRNG seed: ${session.seed}` : null,
    session.server ? `Served from: ${session.server.baseUrl}` : `URL: ${session.entryUrl}`,
    '',
    renderObservation(obs, { step: 0 })
  ].filter((l) => l !== null);
  return lines.join('\n');
}

export function renderConsole(entries: Array<{ type: string; text: string; location?: string; at: number }>): string {
  if (!entries.length) return 'No console errors or warnings captured.';
  return entries
    .map((e, i) => {
      const loc = e.location ? ` @ ${e.location}` : '';
      return `${i + 1}. [${e.type}] ${oneLine(e.text)}${loc}`;
    })
    .join('\n');
}
