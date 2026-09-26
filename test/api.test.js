// HTTP API integration tests, including concurrent editing from two "pages".
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

let server, base, store;

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-api-'));
  store = new Store(join(dir, 'store.json'));
  server = createApp({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe('resources API', () => {
  test('seeds demo resources on an empty store', async () => {
    const { status, json } = await api('GET', '/api/resources');
    assert.equal(status, 200);
    const names = json.resources.map(r => r.name);
    assert.ok(names.includes('schema') && names.includes('secure'));
  });

  test('PUT creates, GET reads back, revisions listed', async () => {
    const create = await api('PUT', '/api/resources/colors', {
      body: { '@vocab': 'https://colors.example/' },
      baseRevision: null
    });
    assert.equal(create.status, 200);
    assert.equal(create.json.created, true);

    const got = await api('GET', '/api/resources/colors');
    assert.equal(got.json.body['@vocab'], 'https://colors.example/');
    assert.equal(got.json.revisionCount, 1);

    const update = await api('PUT', '/api/resources/colors', {
      body: { '@vocab': 'https://colors.example/v2/' },
      baseRevision: got.json.latestRevision
    });
    assert.equal(update.status, 200);
    const got2 = await api('GET', '/api/resources/colors');
    assert.equal(got2.json.revisionCount, 2);
  });

  test('concurrent edits: first save wins, second gets 409 revision conflict', async () => {
    await api('PUT', '/api/resources/race', { body: { v: 0 }, baseRevision: null });
    const { json: before } = await api('GET', '/api/resources/race');
    const baseRev = before.latestRevision;

    // Two pages save diverging bodies based on the same revision.
    const [a, b] = await Promise.all([
      api('PUT', '/api/resources/race', { body: { v: 'A' }, baseRevision: baseRev }),
      api('PUT', '/api/resources/race', { body: { v: 'B' }, baseRevision: baseRev })
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const loser = a.status === 409 ? a : b;
    assert.equal(loser.json.error.code, 'revision conflict');
    assert.ok(loser.json.error.details.currentRevision);

    // Loser merges on top of the winner and succeeds.
    const retry = await api('PUT', '/api/resources/race', {
      body: { v: 'B-merged' },
      baseRevision: loser.json.error.details.currentRevision
    });
    assert.equal(retry.status, 200);
    const final = await api('GET', '/api/resources/race');
    assert.equal(final.json.body.v, 'B-merged');
    assert.equal(final.json.revisionCount, 3);
  });

  test('update without baseRevision is rejected (no silent last-write-wins)', async () => {
    await api('PUT', '/api/resources/guard', { body: { v: 1 }, baseRevision: null });
    const res = await api('PUT', '/api/resources/guard', { body: { v: 2 } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'revision conflict');
  });
});

describe('parse API', () => {
  test('ad-hoc parse expands and returns traces + decision chain', async () => {
    const res = await api('POST', '/api/parse', {
      document: {
        '@context': 'local:schema',
        'id': 'thing/7',
        'kind': 'Product',
        'created': '2026-09-26'
      },
      bindings: { schema: 'latest' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.expanded[0]['@id'], 'https://example.com/things/thing/7');
    assert.deepEqual(res.json.expanded[0]['@type'], ['https://schema.org/Product']);
    assert.ok(res.json.traces.some(t => t.sourcePath === '$.id' && t.kind === 'node-id'));
    assert.ok(res.json.decisionChain.some(c => c.kind === 'include' && c.ref === 'local:schema' && c.revision));
    assert.equal(res.json.pinnedResources.schema, res.json.decisionChain.find(c => c.kind === 'include').revision);
  });

  test('remote http context is refused with a clear error', async () => {
    const res = await api('POST', '/api/parse', {
      document: { '@context': 'https://schema.org/docs/jsonldcontext.jsonld', 'name': 'x' },
      bindings: {}
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'loading remote context failed');
    assert.match(res.json.error.message, /never accesses the public network/);
  });

  test('unknown local resource reports 404 with known resources', async () => {
    const res = await api('POST', '/api/parse', {
      document: { '@context': 'local:does-not-exist', 'a': 1 },
      bindings: {}
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'unknown resource');
  });

  test('protected term redefinition surfaces as 409 with details', async () => {
    const res = await api('POST', '/api/parse', {
      document: {
        '@context': ['local:secure', { 'owner': { '@id': 'https://evil.example/owner' } }],
        'owner': 'mallory'
      },
      bindings: { secure: 'latest' }
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'protected term redefinition');
    assert.equal(res.json.error.details.term, 'owner');
  });

  test('cyclic local contexts are rejected', async () => {
    await api('PUT', '/api/resources/cycA', { body: { '@context': 'local:cycB' }, baseRevision: null });
    await api('PUT', '/api/resources/cycB', { body: { '@context': 'local:cycA' }, baseRevision: null });
    const res = await api('POST', '/api/parse', {
      document: { '@context': 'local:cycA', 'x': 1 },
      bindings: { cycA: 'latest', cycB: 'latest' }
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'cyclic IRI mapping');
  });
});

describe('session API', () => {
  test('session pins revisions; resource edits afterwards do not leak in', async () => {
    await api('PUT', '/api/resources/pinned', { body: { '@vocab': 'https://v1/' }, baseRevision: null });
    const created = await api('POST', '/api/sessions', {
      name: 'demo',
      bindings: { pinned: 'latest' },
      document: { '@context': 'local:pinned', 'field': 'x' }
    });
    assert.equal(created.status, 201);
    const sid = created.json.id;

    const parsed1 = await api('POST', `/api/sessions/${sid}/parse`, {});
    assert.equal(parsed1.json.expanded[0]['https://v1/field'][0]['@value'], 'x');

    // Resource advances; the session still sees v1.
    const cur = await api('GET', '/api/resources/pinned');
    await api('PUT', '/api/resources/pinned', {
      body: { '@vocab': 'https://v2/' },
      baseRevision: cur.json.latestRevision
    });
    const parsed2 = await api('POST', `/api/sessions/${sid}/parse`, {});
    assert.equal(parsed2.json.expanded[0]['https://v1/field'][0]['@value'], 'x');
    assert.equal(parsed2.json.pinnedResources.pinned, created.json.resources.pinned);
  });

  test('parse persists the posted document into the session', async () => {
    const created = await api('POST', '/api/sessions', { bindings: { schema: 'latest' } });
    const sid = created.json.id;
    await api('POST', `/api/sessions/${sid}/parse`, {
      document: { '@context': 'local:schema', 'id': 'a/1' }
    });
    const got = await api('GET', `/api/sessions/${sid}`);
    assert.equal(got.json.document.id, 'a/1');
  });

  test('unknown session 404s', async () => {
    const res = await api('GET', '/api/sessions/ses_nope');
    assert.equal(res.status, 404);
  });
});
