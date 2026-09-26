// 独立 API 端到端验证脚本（node test/api-standalone.js），用于不支持 node:test 子进程的环境。
// 与 test/api.test.js 等价：进程内监听临时端口。
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// 必须在 import server.js 之前设置（模块导入时会读取一次默认值）
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jld-api-standalone-'));
process.env.WORKBENCH_DATA_DIR = dataDir;
process.env.PORT = '0';
const { server, store, seedDefaults } = await import('../server.js');
await store.init(seedDefaults);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name);
    console.error('   ', e.stack || e.message);
    process.exitCode = 1;
  }
}
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

await test('种子资源与前端静态页可用', async () => {
  const { resources } = await call('GET', '/api/resources');
  assert.ok(resources.some((r) => r.id === 'ex-base'));
  const html = await fetch(base + '/').then((r) => r.text());
  assert.ok(html.includes('JSON-LD 上下文解析工作台'));
  const js = await fetch(base + '/app.js').then((r) => r.text());
  assert.ok(js.includes('decision'));
});

await test('会话 + expand：返回原文/展开树/trace', async () => {
  const { resources } = await call('GET', '/api/resources');
  const sess = await call('POST', '/api/sessions', {
    name: 'api-test', rootRefs: resources.map((r) => ({ resourceId: r.id })),
  }, 201);
  const doc = {
    '@context': 'ex-profile',
    id: 'people/9', type: 'Person',
    name_zh: '张三', homepage: 'https://h.example.org',
    nicknames: ['a', 'b'], labels: { zh: '张三' },
  };
  const out = await call('POST', `/api/sessions/${sess.id}/expand`, { document: doc });
  assert.equal(out.document['@context'], 'ex-profile');
  assert.equal(out.root.id, 'https://example.com/people/9');
  assert.equal(out.root.types[0].iri, 'https://schema.org/Person');
  const byName = Object.fromEntries(out.root.properties.map((p) => [p.name, p]));
  // name_zh 的 @id 为绝对 IRI，@language 标签生效
  assert.equal(byName.name_zh.iri, 'https://schema.org/name');
  assert.equal(byName.name_zh.values.language, 'zh');
  assert.deepEqual(byName.homepage.values.value, { '@id': 'https://h.example.org' });
  assert.equal(byName.nicknames.values.kind, 'list');
  assert.equal(byName.labels.values.kind, 'map');
  assert.ok(out.trace.layers.length >= 3);
});

await test('未知资源 -> 404 unknown-resource', async () => {
  const sess = await call('POST', '/api/sessions', { name: 'empty', rootRefs: [] }, 201);
  const res = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: { '@context': 'ex-base', x: 1 } }),
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'unknown-resource');
});

await test('公网 context -> 422 remote-context-forbidden', async () => {
  const { resources } = await call('GET', '/api/resources');
  const sess = await call('POST', '/api/sessions', {
    name: 'all', rootRefs: resources.map((r) => ({ resourceId: r.id })),
  }, 201);
  const res = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: { '@context': 'https://evil.example.com/c', x: 1 } }),
  });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'remote-context-forbidden');
});

await test('受保护词项冲突 -> 409', async () => {
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

await test('循环引用 -> 422 context-cycle', async () => {
  await call('POST', '/api/resources', { id: 'cyc-a', name: 'cyc-a', content: { '@context': ['cyc-b'] } }, 201);
  await call('POST', '/api/resources', { id: 'cyc-b', name: 'cyc-b', content: { '@context': ['cyc-a'] } }, 201);
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

await test('并发编辑：同 revision 两个 PUT 只有一个成功', async () => {
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
  assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [200, 409]);
  const conflict = r1.status === 409 ? await r1.json() : await r2.json();
  assert.equal(conflict.error.code, 'revision-conflict');
  assert.ok(conflict.error.details.currentContent);
});

await test('快照隔离：旧会话展开仍用词表 v1', async () => {
  const r1 = await call('POST', '/api/resources', {
    id: 'snap-c', name: 'snap', content: { '@context': { '@vocab': 'https://v1/' } },
  }, 201);
  const sess = await call('POST', '/api/sessions', {
    name: 'locked', rootRefs: [{ resourceId: 'snap-c', revision: r1.revision }],
  }, 201);
  await call('PUT', '/api/resources/snap-c', {
    content: { '@context': { '@vocab': 'https://v2/' } }, expectedRevision: r1.revision,
  });
  const out = await call('POST', `/api/sessions/${sess.id}/expand`, { document: { '@context': 'snap-c', thing: 1 } });
  assert.equal(out.root.properties[0].iri, 'https://v1/thing');
  const stale = await call('GET', `/api/sessions/${sess.id}/stale`);
  assert.equal(stale.stale.length, 1);
});

await test('非法 JSON -> 400；文档过深 -> 422', async () => {
  const { resources } = await call('GET', '/api/resources');
  const sess = await call('POST', '/api/sessions', {
    name: 'all', rootRefs: resources.map((r) => ({ resourceId: r.id })),
  }, 201);
  const resBad = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
  });
  assert.equal(resBad.status, 400);

  let doc = 'x';
  for (let i = 0; i < 100; i++) doc = { '@context': 'ex-base', child: doc };
  const resDeep = await fetch(base + `/api/sessions/${sess.id}/expand`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc, maxDocumentDepth: 32 }),
  });
  assert.equal(resDeep.status, 422);
  assert.equal((await resDeep.json()).error.code, 'document-depth-overflow');
});

server.close();
console.log(`\n${passed} 个 API 端到端检查通过`);
