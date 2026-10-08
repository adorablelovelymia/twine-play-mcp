import http from 'node:http';
import { spawn } from 'node:child_process';
import type { GameSession, SessionManager } from './session.js';
import { renderObservation } from './render.js';

/**
 * Tiny local web server that lets a human watch the actual Playwright page the agent is driving.
 *
 * - GET /                → index of open games
 * - GET /v/<game_id>     → viewer page: JPEG frames (~1/s) + passage/step/journal/text
 * - GET /f/<game_id>.jpg → latest frame (captured on demand, coalesced, cached briefly)
 * - GET /s/<game_id>.json→ small status JSON for the viewer's auto-refresh
 *
 * Everything is local-only (127.0.0.1). Frames are captured lazily: with no viewers, zero cost.
 * Override with TWMCP_VIEW_PORT / TWMCP_VIEW_HOST.
 */

interface CachedFrame {
  jpeg: Buffer;
  at: number;
}

/** Reuse a frame newer than this instead of taking another screenshot. */
const MIN_FRAME_AGE_MS = 350;

const frames = new Map<string, CachedFrame>();
const capturing = new Map<string, Promise<CachedFrame | null>>();

let server: http.Server | null = null;
let boundPort = 0;
let manager: SessionManager | null = null;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

async function captureFrame(session: GameSession): Promise<CachedFrame | null> {
  const prev = frames.get(session.id);
  try {
    const jpeg = await session.page.screenshot({ type: 'jpeg', quality: 62 });
    const frame = { jpeg, at: Date.now() };
    frames.set(session.id, frame);
    return frame;
  } catch {
    return prev ?? null; // mid-navigation hiccup: keep showing the last good frame
  }
}

async function getFrame(session: GameSession): Promise<CachedFrame | null> {
  const cached = frames.get(session.id);
  if (cached && Date.now() - cached.at < MIN_FRAME_AGE_MS) return cached;
  const pending = capturing.get(session.id);
  if (pending) return pending;
  const p = captureFrame(session).finally(() => capturing.delete(session.id));
  capturing.set(session.id, p);
  return p;
}

function statusOf(session: GameSession) {
  const obs = session.lastObservation;
  return {
    ok: true,
    game: session.id,
    title: obs?.story?.title ?? obs?.title ?? '(unknown)',
    format: obs?.format ?? '?',
    formatVersion: obs?.formatVersion ?? null,
    passage: obs?.passage ?? null,
    step: session.step,
    engineState: obs?.engineState ?? null,
    source: session.source,
    journal: session.journal.slice(-8).map((j) => ({ step: j.step, passage: j.passage, action: j.action }))
  };
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

function notFound(res: http.ServerResponse, id: string): void {
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;background:#101216;color:#e8eaf0;padding:24px">` +
      `<h2>Game not open</h2><p><code>${esc(id)}</code> is not an open session — it may have been closed. ` +
      `<a style="color:#7fb4ff" href="/">See open games</a>.</p></body>`
  );
}

