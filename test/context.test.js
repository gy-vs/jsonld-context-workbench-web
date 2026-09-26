// Context Processing 引擎测试：嵌套/覆盖/@base/@vocab/容器/受保护词项/
// 关键字别名/相对 IRI/空重置/循环/最大深度/未知资源/公网拦截。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceStore } from '../store.js';
import { expandDocument } from '../expand.js';
import { processInitialContext, Tracer } from '../context.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function makeStore(resources = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jld-test-'));
  const store = new ResourceStore(dir);
  for (const [id, content] of Object.entries(resources)) {
    await store.seedResource({ id, name: id, content });
  }
  return { store, dir };
}

const loaderFor = (resources, visited = []) => (ref) => {
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    const e = new Error(`禁止公网: ${ref}`);
    e.code = 'remote-context-forbidden';
    throw e;
  }
  if (!(ref in resources)) {
    const e = new Error(`未知资源: ${ref}`);
    e.code = 'unknown-resource';
    throw e;
  }
  if (visited.includes(ref)) {
    const e = new Error('循环');
    e.code = 'context-cycle';
    throw e;
  }
  visited.push(ref);
  const doc = resources[ref];
  const out = doc && typeof doc === 'object' && '@context' in doc ? doc['@context'] : doc;
  // 简化 loader（引擎自身的祖先检测才是被测对象）
  return { document: out, resourceId: ref, revision: 'rev' };
};

// 引擎自带循环检测：构造真实 store + 会话更贴近使用路径
async function sessionExpand(store, resources, document, sessionId = 's1', rootRefs) {
  const refs = rootRefs ?? Object.keys(resources).map((id) => ({ resourceId: id }));
  await store.createSession({ id: sessionId, rootRefs: refs, document });
  return expandDocument(document, null, store.createLoader(sessionId), {});
}

// ---------------------------------------------------------------------------

test('@vocab 词表展开与 compact IRI 前缀', () => {
  const tracer = new Tracer();
  const { active } = processInitialContext({
    '@context': {
      '@vocab': 'https://schema.org/',
      schema: 'https://schema.org/',
    },
  }, loaderFor({}), { tracer });
  assert.equal(active.vocab, 'https://schema.org/');
});

test('嵌套 context：引用本地资源并合并', async () => {
  const resources = {
    base: { '@context': { '@vocab': 'https://schema.org/' } },
    ext: { '@context': ['base', { name: 'http://ex.org/name' }] },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': 'ext',
    name: 'x', title: 'y',
  });
  const props = Object.fromEntries(out.root.properties.map((p) => [p.name, p.iri]));
  assert.equal(props.name, 'http://ex.org/name');
  assert.equal(props.title, 'https://schema.org/title');
});

test('词项覆盖：后定义覆盖前定义，history 保留两次事件', async () => {
  const resources = {
    a: { '@context': { name: 'https://a.example/name' } },
    b: { '@context': ['a', { name: 'https://b.example/name' }] },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, { '@context': 'b', name: 'x' });
  const prop = out.root.properties[0];
  assert.equal(prop.iri, 'https://b.example/name');
  assert.equal(prop.decision.resolvedTerm.history.length, 2);
  const evts = out.trace.events.filter((e) => e.term === 'name').map((e) => e.kind);
  assert.deepEqual(evts, ['define', 'override']);
});

test('null 显式定义可清除受保护词项后再重定义', async () => {
  const resources = {
    base: { '@context': { '@protected': true, name: 'https://a/name' } },
    override: { '@context': ['base', { name: null }, { name: 'https://b/name' }] },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, { '@context': 'override', name: 'x' });
  assert.equal(out.root.properties[0].iri, 'https://b/name');
});

test('受保护词项直接重定义为不同 IRI 应报错', async () => {
  const resources = { base: { '@context': { '@protected': true, name: 'https://a/name' } } };
  const { store } = await makeStore(resources);
  await store.createSession({ id: 's', rootRefs: [{ resourceId: 'base' }] });
  assert.throws(
    () => expandDocument({ '@context': ['base', { name: 'https://b/name' }], name: 'x' }, null, store.createLoader('s')),
    (e) => e.code === 'invalid-protected-term-redefinition',
  );
});

