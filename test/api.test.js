// HTTP API 端到端：进程内监听临时端口，覆盖展开、未知资源、revision 冲突与并发。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jld-api-'));
process.env.WORKBENCH_DATA_DIR = dataDir;
const { server, store, seedDefaults } = await import('../server.js');
await store.init(seedDefaults);

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const call = async (method, url, body, expectStatus = 200) => {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  assert.equal(res.status, expectStatus, `${method} ${url} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};

test('种子资源与前端静态页可用', async () => {
  const { resources } = await call('GET', '/api/resources');
  assert.ok(resources.some((r) => r.id === 'ex-base'));
  const html = await fetch(base + '/').then((r) => r.text());
  assert.ok(html.includes('JSON-LD 上下文解析工作台'));
  const js = await fetch(base + '/app.js').then((r) => r.text());
  assert.ok(js.includes('decision'));
});

test('会话 + expand：返回原文/展开树/trace，关键字别名与容器生效', async () => {
  const { resources } = await call('GET', '/api/resources');
  const sess = await call('POST', '/api/sessions', {
    name: 'api-test', rootRefs: resources.map((r) => ({ resourceId: r.id })),
  }, 201);

  const doc = {
    '@context': 'ex-profile',
    id: 'people/9', type: 'Person',
    name_zh: '张三', homepage: 'https://h.example.org',
    nicknames: ['a', 'b'],
    labels: { zh: '张三' },
  };
  const out = await call('POST', `/api/sessions/${sess.id}/expand`, { document: doc });
  assert.equal(out.document['@context'], 'ex-profile');
  assert.equal(out.root.id, 'https://example.com/people/9');
  assert.equal(out.root.types[0].iri, 'https://schema.org/Person');
  const byName = Object.fromEntries(out.root.properties.map((p) => [p.name, p]));
  assert.equal(byName.name_zh.iri, 'https://schema.org/name');
  assert.equal(byName.name_zh.values.language, 'zh');
  assert.deepEqual(byName.homepage.values.value, { '@id': 'https://h.example.org' });
  assert.equal(byName.nicknames.values.kind, 'list');
  assert.equal(byName.labels.values.kind, 'map');
  assert.ok(out.trace.layers.length >= 3);
  assert.ok(out.trace.events.some((e) => e.kind === 'include'));
});

test('未知资源：引用未固定资源返回 404 unknown-resource', async () => {
  const sess = await call('POST', '/api/sessions', { name: 'empty', rootRefs: [] }, 201);
  const res = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: { '@context': 'ex-base', x: 1 } }),
  });
  assert.equal(res.status, 404);
  const j = await res.json();
  assert.equal(j.error.code, 'unknown-resource');
});

test('公网 context 拒绝：422 remote-context-forbidden', async () => {
  const { resources } = await call('GET', '/api/resources');
  const sess = await call('POST', '/api/sessions', {
    name: 'all', rootRefs: resources.map((r) => ({ resourceId: r.id })),
  }, 201);
  const res = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: { '@context': 'https://evil.example.com/c', x: 1 } }),
  });
  assert.equal(res.status, 422);
  const j = await res.json();
  assert.equal(j.error.code, 'remote-context-forbidden');
});

test('受保护词项冲突：409 invalid-protected-term-redefinition', async () => {
  const { resources } = await call('GET', '/api/resources');
  const sess = await call('POST', '/api/sessions', {
    name: 'all', rootRefs: resources.map((r) => ({ resourceId: r.id })),
  }, 201);
  const res = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: { '@context': ['ex-base', { name: 'https://other/name' }], name: 'x' } }),
  });
  assert.equal(res.status, 409);
  const j = await res.json();
  assert.equal(j.error.code, 'invalid-protected-term-redefinition');
  assert.equal(j.error.details.term, 'name');
});

test('循环引用：422 context-cycle 并回传引用链', async () => {
  await call('POST', '/api/resources', {
    id: 'cyc-a', name: 'cyc-a',
    content: { '@context': ['cyc-b'] },
  }, 201);
  await call('POST', '/api/resources', {
    id: 'cyc-b', name: 'cyc-b',
    content: { '@context': ['cyc-a'] },
  }, 201);
  const sess = await call('POST', '/api/sessions', {
    name: 'cyc', rootRefs: [{ resourceId: 'cyc-a' }, { resourceId: 'cyc-b' }],
  }, 201);
  const res = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: { '@context': 'cyc-a' } }),
  });
  assert.equal(res.status, 422);
  const j = await res.json();
  assert.equal(j.error.code, 'context-cycle');
  assert.ok(j.error.details.chain.includes('cyc-a'));
});

test('并发编辑：两个同 revision PUT 只有一个成功，另一个 409', async () => {
  const created = await call('POST', '/api/resources', {
    id: 'edit-x', name: 'edit-x', content: { '@context': { v: 1 } },
  }, 201);
  const url = `/api/resources/edit-x`;
  const [r1, r2] = await Promise.all([
    fetch(base + url, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: { '@context': { v: 'A' } }, expectedRevision: created.revision }),
    }),
    fetch(base + url, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: { '@context': { v: 'B' } }, expectedRevision: created.revision }),
    }),
  ]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const conflict = r1.status === 409 ? await r1.json() : await r2.json();
  assert.equal(conflict.error.code, 'revision-conflict');
  assert.ok(conflict.error.details.currentContent);
});

test('快照隔离：会话锁定旧 revision，资源 head 更新后展开仍用旧词表', async () => {
  const r1 = await call('POST', '/api/resources', {
    id: 'snap-c', name: 'snap', content: { '@context': { '@vocab': 'https://v1/' } },
  }, 201);
  const sess = await call('POST', '/api/sessions', {
    name: 'locked', rootRefs: [{ resourceId: 'snap-c', revision: r1.revision }],
  }, 201);

  // 更新 head 到 v2
  await call('PUT', '/api/resources/snap-c', {
    content: { '@context': { '@vocab': 'https://v2/' } }, expectedRevision: r1.revision,
  });

  const out = await call('POST', `/api/sessions/${sess.id}/expand`, { document: { '@context': 'snap-c', thing: 1 } });
  assert.equal(out.root.properties[0].iri, 'https://v1/thing'); // 旧快照

  const stale = await call('GET', `/api/sessions/${sess.id}/stale`);
  assert.equal(stale.stale.length, 1);
});

test('非法 JSON / 深度超限返回结构化错误', async () => {
  const { resources } = await call('GET', '/api/resources');
  const sess = await call('POST', '/api/sessions', {
    name: 'all', rootRefs: resources.map((r) => ({ resourceId: r.id })),
  }, 201);
  const resBad = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(resBad.status, 400);

  let doc = 'x';
  for (let i = 0; i < 100; i++) doc = { '@context': 'ex-base', child: doc };
  const resDeep = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc, maxDocumentDepth: 32 }),
  });
  assert.equal(resDeep.status, 422);
  const j = await resDeep.json();
  assert.equal(j.error.code, 'document-depth-overflow');
});

test.after(() => server.close());
