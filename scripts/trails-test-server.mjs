// Serves the built site for the trail app's browser tests, with a local stand-in for the backup API.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createBackupHandler } from '../apps/trails/server/backup-core.mjs';
import { memoryBucket, memoryStore } from '../apps/trails/server/memory-store.mjs';

const root = resolve('dist');
const localCodes = new Map();
const backupHandler = createBackupHandler({
  store: memoryStore(),
  bucket: memoryBucket(),
  sendCode: async (email, code) => { localCodes.set(email, code); },
  pepper: 'local-preview-only',
  cookieSecure: false,
  // Every local request shares one address, and a test run would trip the real limits.
  limits: { startPerEmail: 1000, startPerAddress: 1000, verifyPerAddress: 1000, verifyPerEmailPerDay: 1000, mailPerDay: 100000, newAccountsPerDay: 100000 },
});
const port = Number(process.env.PORT || 4174);
async function trailHeaders() {
  const lines = (await readFile(join(root, '_headers'), 'utf8')).split(/\r?\n/).filter(line => /^\s+\S+:/.test(line));
  return Object.fromEntries(lines.map(line => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (path === '/__local/last-code') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(localCodes.get(url.searchParams.get('email')) || '');
      return;
    }
    if (path.startsWith('/api/hike/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const hasBody = !['GET', 'HEAD'].includes(req.method) && chunks.length > 0;
      const response = await backupHandler(new Request(new URL(req.url, `http://${req.headers.host}`), {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, value]) => typeof value === 'string'),
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const absolute = resolve(root, `.${path}`);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    let file = absolute;
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const type = types[Object.keys(types).find(extension => file.endsWith(extension))] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, ...(path.startsWith('/trails/') ? await trailHeaders() : {}) });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Trail app preview: http://127.0.0.1:${port}/trails/`));
