import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { serveGame, type GameServer } from './static-server.js';

export interface ChoiceInfo {
  ref: string;
  label: string;
  kind: string;
  target: string | null;
  href: string | null;
  disabled: boolean;
  external: boolean;
}

export interface InputInfo {
  ref: string;
  kind: string;
  name: string | null;
  placeholder: string | null;
  value: string | null;
  options?: Array<{ value: string; label: string }>;
  disabled: boolean;
}

export interface Observation {
  ok: boolean;
  passage: string | null;
  format: string;
  formatVersion: string | null;
  story: Record<string, string | null>;
  url: string;
  title: string | null;
  text: string;
  choices: ChoiceInfo[];
  inputs: InputInfo[];
  status: string | null;
  variables: unknown;
  engineState: string | null;
  hasPassageRoot: boolean;
  readyState: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
  at: number;
}

export interface OpenGameOptions {
  source: string;
  headless?: boolean;
  seed?: string;
  chromePath?: string;
  viewport?: { width: number; height: number };
  waitTimeoutMs?: number;
  blockTrackers?: boolean;
}

/** Analytics / tracking hosts that many published games embed; blocked for quiet, private playtesting. */
const TRACKER_PATTERN =
  /(google-analytics\.com|googletagmanager\.com|doubleclick\.net|connect\.facebook\.net|hotjar\.com|mixpanel\.com|segment\.(io|com)|sentry\.io|cloudflareinsights\.com|newrelic\.com|matomo\.cloud|plausible\.io|statcounter\.com|yandex\.ru\/metrika)/i;

export interface JournalEntry {
  step: number;
  passage: string | null;
  action: string;
  target: string | null;
  at: number;
}

export interface GameSession {
  id: string;
  source: string;
  entryUrl: string;
  server: GameServer | null;
  context: BrowserContext;
  page: Page;
  console: ConsoleEntry[];
  lastObservation: Observation | null;
  snapshots: Map<string, { data: string; at: number }>;
  journal: JournalEntry[];
  step: number;
  seed: string | null;
}

interface BridgeResult {
  ok: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

let bridgeSourceCache: string | null = null;

function bridgeSource(): string {
  if (bridgeSourceCache) return bridgeSourceCache;
  const candidates = [
    new URL('./bridge/bridge.js', import.meta.url),
    new URL('../src/bridge/bridge.js', import.meta.url),
    new URL('../bridge/bridge.js', import.meta.url)
  ];
  for (const url of candidates) {
    const p = url.pathname;
    if (fs.existsSync(p)) {
      bridgeSourceCache = fs.readFileSync(p, 'utf8');
      return bridgeSourceCache;
    }
  }
  throw new Error('bridge.js not found; the package is missing src/bridge/bridge.js');
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

const normalizeLabel = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export class SessionManager {
  private browser: Browser | null = null;
  private browserHeadless: boolean | null = null;
  private browserLaunch: Promise<Browser> | null = null;
  private chromePath: string | undefined;
  readonly sessions = new Map<string, GameSession>();

  constructor(chromePath?: string) {
    this.chromePath = chromePath ?? process.env.TWMCP_CHROME_PATH;
  }

  private async launchBrowser(headless: boolean): Promise<Browser> {
    const attempts: Array<Record<string, unknown>> = [];
    if (this.chromePath) attempts.push({ executablePath: this.chromePath, headless });
    attempts.push({ channel: 'chrome', headless });
    attempts.push({ executablePath: '/usr/bin/google-chrome-stable', headless });
    attempts.push({ executablePath: '/usr/bin/google-chrome', headless });

    const errors: string[] = [];
    for (const opts of attempts) {
      try {
        return await chromium.launch({ ...(opts as object), args: ['--no-first-run', '--no-default-browser-check'] });
      } catch (err) {
        errors.push(String((err as Error)?.message ?? err).split('\n')[0] ?? '');
      }
    }
    throw new Error(
      `Could not launch Chrome. Tried: ${errors.join(' | ')}. ` +
        `Install Google Chrome, set TWMCP_CHROME_PATH, or run: npx playwright install chromium`
    );
  }

  private async ensureBrowser(headless: boolean): Promise<Browser> {
    if (this.browser && this.browser.isConnected() && this.browserHeadless === headless) return this.browser;
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    if (!this.browserLaunch) {
      this.browserLaunch = this.launchBrowser(headless)
        .then((b) => {
          this.browser = b;
          this.browserHeadless = headless;
          this.browserLaunch = null;
          return b;
        })
        .catch((err) => {
          this.browserLaunch = null;
          throw err;
        });
    }
    return this.browserLaunch;
  }

  async open(opts: OpenGameOptions): Promise<GameSession> {
    const headless = opts.headless ?? true;
    const browser = await this.ensureBrowser(headless);

    const server = isUrl(opts.source) ? null : await serveGame(opts.source);
    const entryUrl = server ? server.entryUrl : opts.source;

    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      locale: 'en-US'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);

    if (opts.blockTrackers ?? true) {
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (url.endsWith('/favicon.ico')) return route.fulfill({ status: 204, body: '' });
        if (TRACKER_PATTERN.test(url)) {
          return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* blocked by twine-play-mcp */' });
        }
        return route.continue();
      });
    }

