import type { GameSession, Observation } from './session.js';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * FNV-1a over the rendered parts of an observation.
 *
 * Used to answer one question cheaply: "would re-rendering this passage produce the same
 * text, status and sidebar as last time?" Twine re-renders PassageHeader / PassageFooter /
 * StoryCaption on every passage, so a hub-and-spoke story repeats 15-30 KB of markup per
 * step; a fingerprint lets the renderer collapse that to a one-line handle.
 */
function fingerprint(parts: Array<string | null | undefined>): string {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = part ?? '';
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** What a session remembers about the last full render of one passage. */
export interface PassageDigestEntry {
  fingerprint: string;
  step: number;
}

export interface RenderOptions {
  step?: number;
  consoleCount?: number;
  sinceLast?: boolean;
  previous?: Observation | null;
  /** Per-session passage cache: an identical re-render collapses to a one-line handle. */
  digest?: Map<string, PassageDigestEntry>;
  /** 'diff' (default) prints only what changed; 'full' prints the whole variable tree. */
  variablesMode?: 'diff' | 'full';
  /**
   * The last variable tree the session read, for diffing.
   *
   * Separate from previous, because action results are lean: diffing a variables-carrying
   * observation against a lean one has no baseline, which silently turned every "diff"
   * into a full dump.
   */
  previousVariables?: unknown;
  /** Escape hatch: force the passage text out even when it is a cacheable repeat. */
  forceFullText?: boolean;
}

const uiKey = (o: Observation) =>
  JSON.stringify((o.ui ?? []).map((u) => u.label ?? null));

/** Compare two observations for "nothing the agent could act on has changed". */
function isUnchanged(previous: Observation, obs: Observation): boolean {
  if (previous.text !== obs.text || previous.passage !== obs.passage) return false;
  if ((previous.status ?? '') !== (obs.status ?? '')) return false;
  if ((previous.dialog?.text ?? '') !== (obs.dialog?.text ?? '')) return false;
  // Choices/inputs/ui are re-numbered on every observe, so compare them by label only.
  type Labeled = { label?: string | null };
  const byLabel = (o: Observation, key: 'choices' | 'inputs' | 'ui') =>
    JSON.stringify((o[key] as Labeled[] | undefined)?.map((x) => x.label ?? null) ?? []);
  if (byLabel(previous, 'choices') !== byLabel(obs, 'choices')) return false;
  if (byLabel(previous, 'inputs') !== byLabel(obs, 'inputs')) return false;
  if (byLabel(previous, 'ui') !== byLabel(obs, 'ui')) return false;
  const dialogButtons = (o: Observation) => JSON.stringify(o.dialog?.buttons?.map((b) => b.label) ?? []);
  if (dialogButtons(previous) !== dialogButtons(obs)) return false;
  // Variables only count when BOTH observations actually carry them. Comparing against a
  // lean observation (include_variables:false) used to report a change on every toggle.
  if (previous.variables != null && obs.variables != null) {
    const varKey = (o: Observation) => {
      try {
        const json = JSON.stringify(o.variables);
        return json.length > 4000 ? `big:${json.length}` : json;
      } catch {
        return 'unserializable';
      }
    };
    if (varKey(previous) !== varKey(obs)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Variables: print the delta, not the tree
// ---------------------------------------------------------------------------

/** Flatten a variable tree to dot paths so diffs are per-key, not per-blob. */
function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    out[prefix] = value;
    return out;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!keys.length && prefix) {
    out[prefix] = Array.isArray(value) ? [] : {};
    return out;
  }
  for (const k of keys) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

const shortValue = (v: unknown): string => {
  let json: string;
  try {
    json = JSON.stringify(v) ?? 'null';
  } catch {
    return '(unserializable)';
  }
  return json.length > 60 ? `${json.slice(0, 60)}…` : json;
};

/**
 * SugarCube games routinely carry hundreds of variables (The Hundredth Floor: 302). Dumping
 * them costs ~7.6 KB per step while a typical step changes one key — a 18-byte diff. Printing
 * the delta is both cheaper AND more informative than the old truncated dump, which buried
 * the one key that actually moved past the 2000-char cut.
 */
function renderVariables(
  obs: Observation,
  baseline: unknown,
  mode: 'diff' | 'full'
): string | null {
  if (obs.variables == null) return null;
  const current = flatten(obs.variables);
  const keys = Object.keys(current);

  if (mode === 'full' || baseline == null) {
    let json: string;
    try {
      json = JSON.stringify(obs.variables);
    } catch {
      return 'Variables: (unserializable)';
    }
    if (!json || json === '{}' || json === 'null') return null;
    const capped =
      json.length > 2000
        ? `${json.slice(0, 2000)} … [${json.length} chars total — use engine(paths:[...]) or observe(variables:"full") for the rest]`
        : json;
    return `Variables: ${capped}`;
  }

  const prev = flatten(baseline);
  const changed: string[] = [];
  for (const k of keys) {
    const next = JSON.stringify(current[k]);
    if (JSON.stringify(prev[k]) !== next) changed.push(`${k}: ${shortValue(prev[k])} -> ${shortValue(current[k])}`);
  }
  for (const k of Object.keys(prev)) {
    if (!(k in current)) changed.push(`${k}: ${shortValue(prev[k])} -> (removed)`);
  }

  if (!changed.length) return `Variables: unchanged (${keys.length} keys)`;
  const body = changed.length > 40 ? `${changed.slice(0, 40).join(', ')} … +${changed.length - 40} more` : changed.join(', ');
  return `Variables Δ (${changed.length}): ${body}`;
}

// ---------------------------------------------------------------------------
// Observation rendering
// ---------------------------------------------------------------------------

export function renderObservation(obs: Observation, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  const previous = opts.previous ?? null;
  const step = opts.step ?? 0;

  // The format/version is a per-session constant; repeating it on every step is pure noise.
  const formatBit =
    previous && previous.format === obs.format && previous.formatVersion === obs.formatVersion
      ? null
      : obs.format + (obs.formatVersion ? ` ${obs.formatVersion}` : '');
  const headerBits = [
    formatBit,
    `step ${step}`,
    obs.engineState ? `engine=${obs.engineState}` : null,
    `passage: ${obs.passage ?? '?'}`
  ].filter(Boolean);
  lines.push(`[${headerBits.join(' · ')}]`);

  // Passage cache: the passage body and sidebar are byte-identical to a previous render, so
  // print a handle instead of the text. Choices still print in full — they are the part the
  // agent has to act on, and they are small next to the prose.
  //
  // Only collapse when the caller asked for a delta view (since_last). An explicit
  // observe(since_last:false) is a request for the passage itself, and answering it with a
  // handle would leave the agent holding no text at all.
  const bodyFp = fingerprint([obs.text, obs.status, uiKey(obs)]);
  const cached = obs.passage ? opts.digest?.get(obs.passage) : undefined;
  const cacheHit = !opts.forceFullText && !!opts.sinceLast && !!cached && cached.fingerprint === bodyFp;
  const unchanged = !!opts.sinceLast && !!previous && isUnchanged(previous, obs);

  if (cacheHit) {
    lines.push(`(text unchanged since step ${cached!.step} — cached)`);
  } else if (unchanged) {
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
      // "1. Links -> Links" says the same thing twice; only show a target that adds information.
      if (c.target && oneLine(c.target) !== oneLine(c.label)) bits.push(`-> ${c.target}`);
      if (c.dialog) bits.push('[dialog]');
      if (c.external) bits.push('[external]');
      if (c.disabled) bits.push('(disabled)');
      lines.push('  ' + bits.join(' '));
    });
  } else if (obs.loading) {
    lines.push('Choices (0): still loading — call observe again; this is not an ending.');
  } else {
    lines.push('Choices (0): no visible choices.');
    if (obs.inputs.length) lines.push('  -> fill the inputs and/or press a key, then observe again.');
    else lines.push('  -> try wait, or this may be an ending / dead end.');
  }

  if (obs.ui?.length) {
    const total = obs.uiTotal ?? obs.ui.length;
    lines.push('');
    if (previous && uiKey(previous) === uiKey(obs) && !cacheHit) {
      lines.push(`UI: unchanged (${total} control${total === 1 ? '' : 's'})`);
    } else if (cacheHit) {
      lines.push(`UI: unchanged (${total} control${total === 1 ? '' : 's'})`);
    } else {
      lines.push(
        'UI: ' +
          obs.ui.map((u) => `${oneLine(u.label)} [${u.ref}]`).join(' · ') +
          (total > obs.ui.length ? ` · … +${total - obs.ui.length} more (find_ui(selector:'#ui-bar'))` : '')
      );
    }
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
    if (previous && (previous.status ?? '') === obs.status) {
      lines.push('Status: unchanged');
    } else {
      lines.push('Status:');
      lines.push(obs.status);
    }
  }

  // Prefer the session's stored baseline: the last observation may be a lean action result
  // with no variables at all, and the caller's own tree is the better diff target.
  const baseline = opts.previousVariables ?? previous?.variables ?? null;
  const variables = renderVariables(obs, baseline, opts.variablesMode ?? 'diff');
  if (variables) {
    lines.push('');
    lines.push(variables);
  }

  if (opts.consoleCount) {
    lines.push('');
    lines.push(`⚠ ${opts.consoleCount} console/network issue(s) captured — call get_logs(kind:"console") for details.`);
  }

  // Remember what a full render of this passage looked like, so a revisit can be a handle.
  if (opts.digest && obs.passage && !cacheHit) {
    opts.digest.set(obs.passage, { fingerprint: bodyFp, step });
  }

  return lines.join('\n');
}

export function renderOpen(session: GameSession, obs: Observation): string {
  const story = obs.story ?? {};
  const lines = [
    `Opened game "${session.id}" (${session.source})`,
    // On its own line, so an agent can take the id without regex-matching prose. Every tool
    // accepts a missing game_id while one game is open, but with several open it is required.
    `game_id: ${session.id}`,
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

/** The in-session snapshots, so a mistyped name is immediately obvious. */
export function renderSnapshotList(
  sessionId: string,
  snapshots: Array<{ name: string; bytes: number; at: number }>
): string {
  if (!snapshots.length) {
    return `No snapshots in session ${sessionId}. Use snapshot(action:"save", name:"...") first.`;
  }
  const lines = [`Snapshots in session ${sessionId} (newest first):`];
  for (const s of snapshots) {
    const when = new Date(s.at).toISOString().replace('T', ' ').slice(0, 16);
    lines.push(`  ${s.name} — ${s.bytes} chars — ${when}`);
  }
  lines.push('Restore one with snapshot(action:"load", name:"...").');
  return lines.join('\n');
}
