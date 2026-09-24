import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8'
};

export interface GameServer {
  /** http://127.0.0.1:<port>/ */
  baseUrl: string;
  /** URL of the entry html document. */
  entryUrl: string;
  root: string;
  close(): Promise<void>;
}

function findEntry(root: string, explicitFile?: string): string {
  if (explicitFile) return explicitFile;
  const index = path.join(root, 'index.html');
  if (fs.existsSync(index) && fs.statSync(index).isFile()) return index;

  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => e.name);

  if (candidates.length === 1) return path.join(root, candidates[0]!);
  if (candidates.length === 0) {
    throw new Error(`No HTML file found in ${root}. Point the tool at the published game HTML or its folder.`);
  }
  throw new Error(
    `Multiple HTML files in ${root}: ${candidates.join(', ')}. Pass the specific file instead of the folder.`
  );
}

/** Serve a local file or folder over 127.0.0.1 so that localStorage and saves work. */
export async function serveGame(target: string): Promise<GameServer> {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new Error(`Path not found: ${abs}`);
  const stat = fs.statSync(abs);
  const root = stat.isDirectory() ? abs : path.dirname(abs);
  const explicitFile = stat.isFile() ? abs : undefined;
  const entry = findEntry(root, explicitFile);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += path.basename(entry);

      let filePath = path.resolve(root, '.' + pathname);
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(filePath);
      } catch {
        st = null;
      }
      if (st?.isDirectory()) filePath = path.join(filePath, 'index.html');

      if (!st || !fs.existsSync(filePath)) {
        // Fall back to the entry document (some games use synthetic URLs).
        if (path.extname(pathname) === '') {
          filePath = entry;
        } else {
          res.writeHead(404).end('Not found');
          return;
        }
      }
      const body = fs.readFileSync(filePath);
      const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const relativeEntry = path.relative(root, entry).split(path.sep).join('/');

  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    entryUrl: `http://127.0.0.1:${port}/${relativeEntry}`,
    root,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}
