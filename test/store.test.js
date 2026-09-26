// 资源存储与会话测试：不可变 revision、CAS 冲突、快照绑定、过期检测、并发编辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResourceStore } from '../store.js';

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jld-store-'));
  const store = new ResourceStore(dir);
  await store.init();
  return { store, dir };
}

test('create + head 读取，revision 为内容 hash', async () => {
  const { store } = await freshStore();
  const content = { '@context': { '@vocab': 'https://x/' } };
  const r = await store.createResource({ id: 'a', name: 'A', content });
  assert.ok(r.revision.startsWith('r-'));
  assert.equal(r.revision, ResourceStore.contentHash(content));
  const got = store.getRevision('a', r.revision);
  assert.deepEqual(got.content, content);
});

test('相同内容产生相同 revision（幂等更新，不新增版本）', async () => {
  const { store } = await freshStore();
  const r1 = await store.createResource({ id: 'a', content: { x: 1 } });
  const r2 = await store.updateResource({ id: 'a', content: { x: 1 }, expectedRevision: r1.revision });
  assert.equal(r2.revision, r1.revision);
  assert.equal(store.getResource('a').revisions.length, 1);
});

test('revision 不可变：旧 revision 内容始终可读', async () => {
  const { store } = await freshStore();
  const r1 = await store.createResource({ id: 'a', content: { v: 1 } });
  const r2 = await store.updateResource({ id: 'a', content: { v: 2 }, expectedRevision: r1.revision });
  assert.notEqual(r1.revision, r2.revision);
  assert.deepEqual(store.getRevision('a', r1.revision).content, { v: 1 });
  assert.deepEqual(store.getRevision('a', r2.revision).content, { v: 2 });
  assert.equal(store.getResource('a').head, r2.revision);
  assert.equal(store.getResource('a').revisions.length, 2);
});

test('并发编辑：基于过期 revision 的写入被拒绝（revision-conflict），不发生最后写入覆盖', async () => {
  const { store } = await freshStore();
  const r1 = await store.createResource({ id: 'a', content: { v: 1 } });

  // 页面 A 先提交
  const a = await store.updateResource({ id: 'a', content: { v: 'A' }, expectedRevision: r1.revision });
  // 页面 B 仍基于 r1 提交
  await assert.rejects(
    store.updateResource({ id: 'a', content: { v: 'B' }, expectedRevision: r1.revision }),
    (e) => {
      assert.equal(e.code, 'revision-conflict');
      assert.equal(e.details.expectedRevision, r1.revision);
      assert.equal(e.details.currentHead, a.revision);
      assert.deepEqual(e.details.currentContent, { v: 'A' }); // 服务端当前内容回传，供三方合并
      return true;
    },
  );
  // head 仍是 A，没有被 B 覆盖
  assert.deepEqual(store.getRevision('a', a.revision).content, { v: 'A' });

  // B 刷新到 head 后重试成功
  const b = await store.updateResource({ id: 'a', content: { v: 'B' }, expectedRevision: a.revision });
  assert.equal(store.getResource('a').head, b.revision);
});

test('真正并发：两个同时到达的写入只有一个成功', async () => {
  const { store } = await freshStore();
  const r1 = await store.createResource({ id: 'a', content: { v: 1 } });
  const [res1, res2] = await Promise.allSettled([
    store.updateResource({ id: 'a', content: { v: 'X' }, expectedRevision: r1.revision }),
    store.updateResource({ id: 'a', content: { v: 'Y' }, expectedRevision: r1.revision }),
  ]);
  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, ['fulfilled', 'rejected']);
  const rejected = res1.status === 'rejected' ? res1 : res2;
  assert.equal(rejected.reason.code, 'revision-conflict');
});

test('会话绑定 revision 快照：资源更新后旧会话仍解析旧内容', async () => {
  const { store } = await freshStore();
  const rev1 = await store.createResource({ id: 'c', content: { '@context': { '@vocab': 'https://v1/' } } });
  const s = await store.createSession({ id: 'sess', rootRefs: [{ resourceId: 'c' }] });

  const rev2 = await store.updateResource({ id: 'c', content: { '@context': { '@vocab': 'https://v2/' } }, expectedRevision: rev1.revision });
  // 快照仍指向 rev1
  const loaded = store.createLoader('sess')('c');
  assert.equal(loaded.revision, rev1.revision);
  assert.deepEqual(loaded.document, { '@context': { '@vocab': 'https://v1/' } });

  // staleness 报告
  const stale = store.sessionStaleness('sess');
  assert.deepEqual(stale.stale, [{ resourceId: 'c', pinned: rev1.revision, head: rev2.revision }]);

  // 重新绑定后看到新版本
  await store.rebindSession('sess', { c: rev2.revision });
  assert.deepEqual(store.sessionStaleness('sess').stale, []);
  assert.equal(store.createLoader('sess')('c').revision, rev2.revision);
});

test('会话引用未知资源 / 未知 revision 报 unknown-resource', async () => {
  const { store } = await freshStore();
  await assert.rejects(
    store.createSession({ id: 's', rootRefs: [{ resourceId: 'ghost' }] }),
    (e) => e.code === 'unknown-resource',
  );
  const r = await store.createResource({ id: 'c', content: {} });
  await assert.rejects(
    store.rebindSession('s', { c: 'r-nonexistent' }),
    (e) => e.code === 'unknown-resource',
  );
  void r;
});

test('loader 拒绝快照外资源与公网引用', async () => {
  const { store } = await freshStore();
  await store.createResource({ id: 'in', content: { '@context': {} } });
  await store.createResource({ id: 'out', content: { '@context': {} } });
  await store.createSession({ id: 's', rootRefs: [{ resourceId: 'in' }] });
  const loader = store.createLoader('s');
  assert.throws(() => loader('out'), (e) => e.code === 'unknown-resource');
  assert.throws(() => loader('https://example.com/c'), (e) => e.code === 'remote-context-forbidden');
});

test('持久化：新 store 实例从磁盘恢复资源/会话/历史', async () => {
  const { store, dir } = await freshStore();
  const r1 = await store.createResource({ id: 'a', content: { v: 1 } });
  await store.updateResource({ id: 'a', content: { v: 2 }, expectedRevision: r1.revision });
  await store.createSession({ id: 's', rootRefs: [{ resourceId: 'a', revision: r1.revision }] });

  const store2 = new ResourceStore(dir);
  await store2.init();
  assert.equal(store2.getResource('a').revisions.length, 2);
  assert.deepEqual(store2.getRevision('a', r1.revision).content, { v: 1 });
  assert.equal(store2.getSession('s').pins.a, r1.revision);
});

test('canonical 等价内容（键序不同）共享 revision', async () => {
  const { store } = await freshStore();
  const r1 = await store.createResource({ id: 'a', content: { b: 1, a: 2, nested: { y: 2, x: 1 } } });
  const r2 = await store.updateResource({
    id: 'a',
    content: { a: 2, b: 1, nested: { x: 1, y: 2 } },
    expectedRevision: r1.revision,
  });
  assert.equal(r2.revision, r1.revision);
});