test('受保护词项以兼容定义重述时保留原定义', async () => {
  const resources = {
    a: { '@context': { '@protected': true, name: { '@id': 'https://a/name', '@container': '@set' } } },
    b: { '@context': ['a', { name: { '@id': 'https://a/name', '@container': '@set' } }] },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, { '@context': 'b', name: ['x'] });
  assert.equal(out.root.properties[0].iri, 'https://a/name');
});

test('@base 解析相对 IRI（@id 与属性值强制 @id）', async () => {
  const resources = { c: { '@context': { '@base': 'https://example.org/data/', homepage: { '@type': '@id' } } } };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': 'c', '@id': 'item/1', homepage: 'home',
  });
  assert.equal(out.root.id, 'https://example.org/data/item/1');
  assert.deepEqual(out.root.properties[0].values.value, { '@id': 'https://example.org/data/home' });
});

test('相对 @base 在嵌套资源中逐级解析', async () => {
  const resources = {
    a: { '@context': { '@base': 'https://example.org/' } },
    b: { '@context': ['a', { '@base': 'sub/' }] },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, { '@context': 'b', '@id': 'x' });
  assert.equal(out.root.id, 'https://example.org/sub/x');
});

test('@vocab 相对拼接：非定界符结尾直接连接', async () => {
  const resources = { c: { '@context': { '@vocab': 'https://ex.org/vocab#' } } };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, { '@context': 'c', thing: 1 });
  assert.equal(out.root.properties[0].iri, 'https://ex.org/vocab#thing');
});

test('空 context（null）重置 @base/@vocab/词项', async () => {
  const resources = {
    a: { '@context': { '@base': 'https://a/', '@vocab': 'https://a/v#', name: 'https://a/name' } },
    b: { '@context': ['a', null, { '@vocab': 'https://b/v#' }] },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': 'b', '@id': 'rel', name: 'x', fresh: 1,
  });
  // @base 已重置：相对 @id 无法解析
  assert.equal(out.root.id, 'rel');
  // name 词项被清空，落入新词表
  assert.equal(out.root.properties.find((p) => p.name === 'name').mechanism, 'vocab');
  assert.equal(out.root.properties.find((p) => p.name === 'name').iri, 'https://b/v#name');
});

test('关键字别名：id->@id, type->@type 生效', async () => {
  const resources = { c: { '@context': { id: '@id', type: '@type' } } };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, { '@context': 'c', id: 'urn:x:1', type: 'Thing' });
  assert.equal(out.root.id, 'urn:x:1');
  assert.equal(out.root.types[0].raw, 'Thing');
});

test('关键字不能被重新定义：@id 键映射到无关 IRI / @type 别名非法容器', () => {
  // 关键字本身作为词项键时，映射必须保持为该关键字
  assert.throws(
    () => processInitialContext({ '@context': { '@id': 'https://example.org/other' } }, loaderFor({}), { tracer: new Tracer() }),
    (e) => e.code === 'invalid-term-definition',
  );
  // @type 别名到 @id 时不能搭配非法容器
  assert.throws(
    () => processInitialContext({ '@context': { t: { '@id': '@type', '@container': '@list' } } }, loaderFor({}), { tracer: new Tracer() }),
    (e) => e.code === 'invalid-term-definition',
  );
  // @reverse 与 @id 不能并存
  assert.throws(
    () => processInitialContext({ '@context': { x: { '@id': 'https://e/x', '@reverse': 'https://e/y' } } }, loaderFor({}), { tracer: new Tracer() }),
    (e) => e.code === 'invalid-term-definition',
  );
});

