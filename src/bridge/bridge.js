/* Twine Play MCP - in-page bridge.
 *
 * Injected into every game page via Playwright addInitScript. Exposes a single
 * global, window.__twineMCP, used by the MCP server through page.evaluate().
 *
 * Design rules:
 *  - Never throw across the bridge: every public call returns { ok, ... } or a
 *    JSON-safe observation object.
 *  - Story-format specifics live in adapters; everything has a generic DOM
 *    fallback so unknown formats still play.
 *  - No network, no eval, no access to Node.
 */
(() => {
  'use strict';

  if (window.__twineMCP) return;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dd', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
    'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
  ]);

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'audio', 'video', 'source']);

  const normalize = (s) => String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

  const normalizeLabelText = (s) => normalize(s).toLowerCase();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isElementVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return el.getClientRects().length > 0;
  };

  // ---------------------------------------------------------------------------
  // Story format detection and adapters
  // ---------------------------------------------------------------------------

  const storyDataEl = () => document.querySelector('tw-storydata');

  const storyMeta = () => {
    const el = storyDataEl();
    if (!el) return {};
    return {
      title: el.getAttribute('name') || document.title || null,
      format: el.getAttribute('format') || null,
      formatVersion: el.getAttribute('format-version') || null,
      ifid: el.getAttribute('ifid') || null,
      startNode: el.getAttribute('startnode') || null,
      creator: el.getAttribute('creator') || null,
      options: el.getAttribute('options') || null
    };
  };

  const sugar = () => window.SugarCube || null;

  const detectFormat = () => {
    const meta = storyMeta();
    const declared = String(meta.format || '').toLowerCase();
    const g = window;

    const hasSugar = !!(g.SugarCube || (g.Engine && g.State && g.Story));
    const hasChapbook = !!(g.engine && g.engine.state);
    const hasSnowman = !!(g.story && typeof g.story === 'object');
    // Snowman 2 also renders a <tw-passage>, so the declared format must win over DOM heuristics.
    const hasHarloweDom = !!document.querySelector('tw-passage');

    let name;
    if (declared.includes('sugarcube')) name = 'sugarcube';
    else if (declared.includes('harlowe')) name = 'harlowe';
    else if (declared.includes('chapbook')) name = 'chapbook';
    else if (declared.includes('snowman')) name = 'snowman';
    else if (hasSugar) name = 'sugarcube';
    else if (hasChapbook) name = 'chapbook';
    else if (hasSnowman) name = 'snowman';
    else if (hasHarloweDom || g.Harlowe) name = 'harlowe';
    else if (declared) name = declared;
    else name = 'generic';

    let version = meta.formatVersion || null;
    if (name === 'sugarcube' && g.SugarCube && g.SugarCube.version) {
      version = String(g.SugarCube.version);
    }
    return { name, version };
  };

  // ---------------------------------------------------------------------------
  // Root / passage lookup
  // ---------------------------------------------------------------------------

  const PASSAGE_SELECTORS = ['#passage', 'tw-passage', '#page article', '#story .passage', '.passage', 'tw-story', '#story'];

  /**
   * Is this element part of a passage that is animating out?
   *
   * Chapbook crossfades between passages: the old one stays in the DOM for ~500ms with a
   * fade-out class, links and all. Reading it produced "ghost" choices that belonged to the
   * previous passage, so clicks failed with stale-ref and the (N -> M choices) counts in play()
   * were nonsense while a transition was in flight.
   */
  const isFadingOut = (el) => {
    try {
      if (el.closest && el.closest('.fade-out, [data-cb-transition="out"]')) return true;
      const op = Number(window.getComputedStyle(el).opacity);
      return op > 0 && op < 0.95 && !!(el.closest && el.closest('article, .passage'));
    } catch (_) {
      return false;
    }
  };

  const getPassageRoot = () => {
    for (const sel of PASSAGE_SELECTORS) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        if (!isElementVisible(el) || isFadingOut(el)) continue;
        return el;
      }
    }
    return null;
  };

  /**
   * Harlowe's current passage name, read from its own session-restore blob.
   *
   * Harlowe 3 keeps Engine/State in module scope, so they are NOT window globals (verified on
   * Harlowe 3.3.8 and 3.3.9: window.Engine, window.State and window.Harlowe are all undefined),
   * and <tw-passage> carries no passage name attribute. What it does leave readable is
   * sessionStorage["Saved Session"]: the trail it reloads a session from. Each entry is either a
   * bare passage name (string) or a { passage, variables, ... } record, newest last.
   */
  const harloweTrail = () => {
    try {
      const raw = window.sessionStorage && window.sessionStorage.getItem('Saved Session');
      if (!raw) return null;
      const trail = JSON.parse(raw);
      return Array.isArray(trail) && trail.length ? trail : null;
    } catch (_) {
      return null; // storage disabled or a shape we do not know
    }
  };

  const harloweTrailPassage = () => {
    const trail = harloweTrail();
    if (!trail) return null;
    for (let i = trail.length - 1; i >= 0; i--) {
      const entry = trail[i];
      if (typeof entry === 'string' && entry) return entry;
      if (entry && typeof entry === 'object' && typeof entry.passage === 'string' && entry.passage) return entry.passage;
    }
    return null;
  };

  /** The newest trail entry that carries variables — Harlowe's only readable store. */
  const harloweTrailEntry = () => {
    const trail = harloweTrail();
    if (!trail) return null;
    for (let i = trail.length - 1; i >= 0; i--) {
      const entry = trail[i];
      if (entry && typeof entry === 'object' && entry.variables && typeof entry.variables === 'object') return entry;
    }
    return null;
  };

  const readPassageName = (fmt) => {
    const g = window;
    try {
      if (fmt === 'sugarcube') {
        const S = sugar() || g;
        if (S.State && S.State.passage) return String(S.State.passage);
      }
      if (fmt === 'snowman') {
        const p = (g.passage && g.passage.name) ? g.passage : (g.story && g.story.passage);
        if (p) return String(p.name || p.title || p);
      }
      if (fmt === 'harlowe') {
        const trailPassage = harloweTrailPassage();
        if (trailPassage) return trailPassage;
        if (g.Engine && g.Engine.passage) return String(g.Engine.passage);
        if (g.State && g.State.passage) return String(g.State.passage);
      }
      if (fmt === 'chapbook') {
        const st = g.engine && g.engine.state;
        if (st && typeof st.get === 'function') {
          try {
            const trail = st.get('trail');
            if (Array.isArray(trail) && trail.length) return String(trail[trail.length - 1]);
          } catch (_) { /* ignore */ }
        }
        if (g.passage && g.passage.name) return String(g.passage.name);
      }
    } catch (_) { /* ignore */ }
    const root = getPassageRoot();
    const named = root && root.getAttribute && (root.getAttribute('data-passage') || root.getAttribute('passage-name'));
    return named || null;
  };

  // ---------------------------------------------------------------------------
  // Text extraction: DOM -> markdown-ish plain text
  // ---------------------------------------------------------------------------

  const htmlToMarkdown = (root, maxChars) => {
    const out = [];

    const emit = (s) => {
      if (s) out.push(s);
    };

    const walk = (node) => {
      if (out.length > 40000) return; // hard safety cap while walking
      if (node.nodeType === Node.TEXT_NODE) {
        emit(node.nodeValue.replace(/\u00a0/g, ' '));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = node;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return;

      let style = null;
      try { style = window.getComputedStyle(el); } catch (_) { /* ignore */ }
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return;

      if (tag === 'br') { emit('\n'); return; }

      if (tag === 'img') {
        const alt = el.getAttribute('alt') || '';
        const src = el.getAttribute('src') || '';
        if (src) emit('[image' + (alt ? ': ' + alt : '') + ']');
        return;
      }

      const block = BLOCK_TAGS.has(tag);
      if (block) emit('\n');

      if (tag === 'strong' || tag === 'b') emit('**');
      if (tag === 'em' || tag === 'i') emit('*');
      if (tag === 'code') emit('`');

      for (const child of el.childNodes) walk(child);

      if (tag === 'code') emit('`');
      if (tag === 'em' || tag === 'i') emit('*');
      if (tag === 'strong' || tag === 'b') emit('**');

      if (block) emit('\n');
    };

    walk(root);

    let text = out.join('');
    text = text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (maxChars && text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n… [truncated, ' + text.length + ' chars total]';
    }
    return text;
  };

  // ---------------------------------------------------------------------------
  // Choices and inputs
  // ---------------------------------------------------------------------------

  const CHOICE_SELECTORS = [
    'a[data-passage]', 'a.link-internal', 'a.internalLink',
    'tw-link', 'a.link-external', 'a[href]',
    'button', 'input[type="button"]', 'input[type="submit"]',
    '[role="link"]', '[role="button"]'
  ];

  const INTERACTIVE_SKIP = new Set(['link-external']);

  const describeChoice = (el, ref) => {
    const tag = el.tagName.toLowerCase();
    const label = normalize(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 300);
    const href = el.getAttribute('href') || '';
    const dataPassage = el.getAttribute('data-passage');
    const passageName = el.getAttribute('passage-name');
    let kind = 'link';
    if (tag === 'button' || (tag === 'input' && /^(button|submit)$/i.test(el.getAttribute('type') || ''))) kind = 'button';
    else if (tag === 'tw-link') kind = 'harlowe-link';
    else if (el.classList.contains('link-external')) kind = 'external-link';
    else if (/^https?:/i.test(href)) kind = 'external-link';
    else if (dataPassage || passageName || el.classList.contains('link-internal') || el.classList.contains('internalLink')) kind = 'internal-link';
    const target = dataPassage || passageName || null;
    return {
      ref,
      label,
      kind,
      target: target || null,
      href: /^https?:/i.test(href) ? href : null,
      disabled: !!el.disabled,
      external: kind === 'external-link'
    };
  };

  const describeInput = (el, ref) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')).toLowerCase();
    let label = '';
    try {
      const native = el.labels && el.labels.length ? el.labels[0].innerText : null;
      const wrapped = el.closest ? el.closest('label') : null;
      label = normalize(native || (wrapped && wrapped.innerText) || el.getAttribute('aria-label') || el.title || '').slice(0, 70);
    } catch (_) { /* ignore */ }
    const base = {
      ref,
      kind: tag === 'select' ? 'select' : type,
      name: el.getAttribute('name') || null,
      placeholder: el.getAttribute('placeholder') || null,
      value: typeof el.value === 'string' ? el.value.slice(0, 300) : null,
      disabled: !!el.disabled
    };
    if (label && type !== 'text' && type !== 'search' && type !== 'number' && type !== 'password') base.label = label;
    if (tag === 'select') {
      base.options = Array.from(el.options).slice(0, 60).map((o) => ({ value: o.value, label: normalize(o.textContent || '').slice(0, 120) }));
    }
    if (type === 'checkbox' || type === 'radio') base.checked = !!el.checked;
    return base;
  };

  /** An input is usable if visible itself or wrapped in a visible label (DoL hides radios and styles the label). */
  const inputUsable = (el) => {
    if (isElementVisible(el)) return true;
    const lab = el.closest ? el.closest('label') : null;
    return !!(lab && isElementVisible(lab));
  };

  const collectInteractives = (root, collectOpts) => {
    const cOpts = collectOpts || {};
    const inputsLimit = Math.max(1, Math.min(cOpts.inputsLimit || 40, 500));
    const inputsOffset = Math.max(0, cOpts.inputsOffset || 0);
    const scope = root || document;
    // Clear stale refs page-wide.
    for (const el of document.querySelectorAll('[data-twmcp-ref]')) el.removeAttribute('data-twmcp-ref');

    const choices = [];
    const inputs = [];
    const ui = [];
    const seen = new Set();
    let cIdx = 0;
    let iIdx = 0;
    let uIdx = 0;
    let inputsSeen = 0;

    const UI_EXCLUDE = '#ui-bar, tw-sidebar, .tw-sidebar, #menu, .menu, #backstage, [data-cb-backstage], footer, header, #spinner, .warnings, [data-cb-restart]';

    const dialogEl = () => {
      for (const el of document.querySelectorAll('#ui-dialog, .ui-dialog, dialog')) {
        if (isElementVisible(el)) return el;
      }
      return null;
    };

    // Count every eligible input; only ref+report the window [inputsOffset, inputsOffset+inputsLimit).
    const takeInput = (el, extra) => {
      const pos = inputsSeen++;
      if (pos < inputsOffset || inputs.length >= inputsLimit) return;
      const ref = 'i' + (++iIdx);
      el.setAttribute('data-twmcp-ref', ref);
      const d = describeInput(el, ref);
      if (extra) Object.assign(d, extra);
      inputs.push(d);
    };

    // 1. Passage-scoped choices.
    for (const sel of CHOICE_SELECTORS) {
      for (const el of scope.querySelectorAll(sel)) {
        // A passage fading out (Chapbook crossfade) still holds clickable links that belong
        // to the *previous* passage; collecting them produces ghost choices.
        if (isFadingOut(el)) continue;
        if (seen.has(el)) continue;
        seen.add(el);
        if (choices.length >= 120) break;
        if (!isElementVisible(el)) continue;
        if (el.closest(UI_EXCLUDE)) continue;
        if (el.hasAttribute('data-twmcp-skip')) continue;
        if (['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) continue;
        const ref = 'c' + (++cIdx);
        el.setAttribute('data-twmcp-ref', ref);
        const d = describeChoice(el, ref);
        if (!d.label && d.kind !== 'button') continue;
        choices.push(d);
      }
    }

    // 2. Inputs inside the passage.
    const inputSel = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="file"]), textarea, select';
    for (const el of scope.querySelectorAll(inputSel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!inputUsable(el)) continue;
      takeInput(el);
    }

    // 3. Modal dialog buttons and inputs become numbered choices / inputs (the agent must be able to answer dialogs).
    let dialog = null;
    const dlg = dialogEl();
    if (dlg) {
      const dlgText = normalize(dlg.innerText || '').slice(0, 1200);
      const titleEl = dlg.querySelector('.ui-dialog-title, .title, h3');
      const dlgButtons = [];
      for (const el of dlg.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], .link-internal')) {
        if (!isElementVisible(el) || seen.has(el)) continue;
        seen.add(el);
        const ref = 'c' + (++cIdx);
        el.setAttribute('data-twmcp-ref', ref);
        const d = describeChoice(el, ref);
        if (!d.label) continue;
        d.dialog = true;
        choices.push(d);
        dlgButtons.push(d);
      }
      for (const el of dlg.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea, select')) {
        if (seen.has(el) || !inputUsable(el)) continue;
        seen.add(el);
        takeInput(el, { dialog: true });
      }
      dialog = {
        title: titleEl ? normalize(titleEl.textContent || '').slice(0, 120) : null,
        text: dlgText,
        buttonCount: dlgButtons.length,
        buttons: dlgButtons.map((b) => ({ n: choices.indexOf(b) + 1, label: b.label, ref: b.ref }))
      };
    }

    // 4. Ambient UI (sidebar, menu, ModLoader banner) exposed separately, not as passage choices.
    //    Nothing visible is dropped: the cap only bounds pathological sidebars and the remainder
    //    is still reported via uiTotal (rendered as "… +N more").
    const UI_LIMIT = 120;
    let uiTotal = 0;
    for (const el of document.querySelectorAll(
      '#ui-bar button, #ui-bar a, #ui-bar [role="button"], #ui-bar [onclick], ' +
        '#startCaption button, #startCaption a, #story-caption button, #story-caption a, ' +
        '#startBannerModLoaderGui, #ui-bar-tray button'
    )) {
      if (seen.has(el) || !isElementVisible(el) || isFadingOut(el)) continue;
      const label = normalize(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').slice(0, 60);
      if (!label) continue;
      seen.add(el);
      uiTotal++;
      if (ui.length >= UI_LIMIT) continue;
      const ref = 'u' + (++uIdx);
      el.setAttribute('data-twmcp-ref', ref);
      ui.push({ ref, label, kind: 'ui' });
    }

    return { choices, inputs, ui, uiTotal, dialog, inputsTotal: inputsSeen, inputsOffset };
  };

  // ---------------------------------------------------------------------------
  // Variables
  // ---------------------------------------------------------------------------

  const sanitize = (value, depth, seen) => {
    const d = depth || 0;
    if (value === null || value === undefined) return value === undefined ? null : null;
    const t = typeof value;
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'string') return value.length > 400 ? value.slice(0, 400) + '…' : value;
    if (t === 'function') return '[function]';
    if (t === 'bigint') return String(value);
    if (d >= 4) return '[depth]';
    if (t === 'object') {
      if (seen.has(value)) return '[cycle]';
      seen.add(value);
      let result;
      if (Array.isArray(value)) {
        result = value.slice(0, 80).map((v) => sanitize(v, d + 1, seen));
        if (value.length > 80) result.push('… +' + (value.length - 80) + ' more');
      } else {
        result = {};
        let n = 0;
        for (const k of Object.keys(value)) {
          if (n++ >= 80) { result['…'] = 'more keys omitted'; break; }
          try { result[k] = sanitize(value[k], d + 1, seen); } catch (_) { result[k] = '[unreadable]'; }
        }
      }
      seen.delete(value);
      return result;
    }
    return String(value);
  };

  const readVariables = (fmt) => {
    const g = window;
    const tryObj = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      try { return sanitize(obj, 0, new Set()); } catch (_) { return null; }
    };
    try {
      if (fmt === 'sugarcube') {
        const S = sugar() || g;
        if (S.State && S.State.variables) return tryObj(S.State.variables);
        if (S.state && S.state.variables) return tryObj(S.state.variables);
      }
      if (fmt === 'harlowe') {
        // Harlowe keeps its variable store in module scope, but it writes the whole trail —
        // variables included — into sessionStorage on every navigation. The newest entry that
        // carries variables is the live store (verified on 3.3.8/3.3.9: 21 keys).
        const entry = harloweTrailEntry();
        if (entry && entry.variables && typeof entry.variables === 'object') {
          if (Object.keys(entry.variables).length) return tryObj(entry.variables);
        }
        const st = g.Harlowe && g.Harlowe.API_ACCESS && g.Harlowe.API_ACCESS.STATE;
        if (st && st.variables) return tryObj(st.variables);
        const alt = g.State || (g.Harlowe && g.Harlowe.State);
        if (alt && alt.variables) return tryObj(alt.variables);
      }
      if (fmt === 'snowman') {
        const s = (g.story && g.story.state) || g.state;
        if (s && typeof s === 'object') {
          try {
            if (Object.keys(s).length) return tryObj(s);
          } catch (_) { /* ignore */ }
        }
      }
      if (fmt === 'chapbook') {
        const st = g.engine && g.engine.state;
        if (!st) return null;
        if (typeof st.saveToObject === 'function') {
          try {
            const o = st.saveToObject();
            if (o && typeof o === 'object' && Object.keys(o).length) return tryObj(o);
          } catch (_) { /* ignore */ }
        }
        if (st.variables && typeof st.variables === 'object') return tryObj(st.variables);
        if (typeof st.varNames === 'function') {
          try {
            const names = st.varNames();
            if (Array.isArray(names) && names.length) {
              const out = {};
              for (const n of names) {
                try { out[n] = st.get(n); } catch (_) { out[n] = null; }
              }
              return tryObj(out);
            }
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  };

  /** Read selected story variables by dot path (e.g. "haircolour", "V.background", "player.name"). */
  const getVariables = (opts) => {
    const o = opts || {};
    const fmt = detectFormat().name;
    const S = sugar() || window;
    let vars = null;
    if (fmt === 'sugarcube') {
      if (S.State && S.State.variables) vars = S.State.variables;
      else if (S.state && S.state.variables) vars = S.state.variables;
    }
    // Everything else goes through readVariables(), which already knows Chapbook's
    // engine.state and Harlowe's session trail. This tool used to hard-code the SugarCube
    // path and answer "Story variables are not readable here (SugarCube required)" on a
    // Harlowe page where observe(include_variables:true) was reading 21 variables at the
    // same moment — the tool disagreeing with itself.
    if (!vars) vars = readVariables(fmt);
    if (!vars || typeof vars !== 'object') {
      return { ok: false, error: 'unsupported', message: 'Story variables are not readable here.' };
    }
    const paths = Array.isArray(o.paths) ? o.paths.map(String).filter(Boolean).slice(0, 50) : [];
    if (!paths.length) {
      const keys = Object.keys(vars);
      const summary = {};
      for (const k of keys.slice(0, 200)) {
        try {
          const v = vars[k];
          summary[k] =
            v === null || v === undefined ? (v ?? null)
              : Array.isArray(v) ? '[' + v.length + ' items]'
              : typeof v === 'object' ? '{' + Object.keys(v).length + ' keys}'
              : sanitize(v, 0, new Set());
        } catch (_) { summary[k] = '[unreadable]'; }
      }
      return { ok: true, mode: 'keys', totalKeys: keys.length, keys: keys.slice(0, 200), summary };
    }
    const values = {};
    const missing = [];
    for (const p of paths) {
      const clean = String(p)
        .replace(/^\$/, '')
        .replace(/^(?:State\.)?[Vv]ariables\./, '')
        .replace(/^V\./, '');
      const parts = clean.split('.').filter(Boolean);
      let cur = vars;
      let found = parts.length > 0;
      for (const part of parts) {
        if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
        else { found = false; break; }
      }
      if (found) values[p] = sanitize(cur, 0, new Set());
      else missing.push(p);
    }
    return { ok: true, mode: 'paths', values, missing };
  };

  // ---------------------------------------------------------------------------
  // Engine helpers
  // ---------------------------------------------------------------------------

  const engineBusy = () => {
    try {
      const E = window.Engine || (sugar() && sugar().Engine);
      if (!E) return false;
      if (typeof E.isPlaying === 'function') return !!E.isPlaying();
      const st = E.state;
      if (typeof st === 'string') return st !== 'idle' && st !== '';
      if (st && typeof st === 'object') return false;
    } catch (_) { /* ignore */ }
    return false;
  };

  const engineState = () => {
    try {
      const E = window.Engine || (sugar() && sugar().Engine);
      if (!E) return null;
      const st = E.state;
      if (typeof st === 'string') return st;
      if (typeof E.isPlaying === 'function') return E.isPlaying() ? 'playing' : 'idle';
    } catch (_) { /* ignore */ }
    return null;
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const waitStable = async (opts) => {
    const o = opts || {};
    const timeout = Math.max(200, Math.min(o.timeout || 15000, 120000));
    const quiet = Math.max(30, Math.min(o.quiet || 120, 2000));
    const t0 = Date.now();

    // 1. Wait out format-declared engine busy states (bounded).
    while (Date.now() - t0 < timeout * 0.6 && engineBusy()) await sleep(25);

    // 2. Wait for DOM mutation quiet.
    await new Promise((resolve) => {
      let timer = null;
      let hard = null;
      const obs = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(done, quiet);
      });
      const done = () => {
        try { obs.disconnect(); } catch (_) { /* ignore */ }
        if (timer) clearTimeout(timer);
        if (hard) clearTimeout(hard);
        resolve();
      };
      try {
        obs.observe(document.body || document.documentElement, {
          subtree: true, childList: true, characterData: true, attributes: true
        });
      } catch (_) { /* ignore */ }
      timer = setTimeout(done, quiet);
      hard = setTimeout(done, timeout);
    });

    // 3. Two frames to let layout/style settle.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    return { ok: true, elapsed: Date.now() - t0, engineState: engineState(), busy: engineBusy() };
  };

  /**
   * Is the shell up but the story not playable yet?
   *
   * SugarCube keeps #init-screen ("Loading…") visible while the story boots — measured ~4.5s on
   * [Redacted] Redux. Reporting zero choices then reads as an ending, so say what is happening.
   */
  const isLoading = () => {
    try {
      for (const sel of ['#init-screen', '#init-loading', '.loading', '.loader', '[aria-busy="true"]']) {
        const el = document.querySelector(sel);
        if (el && isElementVisible(el)) return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  };

  const observe = (opts) => {
    const o = opts || {};
    const fmtInfo = detectFormat();
    const root = getPassageRoot();
    const maxChars = Math.max(200, Math.min(o.maxTextChars || 12000, 200000));
    const text = root ? htmlToMarkdown(root, maxChars) : '';
    const interactives = collectInteractives(root, { inputsOffset: o.inputsOffset, inputsLimit: o.inputsLimit });
    const meta = storyMeta();

    let variables = null;
    if (o.includeVariables !== false) variables = readVariables(fmtInfo.name);

    let status = null;
    if (o.includeStatus !== false) {
      const parts = [];
      for (const sel of ['#story-caption', '.story-caption', 'tw-header', 'tw-footer', '#custom-caption', '.status-bar']) {
        const el = document.querySelector(sel);
        if (el && isElementVisible(el)) {
          const t = normalize(el.innerText || '');
          if (t) parts.push(t);
        }
      }
      if (parts.length) {
        status = parts.join('\n---\n');
        if (status.length > 1500) status = status.slice(0, 1500) + '…';
      }
    }

    return {
      ok: true,
      passage: readPassageName(fmtInfo.name),
      format: fmtInfo.name,
      formatVersion: fmtInfo.version,
      story: meta,
      url: location.href,
      title: document.title || null,
      text,
      choices: interactives.choices,
      inputs: interactives.inputs,
      inputsTotal: interactives.inputsTotal,
      inputsOffset: interactives.inputsOffset,
      ui: interactives.ui,
      uiTotal: interactives.uiTotal,
      dialog: interactives.dialog,
      status,
      variables,
      engineState: engineState(),
      hasPassageRoot: !!root,
      readyState: document.readyState,
      loading: isLoading()
    };
  };

  const clickRef = (ref) => {
    const el = findByRef(ref);
    if (!el) return { ok: false, error: 'stale-ref', message: 'Ref ' + ref + ' no longer exists; call observe again.' };
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) { /* ignore */ }
    try {
      el.focus({ preventScroll: true });
    } catch (_) { /* ignore */ }
    try {
      el.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'click-failed', message: String(e && e.message || e) };
    }
  };

  const setValueNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  };

  const fillRef = (ref, value) => {
    const el = findByRef(ref);
    if (!el) return { ok: false, error: 'stale-ref' };
    try {
      el.focus({ preventScroll: true });
      setValueNative(el, value == null ? '' : String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'fill-failed', message: String(e && e.message || e) };
    }
  };

  let refSeq = 0;
  const nextRef = (prefix) => prefix + (++refSeq);

  /** The element a ref points at, or null. Refs are sanitised because they end up in a selector. */
  const findByRef = (ref) => {
    const clean = String(ref == null ? '' : ref).replace(/["\\]/g, '');
    if (!clean) return null;
    return document.querySelector('[data-twmcp-ref="' + clean + '"]');
  };

  /** Give an element a ref if it does not have one yet, and return it. */
  const ensureRef = (el, prefix) => {
    let ref = el.getAttribute('data-twmcp-ref');
    if (!ref) {
      ref = nextRef(prefix || 'x');
      el.setAttribute('data-twmcp-ref', ref);
    }
    return ref;
  };

  // Labels are included on purpose: SugarCube's <<radiobutton>>/<<checkbox>> macros and many
  // Twine UIs render options as <label> elements with the real input hidden inside.
  const UI_CANDIDATES = 'button, a, label, [role="button"], [role="link"], [role="radio"], [role="checkbox"], input[type="button"], input[type="submit"], .link-internal, [onclick], [data-twmcp-ref]';

  /** Best-effort click target: the element itself when clickable, else its label / onclick ancestor. */
  const clickTargetOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'label' || tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') return el;
    const oc = el.closest ? el.closest('[onclick]') : null;
    if (oc) return oc;
    const lab = el.closest ? el.closest('label') : null;
    if (lab) return lab;
    return el;
  };

  /** Visible label text for a clickable element (inputs resolve through their <label>). */
  const clickableLabel = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const lab = el.labels && el.labels.length ? el.labels[0] : (el.closest ? el.closest('label') : null);
      return normalize((lab && lab.innerText) || el.getAttribute('aria-label') || el.title || '').slice(0, 200);
    }
    return normalize(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').slice(0, 200);
  };

  /**
   * Resolve a UI element into a data-twmcp-ref.
   *
   * Accepts `{ref}`, `{selector}`, `{text, exact}` — or `{target}` with any of those forms, which
   * is how the MCP tools expose a single "point at this thing" parameter: an agent should not have
   * to know whether the thing it can see is a ref, a CSS selector or a visible label.
   */
  const resolveUi = (opts) => {
    const o = opts || {};
    const asSelector = (sel) => {
      let el = null;
      try {
        el = document.querySelector(String(sel));
      } catch (_) {
        return { ok: false, error: 'bad-selector' };
      }
      if (!el) return { ok: false, error: 'no-match' };
      const target = clickTargetOf(el);
      return { ok: true, ref: ensureRef(target), label: clickableLabel(target) };
    };

    let explicit = o.ref || o.selector || o.text;
    if (o.target != null && !explicit) {
      const s = String(o.target);
      const refInSelector = /^\[data-twmcp-ref=["']?([^"'\]\s]+)["']?\]$/.exec(s);
      if (refInSelector) o.ref = refInSelector[1];
      else if (/[#.[\]:>+~]/.test(s)) o.selector = s;         // clearly a selector
      else if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(s)) o.text = s; // a bare word: treat as a label
      else o.text = s;
    }

    if (o.ref) {
      const ref = String(o.ref).replace(/["\\]/g, '');
      const el = findByRef(ref);
      return el ? { ok: true, ref } : { ok: false, error: 'stale-ref', message: 'Ref ' + ref + ' no longer exists. Call observe() to refresh refs.' };
    }

    if (o.selector) {
      const hit = asSelector(o.selector);
      if (hit.ok) return hit;
      // A selector the DOM does not have (or a bare tag name that is really a label):
      // keep going and try text, so one "point at this thing" parameter can cover both.
      if (hit.error === 'no-match' && !o.text && !/^[#.[]/.test(String(o.selector))) o.text = String(o.selector);
      else if (hit.error === 'bad-selector' && !o.text) o.text = String(o.selector);
      else if (!o.text) return { ok: false, error: hit.error, message: 'No element matches selector "' + o.selector + '".' };
    }
    if (o.text) {
      const needle = normalizeLabelText(o.text);
      const exact = !!o.exact;
      const cands = [];
      for (const el of document.querySelectorAll(UI_CANDIDATES)) {
        if (!isElementVisible(el)) continue;
        const label = clickableLabel(el);
        if (!label) continue;
        const hay = normalizeLabelText(label);
        const hit = exact ? hay === needle : hay.includes(needle);
        if (hit) cands.push({ el, label });
      }
      if (!cands.length) {
        return {
          ok: false,
          error: 'no-match',
          message:
            'No visible UI element matches "' + o.text + '". ' +
            'Use find_ui(text) to search labels/inputs, or observe() to see numbered choices/inputs.'
        };
      }
      cands.sort((a, b) => a.label.length - b.label.length);
      const pick = cands[0];
      const target = clickTargetOf(pick.el);
      const ref = ensureRef(target);
      return {
        ok: true,
        ref,
        label: pick.label,
        tag: target.tagName.toLowerCase(),
        matches: cands.length,
        alternatives: cands.slice(1, 6).map((c) => c.label)
      };
    }
    return { ok: false, error: 'missing-argument', message: 'Provide ref, selector or text.' };
  };

  /** Find visible controls (buttons, links, labels, inputs) by text/name; returns refs for click_ui/interact. */
  const findUi = (opts) => {
    const o = opts || {};
    const hasText = o.text != null && String(o.text) !== '';
    const needle = hasText ? normalizeLabelText(o.text) : '';
    const exact = !!o.exact;
    const kindWant = o.kind ? String(o.kind).toLowerCase() : null;
    const nameWant = o.name ? String(o.name) : null;
    const limit = Math.max(1, Math.min(o.limit || 20, 100));
    const selector =
      'button, a, label, [role="button"], [role="link"], [role="radio"], [role="checkbox"], ' +
      'input:not([type="hidden"]):not([type="file"]), textarea, select, .link-internal, [onclick]';
    const matches = [];
    let total = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (!isElementVisible(el) && !inputUsable(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const kind =
        tag === 'input' ? 'input:' + (type || 'text')
          : tag === 'select' ? 'select'
          : tag === 'textarea' ? 'textarea'
          : tag === 'label' ? 'label'
          : tag === 'a' || el.classList.contains('link-internal') ? 'link'
          : 'button';
      if (kindWant && !(kind.startsWith(kindWant) || kind.includes(':' + kindWant))) continue;
      if (nameWant && el.getAttribute('name') !== nameWant) continue;
      const label = clickableLabel(el);
      if (hasText) {
        if (!label) continue;
        const hay = normalizeLabelText(label);
        const hit = exact ? hay === needle : hay.includes(needle);
        if (!hit) continue;
      } else if (!label && !nameWant) continue;
      total++;
      if (matches.length >= limit) continue;
      const target = clickTargetOf(el);
      const ref = ensureRef(target);
      const m = { ref, kind, label, tag };
      const name = el.getAttribute('name');
      if (name) m.name = name;
      if (type === 'radio' || type === 'checkbox') m.checked = !!el.checked;
      if (el.disabled) m.disabled = true;
      if (tag === 'select' && el.options && el.selectedIndex >= 0) m.value = String(el.options[el.selectedIndex].textContent || '').slice(0, 60);
      else if ((type === 'text' || type === 'search' || type === 'number' || tag === 'textarea') && typeof el.value === 'string' && el.value) m.value = el.value.slice(0, 80);
      matches.push(m);
    }
    return { ok: true, matches, total, truncated: total > matches.length };
  };

  /** Inspect any DOM subtree (dialogs, mod GUIs, backstage panels): text + ref'd buttons/inputs.
   *  Without a selector, discovers overlay-like panels that contain buttons or file inputs. */
  const inspectUi = (opts) => {
    const o = opts || {};
    const cssPath = (el) => {
      if (el.id) return '#' + el.id;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 4) {
        let part = cur.tagName.toLowerCase();
        if (cur.className && typeof cur.className === 'string') {
          const cls = cur.className.trim().split(/\s+/).filter((c) => c && c.length < 40).slice(0, 2);
          if (cls.length) part += '.' + cls.join('.');
        }
        const parent = cur.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
          if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
        }
        parts.unshift(part);
        if (cur.id) {
          parts[0] = '#' + cur.id;
          break;
        }
        cur = parent;
      }
      return parts.join(' > ');
    };

    const describePanel = (el) => {
      let buttons = 0;
      let fileInputs = 0;
      let inputs = 0;
      for (const b of el.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], .link-internal, [onclick]')) {
        if (isElementVisible(b)) buttons++;
      }
      for (const i of el.querySelectorAll('input, textarea, select')) {
        if (i.getAttribute('type') === 'file') fileInputs++;
        else if (isElementVisible(i)) inputs++;
      }
      let text = normalize(el.innerText || '');
      try {
        const values = Array.from(el.querySelectorAll('textarea, input'))
          .map((v) => v.value)
          .filter((v) => v && v.length < 500)
          .join(' | ');
        if (values) text = ('⟦values: ' + values + '⟧ ' + text).slice(0, 400);
      } catch (_) { /* ignore */ }
      const r = el.getBoundingClientRect();
      return {
        selector: cssPath(el),
        id: el.id || null,
        cls: String(el.className || '').slice(0, 80),
        tag: el.tagName.toLowerCase(),
        buttons,
        inputs,
        fileInputs,
        area: Math.round(r.width) * Math.round(r.height),
        text: text.slice(0, 320)
      };
    };

    if (!o.selector) {
      const cands = [];
      const seenCand = new Set();
      const consider = (el) => {
        if (!el || el === document.body || el === document.documentElement || seenCand.has(el)) return;
        seenCand.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) return;
        const p = describePanel(el);
        if (p.buttons === 0 && p.fileInputs === 0) return;
        cands.push(p);
      };
      // 1) File inputs are the strongest signal (mod import, save import UIs): walk up from each.
      for (const f of document.querySelectorAll('input[type="file"]')) {
        let cur = f.parentElement;
        for (let depth = 0; cur && depth < 4; depth++, cur = cur.parentElement) consider(cur);
      }
      // 2) Overlay-like panels anywhere.
      for (const el of document.querySelectorAll('body *')) {
        const st = window.getComputedStyle(el);
        if (st.position !== 'fixed' && st.position !== 'absolute') continue;
        consider(el);
      }
      cands.sort((a, b) => b.fileInputs - a.fileInputs || a.area - b.area || b.buttons - a.buttons);
      // Drop larger candidates fully covered by a smaller one with the same counts.
      const filtered = cands.filter((c) => !cands.some((o2) => o2 !== c && o2.area < c.area && o2.fileInputs >= c.fileInputs && o2.buttons >= c.buttons && c.text.startsWith(o2.text.slice(0, 40))));
      return { ok: true, candidates: filtered.slice(0, 20) };
    }

    let el = null;
    try {
      el = document.querySelector(String(o.selector));
    } catch (e) {
      return { ok: false, error: 'bad-selector', message: String((e && e.message) || e) };
    }
    if (!el) return { ok: false, error: 'no-match', message: 'No element matches "' + o.selector + '"' };

    const text = normalize(el.innerText || '').slice(0, 4000);
    const buttons = [];
    for (const b of el.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], .link-internal, [onclick]')) {
      if (buttons.length >= 60 || !isElementVisible(b)) continue;
      const label = normalize(b.innerText || b.value || b.getAttribute('aria-label') || b.title || '').slice(0, 80);
      if (!label) continue;
      // ensureRef, not nextRef: re-inspecting the same panel used to hand every element a
      // brand-new ref, silently invalidating refs the caller was still holding. find_ui's text
      // path has always reused existing refs, so the two disagreed.
      const ref = ensureRef(b, 'x');
      buttons.push({ ref, label, kind: b.tagName.toLowerCase() + (b.getAttribute('type') ? ':' + b.getAttribute('type') : '') });
    }
    const inputs = [];
    for (const i of el.querySelectorAll('input, textarea, select')) {
      if (inputs.length >= 30) continue;
      const t = (i.getAttribute('type') || '').toLowerCase();
      if (t === 'hidden') continue;
      if (t !== 'file' && !isElementVisible(i)) continue;
      const ref = ensureRef(i, 'x');
      const d = describeInput(i, ref);
      if (t === 'file') d.kind = 'file';
      inputs.push(d);
    }
    return { ok: true, selector: String(o.selector), text, buttons, inputs };
  };

  /**
   * Restart the story in-page.
   *
   * Formats with an engine restart API are handled here. Everything else is the caller's job:
   * calling location.reload() from inside the bridge destroys the execution context that is
   * waiting for this return value, so the caller sees "Execution context was destroyed" and
   * the restart looks broken. The server reloads the page through Playwright instead.
   */
  const restart = () => {
    try {
      const E = window.Engine || (sugar() && sugar().Engine);
      if (E && typeof E.restart === 'function') { E.restart(); return { ok: true, method: 'engine' }; }
      return { ok: false, error: 'no-engine-restart', needsReload: true };
    } catch (e) {
      return { ok: false, error: 'restart-failed', message: String(e && e.message || e) };
    }
  };

  const back = () => {
    try {
      const E = window.Engine || (sugar() && sugar().Engine);
      if (E && typeof E.backward === 'function') {
        const moved = E.backward();
        return { ok: true, moved: moved !== false, method: 'sugarcube' };
      }
      if (E && typeof E.back === 'function') {
        const moved = E.back();
        return { ok: true, moved: moved !== false, method: 'engine-back' };
      }
      // Formats with a back control in the page but no engine API: Snowman renders a real
      // '← BACK' link, and telling the agent "no backward navigation API" while the button sits
      // right there is just wrong. Look for the control before giving up.
      // Be strict: only an explicit back affordance (a short label built around "back", or a
      // back arrow) qualifies. A passage link that merely mentions the word — "Go back to the
      // hall" — is a story choice, and clicking it would silently walk the story instead.
      // Only look in page chrome, never inside the passage: a story link labelled "Back" is a
      // choice that walks the narrative, and silently clicking it moves the story instead of
      // undoing it. Snowman puts its real affordance in the footer as "← BACK".
      const backLink = (() => {
        const chrome = document.querySelectorAll(
          'footer a, header a, footer button, header button, [data-cb-footer] a, .passage-footer a, #back-button, [data-cb-back]'
        );
        for (const el of chrome) {
          const text = normalize(el.textContent || '');
          const title = el.getAttribute('title') || el.getAttribute('aria-label') || '';
          const short = (text.split('\n')[0] || '').trim();
          const isBack = /back|undo/i.test(short) || /back|undo/i.test(title);
          if (!isBack) continue;
          if (!isElementVisible(el) || isFadingOut(el)) continue;
          return el;
        }
        return null;
      })();
      if (backLink) {
        backLink.click();
        return { ok: true, moved: true, method: 'dom-back' };
      }

      // Harlowe renders player-facing undo/redo controls inside <tw-sidebar>. Up to 3.1 the icon
      // carried class="undo"; 3.3.x dropped the class and identifies it by alt/title instead
      // (verified on 3.3.8 and 3.3.9 — a class-only selector silently lost back() on real games).
      const sidebars = Array.from(document.querySelectorAll('tw-sidebar, tw-passage > tw-sidebar'));
      let undo = null;
      for (const bar of sidebars) {
        const cands = Array.from(bar.querySelectorAll('tw-icon, .undo'));
        undo = cands.find((el) => {
          const marks = [el.getAttribute('title'), el.getAttribute('alt'), el.textContent];
          return marks.some((m) => m && /undo/i.test(String(m).trim()));
        }) || null;
        if (undo) break;
      }
      if (undo && isElementVisible(undo)) {
        undo.click();
        return { ok: true, moved: true, method: 'harlowe-undo' };
      }
      // Distinguish the two cases: a format with no notion of going back, versus a game that
      // has the control but hides it. Saying "this format has no backward navigation API" on
      // Harlowe is simply false — Harlowe has one, the game CSS removed it.
      return {
        ok: false,
        error: 'no-back-control',
        message:
          'No usable back control is visible on this page. The format may support going back but' +
          ' this game hides or omits the control (a hidden sidebar is common).'
      };
    } catch (e) {
      return { ok: false, error: 'back-failed', message: String(e && e.message || e) };
    }
  };

  const goTo = (passageName) => {
    try {
      if (!passageName) return { ok: false, error: 'missing-passage' };
      const S = sugar() || window;
      const E = window.Engine || (S && S.Engine);
      if (E && typeof E.play === 'function' && (S.State || S.Story)) {
        E.play(String(passageName));
        return { ok: true, method: 'engine' };
      }
      const storyObj = window.story;
      if (storyObj && typeof storyObj.show === 'function') {
        storyObj.show(String(passageName));
        return { ok: true, method: 'snowman-show' };
      }
      if (storyObj && typeof storyObj.go === 'function') {
        storyObj.go(String(passageName));
        return { ok: true, method: 'snowman-go' };
      }
      // No Harlowe branch on purpose: Harlowe 3.3 keeps Engine in module scope, so
      // window.Engine is undefined and the old check never fired. Keeping it made the docs
      // claim Harlowe could jump when it cannot.
      return { ok: false, error: 'unsupported' };
    } catch (e) {
      return { ok: false, error: 'goto-failed', message: String(e && e.message || e) };
    }
  };

  /**
   * SugarCube's Config.saves.isAllowed() is a *game* policy, not an engine capability: a passage
   * tagged "NoSave" (or a scripted rule) makes Save.base64.save() throw and Save.serialize()
   * return null. Reading it up front turns an opaque engine error into an actionable one.
   * A policy that throws is treated as "allowed" — the engine still has the final say.
   */
  const savingAllowed = (S) => {
    try {
      const fn = S && S.Config && S.Config.saves && S.Config.saves.isAllowed;
      if (typeof fn !== 'function') return true;
      return !!fn();
    } catch (_) {
      return true;
    }
  };

  const snapshotDisallowed = (passage) => ({
    ok: false,
    error: 'saving-disallowed',
    message:
      'The game itself blocks saving on the current passage' + (passage ? ' ("' + passage + '")' : '') +
      ' (SugarCube Config.saves.isAllowed() — usually a "NoSave" tag). Try again on a normal passage.'
  });

  const snapshot = () => {
    try {
      const S = sugar() || window;
      const allowed = savingAllowed(S);
      const passage = readPassageName(detectFormat().name);
      if (S.Save && S.Save.base64 && typeof S.Save.base64.save === 'function') {
        if (!allowed) return snapshotDisallowed(passage);
        const data = S.Save.base64.save();
        if (typeof data !== 'string' || !data) {
          return { ok: false, error: 'snapshot-failed', message: 'Save.base64.save() returned no data.' };
        }
        return { ok: true, data, method: 'sugarcube-base64' };
      }
      if (S.Save && typeof S.Save.serialize === 'function') {
        const data = S.Save.serialize();
        // SugarCube 2.21–2.36 return null (after popping an alert) when saving is disallowed.
        if (data === null || data === undefined) return allowed
          ? { ok: false, error: 'snapshot-failed', message: 'Save.serialize() returned null.' }
          : snapshotDisallowed(passage);
        return { ok: true, data: String(data), method: 'sugarcube-serialize' };
      }
      const g = window;
      if (g.engine && g.engine.state && typeof g.engine.state.saveToObject === 'function') {
        return { ok: true, data: JSON.stringify({ fmt: 'chapbook', vars: g.engine.state.saveToObject() }), method: 'chapbook-state' };
      }
      if (g.story && g.story.state && typeof g.story.state === 'object') {
        const vars = {};
        for (const k of Object.keys(g.story.state)) vars[k] = g.story.state[k];
        return {
          ok: true,
          data: JSON.stringify({ fmt: 'snowman', vars, passage: g.passage && g.passage.name ? g.passage.name : null }),
          method: 'snowman-state'
        };
      }
      return { ok: false, error: 'unsupported', message: 'No snapshot API for this story format.' };
    } catch (e) {
      return { ok: false, error: 'snapshot-failed', message: String(e && e.message || e) };
    }
  };

  const restore = async (data) => {
    try {
      const S = sugar() || window;
      if (!data) return { ok: false, error: 'missing-data' };
      if (S.Save && S.Save.base64 && typeof S.Save.base64.load === 'function') {
        // SugarCube v2.37+: returns a Promise and rejects while the engine is in the Init state.
        await S.Save.base64.load(String(data));
        return { ok: true, method: 'sugarcube-base64' };
      }
      if (S.Save && typeof S.Save.deserialize === 'function') {
        // SugarCube v2.21–v2.36: deserialize() both decodes and loads the save; null means failure.
        const loaded = S.Save.deserialize(String(data));
        if (loaded === null || loaded === false) {
          return { ok: false, error: 'restore-failed', message: 'Save.deserialize() returned null (corrupt or incompatible save data).' };
        }
        return { ok: true, method: 'sugarcube-deserialize' };
      }
      const g = window;
      let parsed = null;
      try {
        parsed = JSON.parse(String(data));
      } catch (_) {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'unsupported', message: 'No restore API for this story format.' };
      }
      if (parsed.fmt === 'chapbook' && g.engine && g.engine.state && typeof g.engine.state.restoreFromObject === 'function') {
        g.engine.state.restoreFromObject(parsed.vars);
        return { ok: true, method: 'chapbook-state' };
      }
      if (parsed.fmt === 'snowman' && g.story && g.story.state) {
        for (const k of Object.keys(g.story.state)) delete g.story.state[k];
        Object.assign(g.story.state, parsed.vars || {});
        const nav = typeof g.story.show === 'function' ? g.story.show : g.story.go;
        if (parsed.passage && typeof nav === 'function') nav.call(g.story, String(parsed.passage));
        return { ok: true, method: 'snowman-state' };
      }
      return { ok: false, error: 'unsupported', message: 'No restore API for this story format.' };
    } catch (e) {
      return { ok: false, error: 'restore-failed', message: String(e && e.message || e) };
    }
  };

  // ---------------------------------------------------------------------------
  // Engine introspection
  // ---------------------------------------------------------------------------

  /**
   * Read-only adapter over whatever the story format exposes on window.
   *
   * SugarCube, Chapbook and Snowman all leave their engine reachable; Harlowe does not (its
   * Engine/State live in module scope), so it reports unsupported rather than pretending.
   * This is the difference between "ask the engine one question" and "re-render the page and
   * regex the answer out of the prose".
   */
  /**
   * Passage count, read from the story data a compiled Twine file always carries.
   *
   * Each format exposes it differently, or not at all (Chapbook behind a function, Harlowe
   * nowhere), so counting <tw-passagedata> is both simpler and universally correct.
   */
  const totalPassages = () => {
    try {
      const data = document.querySelector('tw-storydata');
      return data ? data.querySelectorAll('tw-passagedata').length : null;
    } catch (_) {
      return null;
    }
  };

  const engineSummary = () => {
    const fmt = detectFormat().name;
    const g = window;
    const out = { format: fmt };
    out.storyPassages = totalPassages();
    try {
      if (fmt === 'sugarcube') {
        const S = sugar();
        if (!S || !S.State) return { ok: false, error: 'unsupported', message: 'SugarCube globals are not available yet.' };
        const vars = S.State.variables || {};
        out.passage = S.State.passage ?? null;
        out.turns = S.State.turns ?? null;
        out.variablesCount = Object.keys(vars).length;
        out.visitedCount = Array.isArray(S.State.passages) ? S.State.passages.length : null;

        out.engineState = S.Engine && typeof S.Engine.state === 'string' ? S.Engine.state : null;
        out.canSave = savingAllowed(S);
        return { ok: true, ...out };
      }
      if (fmt === 'chapbook') {
        const e = g.engine;
        if (!e || !e.state) return { ok: false, error: 'unsupported', message: 'Chapbook globals are not available yet.' };
        let trail = null;
        try { trail = e.state.get('trail'); } catch (_) { /* ignore */ }
        out.passage = Array.isArray(trail) && trail.length ? String(trail[trail.length - 1]) : null;
        // Distinct passages, not the raw trail: Chapbook's trail records repeats, so its length
        // was not comparable with SugarCube's de-duplicated State.passages.
        out.visitedCount = Array.isArray(trail) ? new Set(trail.map(String)).size : null;
        out.trailLength = Array.isArray(trail) ? trail.length : null;
        // varNames() returns dotted LEAF paths (config.style.page.font, ...), which is not the
        // same thing as SugarCube's top-level key count and silently made the two incomparable.
        // Report the top-level count as the headline and keep the leaf count under its own name.
        out.variablesCount = (() => {
          try {
            const names = typeof e.state.varNames === 'function' ? e.state.varNames() : [];
            if (!Array.isArray(names)) return null;
            return new Set(names.map((n) => String(n).split('.')[0])).size;
          } catch (_) { return null; }
        })();
        out.variableLeafPaths = (() => {
          try {
            const names = typeof e.state.varNames === 'function' ? e.state.varNames() : [];
            return Array.isArray(names) ? names.length : null;
          } catch (_) { return null; }
        })();

        return { ok: true, ...out };
      }
      if (fmt === 'snowman') {
        const st = g.story;
        if (!st) return { ok: false, error: 'unsupported', message: 'Snowman globals are not available yet.' };
        // On Snowman 2, story.passage is a FUNCTION (so .name would be "value", not the passage);
        // the current passage object lives on window.passage.
        out.passage = g.passage && g.passage.name ? String(g.passage.name) : null;
        out.variablesCount = st.state ? Object.keys(st.state).length : null;
        out.visitedCount = Array.isArray(st.history) ? st.history.length : null;

        return { ok: true, ...out };
      }
      if (fmt === 'harlowe') {
        const trail = harloweTrail() || [];
        const entry = harloweTrailEntry();
        out.passage = harloweTrailPassage();
        out.trailLength = trail.length;
        out.visitedCount = new Set(
          trail
            .map((x) => (typeof x === 'string' ? x : x && x.passage ? String(x.passage) : null))
            .filter(Boolean)
        ).size;
        out.variablesCount = entry && entry.variables ? Object.keys(entry.variables).length : 0;
        return { ok: true, ...out, note: 'Harlowe exposes no engine globals; values come from its session trail.' };
      }
    } catch (e) {
      return { ok: false, error: 'engine-failed', message: String(e && e.message || e) };
    }
    return { ok: false, error: 'unsupported', message: 'No readable engine for this story format.' };
  };

  /** Read specific variable paths without shipping the whole tree. */
  const enginePaths = (opts) => {
    const o = opts || {};
    const fmt = detectFormat().name;
    const S = sugar() || window;
    let store = null;
    if (fmt === 'sugarcube' && S.State) store = S.State.variables;
    else if (fmt === 'chapbook') { try { store = o.__all ? null : null; } catch (_) { /* ignore */ } }
    if (fmt !== 'sugarcube') {
      // Every format funnels through readVariables() already; reuse it so shapes stay identical.
      store = readVariables(fmt);
    }
    // Chapbook keeps its store behind engine.state rather than a plain object.
    // Chapbook's store is not a plain object: names come from varNames(), values from get().
    if (fmt === 'chapbook' && o.paths && o.paths.length) {
      try {
        const st = window.engine && window.engine.state;
        if (st && typeof st.get === 'function') {
          const values = {};
          const missing = [];
          for (const p of o.paths.map(String).slice(0, 50)) {
            try {
              const v = st.get(p);
              if (v === undefined) missing.push(p); else values[p] = sanitize(v, 0, new Set());
            } catch (_) { missing.push(p); }
          }
          return { ok: true, values, missing };
        }
      } catch (_) { /* ignore */ }
    }
    if (!store || typeof store !== 'object') {
      return { ok: false, error: 'unsupported', message: 'Story variables are not readable here.' };
    }
    const paths = Array.isArray(o.paths) ? o.paths.map(String).filter(Boolean).slice(0, 50) : [];
    const values = {};
    const missing = [];
    for (const p of paths) {
      const parts = String(p).replace(/^\$/, '').replace(/^V\./, '').split('.').filter(Boolean);
      let cur = store;
      let found = parts.length > 0;
      for (const part of parts) {
        if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
        else { found = false; break; }
      }
      if (found) values[p] = sanitize(cur, 0, new Set());
      else missing.push(p);
    }
    return { ok: true, values, missing };
  };

  /** Passages the player has actually reached — never the full list (that would spoil). */
  const engineVisited = () => {
    const fmt = detectFormat().name;
    const g = window;
    try {
      if (fmt === 'sugarcube') {
        const S = sugar();
        const list = S && S.State && Array.isArray(S.State.passages) ? S.State.passages.map(String) : [];
        return { ok: true, visited: list, count: list.length };
      }
      if (fmt === 'chapbook') {
        const st = g.engine && g.engine.state;
        let trail = null;
        try { trail = st && typeof st.get === 'function' ? st.get('trail') : null; } catch (_) { /* ignore */ }
        const list = Array.isArray(trail) ? trail.map((x) => (typeof x === 'string' ? x : x && x.passage ? String(x.passage) : null)).filter(Boolean) : [];
        return { ok: true, visited: list, count: list.length };
      }
      if (fmt === 'snowman') {
        // story.history holds numeric passage ids ([1,2,3]), so resolve them through
        // story.passages; a bare id would tell the agent nothing about where it has been.
        const h = g.story && Array.isArray(g.story.history) ? g.story.history : [];
        const byId = (id) => {
          const ps = g.story && g.story.passages;
          if (!ps) return null;
          const hit = typeof ps.find === 'function'
            ? ps.find((p) => p && String(p.id) === String(id))
            : Array.isArray(ps) ? ps.find((p) => p && String(p.id) === String(id)) : null;
          return hit && hit.name ? String(hit.name) : null;
        };
        const list = h
          .map((x) => (x && x.passage ? String(x.passage) : typeof x === 'string' ? x : byId(x)))
          .filter(Boolean);
        return { ok: true, visited: list, count: list.length };
      }
      if (fmt === 'harlowe') {
        const trail = harloweTrail() || [];
        const list = trail.map((x) => (typeof x === 'string' ? x : x && x.passage ? String(x.passage) : null)).filter(Boolean);
        return { ok: true, visited: list, count: list.length };
      }
    } catch (e) {
      return { ok: false, error: 'engine-failed', message: String(e && e.message || e) };
    }
    return { ok: false, error: 'unsupported', message: 'No visited-passage history for this story format.' };
  };

  const seed = (value) => {
    try {
      const S = sugar() || window;
      const prng = S.State && S.State.prng;
      if (!prng || typeof prng.init !== 'function') {
        return { ok: false, error: 'unsupported', message: 'No seedable PRNG for this story format.' };
      }
      prng.init(String(value));
      const E = window.Engine || (S && S.Engine);
      if (E && typeof E.restart === 'function') E.restart();
      return { ok: true, seed: String(value) };
    } catch (e) {
      return { ok: false, error: 'seed-failed', message: String(e && e.message || e) };
    }
  };

  window.__twineMCP = {
    version: 0.2,
    observe,
    waitStable,
    clickRef,
    resolveUi,
    findUi,
    inspectUi,
    fillRef,
    restart,
    back,
    goTo,
    snapshot,
    restore,
    seed,
    getVariables,
    engineSummary,
    enginePaths,
    engineVisited,
    // `detectFormat` stays internal: nothing outside the bridge needs it.
    meta: storyMeta
  };
})();
