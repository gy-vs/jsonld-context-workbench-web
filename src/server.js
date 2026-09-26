// Zero-dependency HTTP server: JSON API + static frontend.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { Store } from './store.js';
import { runParse } from './parse-service.js';
import { JsonLdError } from './jsonld/errors.js';
import { seedIfEmpty } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const DATA_FILE = process.env.WORKBENCH_DATA ?? join(__dirname, '..', 'data', 'store.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

export function createApp({ store = new Store(DATA_FILE) } = {}) {
  seedIfEmpty(store);

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, store);
    } catch (err) {
      sendError(res, err);
    }
  });

  return server;
}

async function route(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, offline: true, networkAccess: 'forbidden' });
  }

  // resources
  if (path === '/api/resources' && method === 'GET') {
    return sendJson(res, 200, { resources: store.listResources() });
  }
  if (path.startsWith('/api/resources/')) {
    const rest = decodeURIComponent(path.slice('/api/resources/'.length));
    const revMatch = rest.match(/^([^/]+)\/revisions\/([^/]+)$/);
    if (revMatch && method === 'GET') {
      return sendJson(res, 200, store.getRevision(revMatch[1], revMatch[2]));
    }
    const name = rest;
    if (method === 'GET') return sendJson(res, 200, store.getResource(name));
    if (method === 'PUT') {
      const body = await readJson(req);
      if (body === null || typeof body !== 'object' || !('body' in body)) {
        throw new JsonLdError('validation error', 'PUT expects { body, baseRevision }');
      }
      const result = store.putResource(name, body.body, body.baseRevision ?? null);
      return sendJson(res, 200, result);
    }
  }

  // sessions
  if (path === '/api/sessions' && method === 'GET') {
    return sendJson(res, 200, { sessions: store.listSessions() });
  }
  if (path === '/api/sessions' && method === 'POST') {
    const input = await readJson(req);
    return sendJson(res, 201, store.createSession(input ?? {}));
  }
  if (path.startsWith('/api/sessions/') && path.endsWith('/parse')) {
    const id = decodeURIComponent(path.split('/')[3]);
    if (method === 'POST') {
      const session = store.data.sessions[id];
      if (!session) throw new JsonLdError('not found', `Session "${id}" does not exist`);
      const input = await readJson(req);
      const snapshotMap = store.snapshotFor(session);
      if (input?.document !== undefined) {
        session.document = input.document;
        store.save();
      }
      const output = runParse({
        document: session.document,
        snapshotMap,
        baseUrl: input?.baseUrl ?? null,
        sessionId: id,
        maxDepth: input?.maxDepth ?? 64,
        maxContextDepth: input?.maxContextDepth ?? 32
      });
      return sendJson(res, 200, { sessionId: id, ...output });
    }
  }
  if (path.startsWith('/api/sessions/')) {
    const id = decodeURIComponent(path.slice('/api/sessions/'.length));
    if (method === 'GET') return sendJson(res, 200, store.getSession(id));
    if (method === 'DELETE') { store.deleteSession(id); return sendJson(res, 200, { deleted: true }); }
  }

  // ad-hoc parse (no persisted session)
  if (path === '/api/parse' && method === 'POST') {
    const input = await readJson(req);
    if (!input || typeof input.document !== 'object') {
      throw new JsonLdError('validation error', 'POST /api/parse expects { document, bindings, baseUrl }');
    }
    const { map, pinned } = store.resolveAdHocSnapshot(input.bindings ?? {});
    const output = runParse({
      document: input.document, snapshotMap: map,
      baseUrl: input.baseUrl ?? null,
      maxDepth: input.maxDepth ?? 64,
      maxContextDepth: input.maxContextDepth ?? 32
    });
    return sendJson(res, 200, { ...output, pinnedResources: pinned });
  }

  // static frontend
  if (method === 'GET') {
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      return sendJson(res, 403, { error: { code: 'forbidden', message: 'path escape' } });
    }
    try {
      const content = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(content);
      return;
    } catch (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { error: { code: 'not found', message: path } });
      throw err;
    }
  }

  sendJson(res, 404, { error: { code: 'not found', message: `${method} ${path}` } });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 5_000_000) reject(new JsonLdError('validation error', 'payload too large')); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(new JsonLdError('validation error', `Invalid JSON body: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendError(res, err) {
  const status = {
    'loading remote context failed': 400,
    'cyclic IRI mapping': 422,
    'context overflow': 422,
    'processing depth exceeded': 422,
    'protected term redefinition': 409,
    'revision conflict': 409,
    'unknown resource': 404,
    'not found': 404,
    'validation error': 400,
    'invalid base IRI': 400,
    'invalid vocab mapping': 400,
    'invalid IRI mapping': 400,
    'invalid term definition': 400,
    'invalid container mapping': 400,
    'invalid type mapping': 400,
    'invalid language mapping': 400,
    'invalid context entry': 400,
    'invalid remote context': 400
  }[err.code] ?? (err instanceof JsonLdError ? 422 : 500);
  sendJson(res, status, {
    error: {
      code: err.code ?? 'internal error',
      message: err.message,
      ...(err.details ? { details: err.details } : {})
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  createApp().listen(port, () => {
    console.log(`JSON-LD context workbench: http://localhost:${port} (offline; public contexts refused)`);
  });
}