test('容器：@list / @set / @index / @language / @id 正确建节点', async () => {
  const resources = {
    c: {
      '@context': {
        items: { '@id': 'https://ex/items', '@container': '@list' },
        bag: { '@id': 'https://ex/bag', '@container': '@set' },
        byIndex: { '@id': 'https://ex/byIndex', '@container': '@index' },
        labels: { '@id': 'https://ex/labels', '@container': '@language' },
        byId: { '@id': 'https://ex/byId', '@container': '@id' },
      },
    },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': 'c',
    items: ['a', 'b'],
    bag: ['x'],
    byIndex: { first: { v: 1 } },
    labels: { zh: '你好', en: 'hi' },
    byId: { '/u/1': { v: 2 } },
  });
  const byName = Object.fromEntries(out.root.properties.map((p) => [p.name, p]));
  assert.equal(byName.items.values.kind, 'list');
  assert.equal(byName.bag.values.kind, 'array');
  assert.equal(byName.bag.values.container, '@set');
  assert.equal(byName.byIndex.values.kind, 'map');
  assert.equal(byName.byIndex.values.mapType, '@index');
  assert.equal(byName.labels.values.entries[0].value.language, 'zh');
  assert.equal(byName.byId.values.entries[0].normalizedIndex, '/u/1');
});

test('属性作用域 @context 改变值内部词表', async () => {
  const resources = {
    c: {
      '@context': {
        '@vocab': 'https://outer/',
        detail: {
          '@id': 'https://ex/detail',
          '@context': { '@vocab': 'https://inner/' },
        },
      },
    },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': 'c', detail: { leaf: 1 },
  });
  const detail = out.root.properties[0];
  assert.equal(detail.values.properties[0].iri, 'https://inner/leaf');
  assert.ok(detail.decision.scopeLayerId !== null);
});

test('类型作用域 @context 在值展开前生效', async () => {
  const resources = {
    c: {
      '@context': {
        '@vocab': 'https://outer/',
        Special: { '@id': 'https://ex/Special', '@context': { '@vocab': 'https://special/' } },
      },
    },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': 'c',
    child: { '@type': 'Special', widget: 1 },
  });
  const child = out.root.properties[0].values;
  // Special 类型词在自身作用域下解析（其 @id 是绝对 IRI，保持不变）
  assert.equal(child.types[0].iri, 'https://ex/Special');
  assert.equal(child.properties[0].iri, 'https://special/widget');
});

test('循环引用 a->b->a 抛 context-cycle', async () => {
  const resources = {
    a: { '@context': ['b', { xa: 'https://a/xa' }] },
    b: { '@context': ['a', { xb: 'https://b/xb' }] },
  };
  const { store } = await makeStore(resources);
  await store.createSession({ id: 's', rootRefs: [{ resourceId: 'a' }, { resourceId: 'b' }] });
  assert.throws(
    () => expandDocument({ '@context': 'a' }, null, store.createLoader('s')),
    (e) => e.code === 'context-cycle' && /a -> b -> a|b -> a -> b/.test(e.details.chain.join(' -> ')),
  );
});

test('同层数组重复引用同一资源不算循环', async () => {
  const resources = {
    a: { '@context': { '@vocab': 'https://a/' } },
    b: { '@context': ['a', 'a'] },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, { '@context': 'b', x: 1 });
  assert.equal(out.root.properties[0].iri, 'https://a/x');
});

test('词项 IRI 映射自环循环 a->a 抛 context-cycle', () => {
  assert.throws(
    () => processInitialContext({ '@context': { a: 'a' } }, loaderFor({}), { tracer: new Tracer() }),
    (e) => e.code === 'context-cycle',
  );
});

test('最大 context 嵌套深度超限报错', () => {
  // 构造自引用数组对象链（深度增长）
  let ctx = null;
  const root = {};
  let cur = root;
  for (let i = 0; i < 80; i++) {
    const next = { [`t${i}`]: `https://x/${i}` };
    cur['@context'] = [next];
    cur = next;
  }
  ctx = root;
  assert.throws(
    () => processInitialContext(ctx, loaderFor({}), { tracer: new Tracer(), maxContextDepth: 64 }),
    (e) => e.code === 'context-depth-overflow',
  );
});