    const id = 'game_' + crypto.randomBytes(3).toString('hex');
    const session: GameSession = {
      id,
      source: opts.source,
      entryUrl,
      server,
      context,
      page,
      console: [],
      lastObservation: null,
      snapshots: new Map(),
      journal: [],
      step: 0,
      seed: opts.seed ?? null
    };
    this.attachConsole(session);

    await page.addInitScript({ content: bridgeSource() });
    try {
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitStable(session, opts.waitTimeoutMs ?? 20000);

      if (opts.seed) {
        const seeded = await this.bridge<BridgeResult>(session, 'seed', opts.seed);
        if (!seeded.ok) {
          session.console.push({ type: 'warning', text: `seed ignored: ${seeded.message ?? seeded.error}`, at: Date.now() });
        } else {
          await this.waitStable(session, opts.waitTimeoutMs ?? 20000);
        }
      }

      session.lastObservation = await this.observe(session);
      this.sessions.set(id, session);
      return session;
    } catch (err) {
      await context.close().catch(() => undefined);
      await server?.close();
      throw err;
    }
  }

  private attachConsole(session: GameSession): void {
    const push = (entry: ConsoleEntry) => {
      if (session.console.length > 300) session.console.shift();
      session.console.push(entry);
    };
    session.page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      push({ type, text: msg.text().slice(0, 1200), location: msg.location()?.url, at: Date.now() });
    });
    session.page.on('pageerror', (err) => {
      push({ type: 'pageerror', text: String(err?.stack ?? err).slice(0, 2000), at: Date.now() });
    });
    session.page.on('response', (res) => {
      if (res.status() >= 400) push({ type: 'http', text: `${res.status()} ${res.url()}`, location: res.url(), at: Date.now() });
    });
  }

  get(id: string): GameSession {
    const session = this.sessions.get(id);
    if (!session) {
      const known = this.sessions.size ? [...this.sessions.keys()].join(', ') : '(none)';
      throw new Error(`Unknown game_id "${id}". Open games: ${known}`);
    }
    return session;
  }

  async bridge<T = BridgeResult>(session: GameSession, fn: string, arg?: unknown): Promise<T> {
    const result = await session.page.evaluate(
      ([name, value]) => {
        const api = (window as unknown as { __twineMCP?: Record<string, (a?: unknown) => unknown> }).__twineMCP;
        if (!api || typeof api[name as string] !== 'function') {
          return { ok: false, error: 'bridge-missing', message: 'window.__twineMCP is not available on this page.' };
        }
        return api[name as string]!(value);
      },
      [fn, arg] as const
    );
    return result as T;
  }

  async waitStable(session: GameSession, timeoutMs = 15000): Promise<BridgeResult> {
    return this.bridge<BridgeResult>(session, 'waitStable', { timeout: timeoutMs });
  }

  async observe(
    session: GameSession,
    opts: { includeVariables?: boolean; includeStatus?: boolean; maxTextChars?: number } = {}
  ): Promise<Observation> {
    const obs = await this.bridge<Observation & BridgeResult>(session, 'observe', {
      includeVariables: opts.includeVariables ?? true,
      includeStatus: opts.includeStatus ?? true,
      maxTextChars: opts.maxTextChars ?? 12000
    });
    session.lastObservation = obs;
    return obs;
  }

  async choose(
    session: GameSession,
    choice: number | string,
    expected?: string,
    allowExternal = false
  ): Promise<{ ok: boolean; error?: string; message?: string; observation?: Observation; clicked?: ChoiceInfo }> {
    const last = session.lastObservation;
    if (!last) return { ok: false, error: 'no-observation', message: 'Call observe first.' };

    let picked: ChoiceInfo | undefined;
    const choices = last.choices;
    if (typeof choice === 'number') {
      const idx = Math.trunc(choice);
      picked = idx >= 1 && idx <= choices.length ? choices[idx - 1] : undefined;
      if (!picked) {
        return { ok: false, error: 'bad-index', message: `Choice ${idx} is out of range 1..${choices.length}.`, observation: await this.observe(session) };
      }
      if (picked.disabled) {
        return { ok: false, error: 'choice-disabled', message: `Choice ${idx} ("${picked.label}") is disabled.`, observation: await this.observe(session) };
      }
    } else {
      const needle = normalizeLabel(choice);
      const visible = choices.filter((c) => !c.disabled);
      const exact = visible.filter((c) => normalizeLabel(c.label) === needle);
      const partial = exact.length ? exact : visible.filter((c) => normalizeLabel(c.label).includes(needle));
      if (partial.length === 0) {
        return {
          ok: false,
          error: 'no-such-choice',
          message: `No visible choice matches "${choice}".`,
          observation: await this.observe(session)
        };
      }
      if (partial.length > 1 && !exact.length) {
        return {
          ok: false,
          error: 'ambiguous-choice',
          message: `"${choice}" matches ${partial.length} choices; use a number or a longer label.`,
          observation: await this.observe(session)
        };
      }
      picked = partial[0];
    }

    if (!picked) return { ok: false, error: 'no-such-choice' };
    if (picked.external && !allowExternal) {
      return {
        ok: false,
        error: 'external-link-blocked',
        message: `"${picked.label}" leaves the game (${picked.href ?? 'external URL'}). Pass allow_external=true if you really want to follow it.`,
        observation: await this.observe(session)
      };
    }
    if (expected && !normalizeLabel(picked.label).includes(normalizeLabel(expected))) {
      return {
        ok: false,
        error: 'expectation-failed',
        message: `Choice ${picked.ref} is "${picked.label}", expected to contain "${expected}".`,
        observation: await this.observe(session)
      };
    }

    const selector = `[data-twmcp-ref="${picked.ref}"]`;
    let method = 'mouse';
    try {
      await session.page.locator(selector).click({ timeout: 2000 });
    } catch {
      const res = await this.bridge<BridgeResult>(session, 'clickRef', picked.ref);
      if (!res.ok) {
        return { ok: false, error: res.error ?? 'click-failed', message: res.message, observation: await this.observe(session) };
      }
      method = 'js';
    }

    await this.waitStable(session);
    session.step += 1;
    const observation = await this.observe(session);
    session.journal.push({
      step: session.step,
      passage: observation.passage,
      action: picked.label,
      target: picked.target,
      at: Date.now()
    });
    return { ok: true, clicked: { ...picked, kind: `${picked.kind}/${method}` }, observation };
  }

  async interact(
    session: GameSession,
    ref: string,
    value?: string
  ): Promise<{ ok: boolean; error?: string; message?: string; observation?: Observation }> {
    const selector = `[data-twmcp-ref="${ref}"]`;
    const locator = session.page.locator(selector);
    const count = await locator.count();
    if (count === 0) {
      return { ok: false, error: 'stale-ref', message: `Ref ${ref} is gone; call observe again.`, observation: await this.observe(session) };
    }
    const tag = await locator.first().evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
    try {
      if (tag === 'select') {
        await locator.first().selectOption({ label: value ?? '' }).catch(async () => {
          await locator.first().selectOption(value ?? '');
        });
      } else if (tag === 'input' || tag === 'textarea') {
        await locator.first().fill(value ?? '');
      } else {
        await locator.first().click({ timeout: 2000 });
      }
    } catch {
      const res = await this.bridge<BridgeResult>(session, 'fillRef', { ref, value });
      if (!res.ok) return { ok: false, error: res.error ?? 'interact-failed', message: res.message, observation: await this.observe(session) };
    }
    await this.waitStable(session);
    const observation = await this.observe(session);
    return { ok: true, observation };
  }

  async press(session: GameSession, key: string, ref?: string): Promise<{ ok: boolean; observation?: Observation }> {
    if (ref) {
      const locator = session.page.locator(`[data-twmcp-ref="${ref}"]`);
      if (await locator.count()) await locator.first().focus().catch(() => undefined);
    }
    await session.page.keyboard.press(key);
    await this.waitStable(session);
    const observation = await this.observe(session);
    return { ok: true, observation };
  }

  async wait(
    session: GameSession,
    opts: { ms?: number; forText?: string; timeoutMs?: number }
  ): Promise<{ ok: boolean; waitedMs: number; matched?: boolean; observation?: Observation }> {
    const timeout = Math.min(opts.timeoutMs ?? 15000, 120000);
    const t0 = Date.now();
    if (opts.forText) {
      try {
        await session.page.waitForFunction(
          (needle) => (document.body?.innerText ?? '').includes(needle as string),
          opts.forText,
          { timeout }
        );
      } catch {
        return { ok: true, waitedMs: Date.now() - t0, matched: false, observation: await this.observe(session) };
      }
      await this.waitStable(session);
      return { ok: true, waitedMs: Date.now() - t0, matched: true, observation: await this.observe(session) };
    }
    if (opts.ms) await new Promise((r) => setTimeout(r, Math.min(opts.ms!, timeout)));
    await this.waitStable(session);
    return { ok: true, waitedMs: Date.now() - t0, observation: await this.observe(session) };
  }

  async screenshot(session: GameSession): Promise<Buffer> {
    return session.page.screenshot({ type: 'png' });
  }

  async back(session: GameSession): Promise<{ ok: boolean; observation?: Observation; error?: string; message?: string }> {
    const res = await this.bridge<BridgeResult>(session, 'back');
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
    await this.waitStable(session);
    session.step += 1;
    const observation = await this.observe(session);
    session.journal.push({ step: session.step, passage: observation.passage, action: '(back)', target: null, at: Date.now() });
    return { ok: true, observation };
  }

  async restart(session: GameSession, seed?: string): Promise<{ ok: boolean; observation?: Observation; seeded?: boolean }> {
    if (seed) {
      const seeded = await this.bridge<BridgeResult>(session, 'seed', seed);
      if (seeded.ok) session.seed = seed;
    } else {
      await this.bridge<BridgeResult>(session, 'restart');
    }
    await this.waitStable(session, 20000);
    session.step = 0;
    session.journal.push({ step: 0, passage: null, action: seed ? `(restart seed=${seed})` : '(restart)', target: null, at: Date.now() });
    return { ok: true, observation: await this.observe(session), seeded: !!seed };
  }

  async saveState(session: GameSession, name: string): Promise<{ ok: boolean; error?: string; message?: string; bytes?: number }> {
    const res = await this.bridge<BridgeResult & { data?: string }>(session, 'snapshot');
    if (!res.ok || typeof res.data !== 'string') return { ok: false, error: res.error, message: res.message };
    session.snapshots.set(name, { data: res.data, at: Date.now() });
    return { ok: true, bytes: res.data.length };
  }

  async loadState(session: GameSession, name: string): Promise<{ ok: boolean; error?: string; message?: string; observation?: Observation }> {
    const snap = session.snapshots.get(name);
    if (!snap) {
      const names = [...session.snapshots.keys()].join(', ') || '(none)';
      return { ok: false, error: 'no-snapshot', message: `No snapshot named "${name}". Available: ${names}` };
    }
    const res = await this.bridge<BridgeResult>(session, 'restore', snap.data);
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
    await this.waitStable(session);
    const observation = await this.observe(session);
    session.journal.push({ step: session.step, passage: observation.passage, action: `(load:${name})`, target: null, at: Date.now() });
    return { ok: true, observation };
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.context.close().catch(() => undefined);
    await session.server?.close();
    return true;
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}
