// 零依赖 HTTP 服务：REST API + 静态前端。
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ResourceStore } from './store.js';
import { expandDocument } from './expand.js';
import { JsonLdError } from './errors.js';
import { SEED_RESOURCES, SEED_DOCUMENT } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT ?? 5173);

// 数据目录延迟到 init() 时解析，便于测试在导入前/后通过环境变量指定
const resolveDataDir = () =>
  process.env.WORKBENCH_DATA_DIR ?? path.join(__dirname, 'data');

const store = new ResourceStore(resolveDataDir());

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function seedDefaults() {
  for (const r of SEED_RESOURCES) {
    await store.seedResource({ id: r.id, name: r.name, content: r.content });
  }
}

function makeLoaderForSession(sessionId) {
  return store.createLoader(sessionId);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const body = req.method === 'GET' || req.method === 'DELETE' ? null : await readJson(req);

  // ---- 资源 ----
  if (parts[1] === 'resources' && parts.length === 2) {
    if (req.method === 'GET') return json(res, 200, { resources: store.listResources() });
    if (req.method === 'POST') {
      const out = await store.createResource({
        id: body.id, name: body.name ?? body.id, content: body.content,
      });
      return json(res, 201, out);
    }
  }
  if (parts[1] === 'resources' && parts.length >= 3) {
    const id = decodeURIComponent(parts[2]);
    if (parts.length === 3) {
      if (req.method === 'GET') {
        const r = store.getResource(id);
        return json(res, 200, { resource: store.listResources().find((x) => x.id === id), detail: r });
      }
      if (req.method === 'PUT') {
        const out = await store.updateResource({
          id, content: body.content, expectedRevision: body.expectedRevision, note: body.note,
        });
        return json(res, 200, out);
      }
    }
    if (parts[3] === 'revisions' && parts.length === 5 && req.method === 'GET') {
      const rev = store.getRevision(id, decodeURIComponent(parts[4]));
      return json(res, 200, { revision: { revision: rev.revision, content: rev.content, createdAt: rev.createdAt } });
    }
    if (parts[3] === 'head' && parts.length === 4 && req.method === 'GET') {
      const rev = store.getRevision(id, undefined);
      return json(res, 200, { revision: { revision: rev.revision, content: rev.content, createdAt: rev.createdAt } });
    }
  }

  // ---- 会话 ----
  if (parts[1] === 'sessions' && parts.length === 2) {
    if (req.method === 'GET') return json(res, 200, { sessions: store.listSessions() });
    if (req.method === 'POST') {
      const out = await store.createSession({
        id: body.id ?? `s-${Math.random().toString(36).slice(2, 10)}`,
        name: body.name,
        rootRefs: body.rootRefs ?? [],
        document: body.document ?? null,
      });
      return json(res, 201, out);
    }
  }
  if (parts[1] === 'sessions' && parts.length >= 3) {
    const sid = decodeURIComponent(parts[2]);
    if (parts.length === 3 && req.method === 'GET') {
      const s = store.getSession(sid);
      return json(res, 200, {
        session: {
          ...store.listSessions().find((x) => x.id === sid),
          document: s.document,
        },
        staleness: store.sessionStaleness(sid),
      });
    }
    if (parts[3] === 'document' && req.method === 'PUT') {
      await store.setSessionDocument(sid, body.document);
      return json(res, 200, { id: sid });
    }
    if (parts[3] === 'rebind' && req.method === 'POST') {
      const out = await store.rebindSession(sid, body.pins ?? null);
      return json(res, 200, out);
    }
    if (parts[3] === 'stale' && req.method === 'GET') {
      return json(res, 200, store.sessionStaleness(sid));
    }
    if (parts[3] === 'expand' && req.method === 'POST') {
      const s = store.getSession(sid);
      const document = body.document ?? s.document;
      const rootRefs = body.rootRefs ?? null; // 可选：本次临时固定
      let loader;
      if (rootRefs) {
        const tmpId = `tmp-${Math.random().toString(36).slice(2, 10)}`;
        await store.createSession({ id: tmpId, name: tmpId, rootRefs, document: null });
        try {
          loader = store.createLoader(tmpId);
          return await runExpand(res, document, body.rootContext ?? null, loader, {
            maxDocumentDepth: body.maxDocumentDepth,
            maxContextDepth: body.maxContextDepth,
            sessionId: sid,
          });
        } finally {
          store.sessions.delete(tmpId);
        }
      }
      loader = makeLoaderForSession(sid);
      return await runExpand(res, document, body.rootContext ?? null, loader, {
        maxDocumentDepth: body.maxDocumentDepth,
        maxContextDepth: body.maxContextDepth,
        sessionId: sid,
      });
    }
  }

  // ---- 演示 ----
  if (parts[1] === 'seed-document' && req.method === 'GET') {
    return json(res, 200, { document: SEED_DOCUMENT });
  }
  if (parts[1] === 'health' && req.method === 'GET') {
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: { code: 'not-found', message: `未知 API 路径 ${url.pathname}` } });
}

async function runExpand(res, document, rootContext, loader, opts) {
  const result = expandDocument(document, rootContext, loader, {
    maxDocumentDepth: opts.maxDocumentDepth,
    maxContextDepth: opts.maxContextDepth,
  });
  return json(res, 200, {
    sessionId: opts.sessionId,
    document,
    root: result.root,
    trace: result.trace,
  });
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) {
      const e = new Error('请求体过大（上限 4MB）');
      e.code = 'payload-too-large';
      throw e;
    }
    chunks.push(c);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const e = new Error('请求体不是合法 JSON');
    e.code = 'invalid-json';
    throw e;
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA 回退
    try {
      const data = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (e) {
    if (process.env.WORKBENCH_DEBUG) console.error('expand/api error:', e);
    const code = e instanceof JsonLdError ? e.code : (e.code ?? 'internal-error');
    const status = {
      'revision-conflict': 409,
      'unknown-resource': 404,
      'session-stale': 409,
      'invalid-json': 400,
      'payload-too-large': 413,
      'invalid-context': 400,
      'invalid-term-definition': 400,
      'invalid-iri': 400,
      'invalid-protected-term-redefinition': 409,
      'context-cycle': 422,
      'context-depth-overflow': 422,
      'document-depth-overflow': 422,
      'remote-context-forbidden': 422,
      'resource-exists': 409,
    }[code] ?? 500;
    json(res, status, {
      error: {
        code,
        message: e.message,
        details: e.details ?? undefined,
      },
    });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await store.init(seedDefaults);
  server.listen(PORT, () => {
    console.log(`JSON-LD 上下文解析工作台: http://localhost:${PORT}`);
    console.log(`数据目录: ${DATA_DIR}`);
  });
}

export { server, store, seedDefaults };