test('最大文档深度超限报 document-depth-overflow', async () => {
  const { store } = await makeStore({ c: { '@context': { '@vocab': 'https://x/' } } });
  await store.createSession({ id: 's', rootRefs: [{ resourceId: 'c' }] });
  let doc = 'leaf';
  for (let i = 0; i < 200; i++) doc = { '@context': 'c', child: doc };
  assert.throws(
    () => expandDocument(doc, null, store.createLoader('s'), { maxDocumentDepth: 128 }),
    (e) => e.code === 'document-depth-overflow',
  );
});

test('引用不在会话快照中的资源报 unknown-resource', async () => {
  const { store } = await makeStore({ a: { '@context': { '@vocab': 'https://a/' } } });
  await store.createSession({ id: 's', rootRefs: [] }); // 空快照
  assert.throws(
    () => expandDocument({ '@context': 'a' }, null, store.createLoader('s')),
    (e) => e.code === 'unknown-resource' && /快照/.test(e.message),
  );
});

test('公网 http/https context 一律拒绝（即使资源存在于快照）', async () => {
  const { store } = await makeStore({ a: { '@context': { '@vocab': 'https://a/' } } });
  await store.createSession({ id: 's', rootRefs: [{ resourceId: 'a' }] });
  assert.throws(
    () => expandDocument({ '@context': 'https://example.com/ctx.jsonld' }, null, store.createLoader('s')),
    (e) => e.code === 'remote-context-forbidden',
  );
});

test('context 对象内部嵌套 @context 键按内联分组处理', async () => {
  const resources = {
    p: { '@context': { '@vocab': 'https://p/' } },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': { '@context': ['p'], extra: 'https://z/extra' },
    extra: 1, foo: 2,
  });
  const byName = Object.fromEntries(out.root.properties.map((p) => [p.name, p.iri]));
  assert.equal(byName.extra, 'https://z/extra');
  assert.equal(byName.foo, 'https://p/foo');
});

test('未知字段保留并标记：无词表时 unresolved，有词表时走 vocab', async () => {
  const { store: s1 } = await makeStore({ c: { '@context': { '@vocab': 'https://v/' } } });
  const out = await sessionExpand(s1, { c: { '@context': { '@vocab': 'https://v/' } } }, { '@context': 'c', known: 1 });
  assert.equal(out.root.properties[0].mechanism, 'vocab');
  assert.equal(out.root.properties[0].unresolved, false);

  const { store: s2 } = await makeStore({ c: { '@context': { fixed: 'https://x/f' } } });
  await s2.createSession({ id: 's2', rootRefs: [{ resourceId: 'c' }] });
  const out2 = expandDocument({ '@context': 'c', mystery: 1 }, null, s2.createLoader('s2'));
  assert.equal(out2.root.properties[0].mechanism, 'unresolved');
  assert.equal(out2.root.properties[0].unresolved, true);
});

test('@type: @vocab 强制与 @type: @id 强制使用不同基准', async () => {
  const resources = {
    c: {
      '@context': {
        '@vocab': 'https://vocab/',
        '@base': 'https://base/',
        asId: { '@type': '@id' },
        asVocab: { '@type': '@vocab' },
      },
    },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': 'c', asId: 'rel/x', asVocab: 'Thing',
  });
  const byName = Object.fromEntries(out.root.properties.map((p) => [p.name, p.values.value]));
  assert.deepEqual(byName.asId, { '@id': 'https://base/rel/x' });
  assert.deepEqual(byName.asVocab, { '@id': 'https://vocab/Thing' });
});

test('片段引用 resource#path 取资源内节点', async () => {
  const resources = {
    bundle: { contexts: { person: { '@vocab': 'https://p/' } } },
  };
  const { store } = await makeStore(resources);
  const out = await sessionExpand(store, resources, {
    '@context': 'bundle#/contexts/person', name: 1,
  });
  assert.equal(out.root.properties[0].iri, 'https://p/name');
});