function indexPage(): string {
  const sessions = [...(manager?.sessions.values() ?? [])];
  const rows = sessions.length
    ? sessions
        .map((s) => {
          const st = statusOf(s);
          return `<li><a href="/v/${s.id}">${esc(st.title)}</a> <span class="meta">${s.id} · passage “${esc(
            st.passage ?? '?'
          )}” · step ${st.step}</span></li>`;
        })
        .join('')
    : '<li class="meta">No open games.</li>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>twine-play live view</title>
<style>
  :root{color-scheme:dark} body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#101216;color:#e8eaf0}
  header{padding:12px 16px;border-bottom:1px solid #262b36} h1{font-size:16px;margin:0}
  main{padding:12px 16px 40px} a{color:#7fb4ff;text-decoration:none} a:hover{text-decoration:underline}
  ul{padding-left:20px} li{margin:6px 0} .meta{color:#9aa3b2;font-size:12.5px}
</style></head>
<body><header><h1>twine-play live view</h1></header>
<main><ul>${rows}</ul>
<p class="meta">Pages refresh the screenshot about once a second. Frames are only captured while someone is watching.</p>
</main></body></html>`;
}

function viewerPage(session: GameSession): string {
  const st = statusOf(session);
  let text = '';
  if (session.lastObservation) {
    try {
      text = renderObservation(session.lastObservation, { step: session.step, consoleCount: session.console.length, sinceLast: false, previous: null });
    } catch {
      text = '';
    }
  }
  if (text.length > 8000) text = text.slice(0, 8000) + '\n… (truncated; use observe for the full text)';
  const journal = st.journal
    .map((j) => `<li><code>#${j.step}</code> ${esc(j.action)}${j.passage ? ` <span class="meta">@ ${esc(j.passage)}</span>` : ''}</li>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(st.title)} — live view</title>
<style>
  :root{color-scheme:dark} *{box-sizing:border-box}
  body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:#101216;color:#e8eaf0}
  header{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;padding:9px 14px;
    border-bottom:1px solid #262b36;background:rgba(16,18,22,.96)}
  h1{font-size:15px;margin:0 6px 0 0} .meta{color:#9aa3b2;font-size:12.5px} .meta b{color:#cfd6e4;font-weight:600}
  .pill{border:1px solid #2c3342;border-radius:999px;padding:1px 9px;color:#9aa3b2;font-size:11.5px}
  main{padding:12px 14px 48px;max-width:1300px}
  #shot{display:block;width:100%;background:#000;border:1px solid #232936;border-radius:8px}
  #err{display:none;margin:6px 0;color:#ffb4b4;font-size:12.5px}
  details{margin-top:10px} summary{cursor:pointer;color:#9aa3b2}
  ol.journal{margin:8px 0 0;padding-left:20px;color:#b9c2d2;font-size:12.5px} ol.journal li{margin:2px 0}
  code{background:#1a1f29;padding:0 4px;border-radius:4px}
  pre{white-space:pre-wrap;background:#151922;border:1px solid #232936;border-radius:8px;padding:10px;max-height:50vh;overflow:auto}
</style></head>
<body>
<header>
  <h1>${esc(st.title)}</h1>
  <span class="meta">passage <b id="passage">${esc(st.passage ?? '—')}</b></span>
  <span class="meta">step <b id="step">${st.step}</b></span>
  <span class="meta">state <b id="state">${esc(st.engineState ?? '—')}</b></span>
  <span class="pill" id="live">live</span>
  <span class="meta">${session.id} · ${esc(st.format)}${st.formatVersion ? ` ${esc(st.formatVersion)}` : ''}</span>
</header>
<main>
  <div id="err"></div>
  <a href="/f/${session.id}.jpg" target="_blank"><img id="shot" src="/f/${session.id}.jpg?t=${Date.now()}" alt="live screenshot of the game"></a>
  <details><summary>Recent actions (${st.journal.length})</summary><ol class="journal" id="journal">${journal}</ol></details>
  <details><summary>Passage text at page load</summary><pre id="text">${esc(text)}</pre></details>
</main>
<script>
const id = ${JSON.stringify(session.id)};
const shot = document.getElementById('shot');
const err = document.getElementById('err');
const jr = document.getElementById('journal');
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
shot.addEventListener('load', () => { err.style.display = 'none'; });
shot.addEventListener('error', () => { err.textContent = 'screenshot failed — retrying…'; err.style.display = 'block'; });
async function tick() {
  shot.src = '/f/' + id + '.jpg?t=' + Date.now();
  try {
    const r = await fetch('/s/' + id + '.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    document.getElementById('passage').textContent = j.passage ?? '—';
    document.getElementById('step').textContent = j.step;
    document.getElementById('state').textContent = j.engineState ?? '—';
    jr.innerHTML = (j.journal ?? []).map((x) =>
      '<li><code>#' + x.step + '</code> ' + esc(x.action ?? '') + (x.passage ? ' <span class="meta">@ ' + esc(x.passage) + '</span>' : '') + '</li>').join('');
    document.getElementById('live').textContent = 'live · ' + new Date().toLocaleTimeString();
  } catch (e) {
    err.textContent = 'game closed or unreachable (' + e.message + ')';
    err.style.display = 'block';
  }
}
setInterval(tick, 900);
tick();
</script>
</body></html>`;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const get = (id: string) => manager?.sessions.get(id);

  if (p === '/' || p === '/index.html') {
    const html = Buffer.from(indexPage());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length, 'cache-control': 'no-store' });
    return void res.end(html);
  }
  let m = /^\/v\/([A-Za-z0-9_-]+)\/?$/.exec(p);
  if (m) {
    const session = get(m[1]!);
    if (!session) return notFound(res, m[1]!);
    const html = Buffer.from(viewerPage(session));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length, 'cache-control': 'no-store' });
    return void res.end(html);
  }
  m = /^\/f\/([A-Za-z0-9_-]+)\.jpg$/.exec(p);
  if (m) {
    const session = get(m[1]!);
    if (!session) return notFound(res, m[1]!);
    const frame = await getFrame(session);
    if (!frame) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('no frame available yet');
    }
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': frame.jpeg.length,
      'cache-control': 'no-store',
      'x-frame-at': String(frame.at)
    });
    return void res.end(frame.jpeg);
  }
  m = /^\/s\/([A-Za-z0-9_-]+)\.json$/.exec(p);
  if (m) {
    const session = get(m[1]!);
    if (!session) return json(res, 404, { ok: false, error: 'no-such-game', game: m[1] });
    return json(res, 200, statusOf(session));
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function listen(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handle(req, res).catch(() => {
        try {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal error');
        } catch {
          /* ignore */
        }
      });
    });
    s.once('error', reject);
    s.listen(port, host, () => {
      server = s;
      boundPort = port;
      s.unref(); // never keep the MCP process alive just for the viewer
      resolve();
    });
  });
}

async function ensureServer(): Promise<number> {
  if (server) return boundPort;
  const host = process.env.TWMCP_VIEW_HOST ?? '127.0.0.1';
  const base = Number(process.env.TWMCP_VIEW_PORT ?? 4571);
  const start = Number.isFinite(base) && base > 0 ? base : 4571;
  const errors: string[] = [];
  for (let i = 0; i < 12; i++) {
    try {
      await listen(start + i, host);
      return boundPort;
    } catch (err) {
      errors.push(`${start + i}: ${String((err as Error)?.message ?? err).split('\n')[0] ?? ''}`);
    }
  }
  throw new Error(`Could not start the live-view server on ${host}: ${errors.join(' | ')}`);
}

/** URL of the live viewer for this session (starts the shared server on first use). */
export async function liveViewUrl(mgr: SessionManager, session: GameSession): Promise<string> {
  manager = mgr;
  const port = await ensureServer();
  return `http://${process.env.TWMCP_VIEW_HOST ?? '127.0.0.1'}:${port}/v/${session.id}`;
}

/** Drop cached frames for a closed session. */
export function forgetLiveView(id: string): void {
  frames.delete(id);
  capturing.delete(id);
  reported.delete(id);
  autoOpened.delete(id);
}

/** Sessions for which a browser tab was already auto-opened. */
const autoOpened = new Set<string>();

/**
 * Sessions whose live-view URL was already handed out. The first call explains how the view
 * works; later calls only repeat the URL, because the explanation is identical every time.
 */
const reported = new Set<string>();

/** True the first time it is called for a session, false afterwards. */
export function claimFirstReport(id: string): boolean {
  if (reported.has(id)) return false;
  reported.add(id);
  return true;
}

/**
 * Guard so a careless agent cannot spawn a new browser tab on every live_view call:
 * returns true only the first time it is asked for a given session.
 */
export function claimAutoOpen(id: string): boolean {
  if (autoOpened.has(id)) return false;
  autoOpened.add(id);
  return true;
}

/** Open a URL in the user's default browser (best effort; returns false when unavailable). */
export function openInBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
