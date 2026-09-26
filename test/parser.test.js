// Unit tests for the JSON-LD context processor + expander.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialContext, processContext } from '../src/jsonld/context.js';
import { expandDocument } from '../src/jsonld/expand.js';
import { createSnapshotLoader } from '../src/jsonld/loader.js';
import { ERR } from '../src/jsonld/errors.js';

function loaderFrom(resources) {
  const map = new Map(Object.entries(resources).map(
    ([name, body]) => [name, { revision: `rev_${name}`, body }]
  ));
  return createSnapshotLoader(map);
}

function parse(doc, resources, opts = {}) {
  return expandDocument(doc, { loader: loaderFrom(resources), ...opts });
}

describe('@base and relative IRIs', () => {
  const resources = {
    base: {
      '@base': 'https://example.com/things/',
      '@vocab': 'https://schema.org/',
      'homepage': { '@id': 'url', '@type': '@id' }
    }
  };

  test('@id resolved relative to @base', () => {
    const { expanded } = parse(
      { '@context': 'local:base', '@id': 'widget/42' },
      resources
    );
    assert.equal(expanded[0]['@id'], 'https://example.com/things/widget/42');
  });

  test('root-relative reference replaces the path', () => {
    const { expanded } = parse(
      { '@context': 'local:base', 'homepage': '/about' },
      resources
    );
    assert.deepEqual(expanded[0]['https://schema.org/url'], [{ '@id': 'https://example.com/about' }]);
  });

  test('document baseUrl applies before any @base; relative @base composes', () => {
    const { expanded } = parse(
      { '@context': { '@base': 'sub/' }, '@id': 'x' },
      {},
      { baseUrl: 'https://example.com/things/' }
    );
    assert.equal(expanded[0]['@id'], 'https://example.com/things/sub/x');
  });

  test('@base: null clears the base; relative ids then stay relative', () => {
    const { expanded } = parse(
      { '@context': ['local:base', { '@base': null }], '@id': 'widget/42' },
      resources
    );
    assert.equal(expanded[0]['@id'], 'widget/42');
  });
});

describe('@vocab, prefixes and keyword aliases', () => {
  const resources = {
    vocab: {
      '@vocab': 'https://schema.org/',
      'xsd': { '@id': 'http://www.w3.org/2001/XMLSchema#', '@prefix': true },
      'created': { '@id': 'dateCreated', '@type': 'xsd:date' },
      'id': '@id',
      'kind': '@type'
    }
  };

  test('unknown property expands under @vocab', () => {
    const { expanded } = parse(
      { '@context': 'local:vocab', 'anything': 1 },
      resources
    );
    assert.deepEqual(expanded[0]['https://schema.org/anything'], [{ '@value': 1 }]);
  });

  test('compact IRI respects declared @prefix', () => {
    const { expanded } = parse(
      { '@context': 'local:vocab', 'created': '2026-09-26' },
      resources
    );
    assert.deepEqual(
      expanded[0]['https://schema.org/dateCreated'],
      [{ '@value': '2026-09-26', '@type': 'http://www.w3.org/2001/XMLSchema#date' }]
    );
  });

  test('keyword aliases map id->@id and kind->@type', () => {
    const { expanded } = parse(
      { '@context': 'local:vocab', 'id': 'p1', 'kind': 'Product' },
      resources
    );
    assert.equal(expanded[0]['@id'], 'p1');
    assert.deepEqual(expanded[0]['@type'], ['https://schema.org/Product']);
  });

  test('compact IRI without @prefix at property position is not joined', () => {
    const r = { c: { '@vocab': 'https://v/', 'xsd': 'http://www.w3.org/2001/XMLSchema#' } };
    const { expanded } = parse(
      { '@context': 'local:c', 'xsd:date': 'x' },
      r
    );
    // no join: falls back to vocab + 'xsd:date'
    assert.ok(expanded[0]['https://v/xsd:date']);
  });
});

describe('empty context reset', () => {
  test('null context drops all mappings; properties without vocab are dropped', () => {
    const resources = { v: { '@vocab': 'https://v/' } };
    const { expanded, traces, warnings } = parse(
      { '@context': ['local:v', null], 'foo': 'bar' },
      resources
    );
    assert.deepEqual(expanded, []);
    assert.ok(warnings.some(w => w.message.includes('"foo"')));
    assert.equal(traces.find(t => t.sourcePath === '$.foo').kind, 'dropped');
  });

  test('null context records a reset decision with kept protected terms', () => {
    const resources = { s: { '@vocab': 'https://v/', 'owner': { '@id': 'https://o/', '@protected': true } } };
    const chain = [];
    const ctx = processContext(createInitialContext(),
      ['local:s', null], { loader: loaderFrom(resources), chain });
    assert.ok(ctx.terms.has('owner'), 'protected term survives null reset');
    const reset = chain.find(c => c.kind === 'reset');
    assert.ok(reset);
    assert.deepEqual(reset.keptProtected, ['owner']);
  });
});

describe('protected terms', () => {
  test('identical redefinition is accepted (no-op)', () => {
    const resources = {
      s: { '@vocab': 'https://v/', 'owner': { '@id': 'https://o/', '@protected': true } },
      same: { 'owner': { '@id': 'https://o/', '@protected': true } }
    };
    const chain = [];
    const ctx = processContext(createInitialContext(),
      ['local:s', 'local:same'], { loader: loaderFrom(resources), chain });
    assert.equal(ctx.terms.get('owner').id, 'https://o/');
  });

  test('incompatible redefinition throws protected term redefinition', () => {
    const resources = {
      s: { '@vocab': 'https://v/', 'owner': { '@id': 'https://o/', '@protected': true } },
      bad: { 'owner': { '@id': 'https://attacker.example/owner' } }
    };
    assert.throws(
      () => processContext(createInitialContext(), ['local:s', 'local:bad'],
        { loader: loaderFrom(resources), chain: [] }),
      err => err.code === ERR.INVALID_PROTECTED_TERM_REDEFINITION && err.details.term === 'owner'
    );
  });

  test('removing a protected term with null definition is rejected', () => {
    const resources = {
      s: { '@vocab': 'https://v/', 'owner': { '@id': 'https://o/', '@protected': true } },
      kill: { 'owner': null }
    };
    assert.throws(
      () => processContext(createInitialContext(), ['local:s', 'local:kill'],
        { loader: loaderFrom(resources), chain: [] }),
      err => err.code === ERR.INVALID_PROTECTED_TERM_REDEFINITION
    );
  });
});

describe('nested contexts, term overrides and provenance chain', () => {
  const resources = {
    base: { '@vocab': 'https://base/', 'name': 'name', 'extra': 'extra' },
    ext: {
      '@context': 'local:base',
      'name': { '@id': 'https://ext/fullName' }
    }
  };

  test('later context wins and override history records the previous mapping', () => {
    const chain = [];
    const ctx = processContext(createInitialContext(),
      ['local:base', 'local:ext'], { loader: loaderFrom(resources), chain });
    assert.equal(ctx.terms.get('name').id, 'https://ext/fullName');
    // name is defined three times: base, base again (via ext's nested
    // include), then ext — so two override events are recorded.
    assert.equal(ctx.terms.get('name').history.length, 2);
    assert.equal(ctx.terms.get('name').history.at(-1).id, 'https://base/name');
  });

  test('decision chain records include revisions and term overrides', () => {
    const map = new Map(Object.entries(resources).map(
      ([name, body]) => [name, { revision: `rev_${name}`, body }]
    ));
    const { decisionChain, traces } = expandDocument(
      { '@context': ['local:base', 'local:ext'], 'name': 'x' },
      { loader: createSnapshotLoader(map) }
    );
    const includes = decisionChain.filter(c => c.kind === 'include');
    assert.deepEqual(includes.map(i => i.ref), ['local:base', 'local:ext', 'local:base']);
    assert.equal(includes[2].revision, 'rev_base', 'nested include pinned to the snapshot revision');
    const override = decisionChain.find(c => c.kind === 'term-override' && c.term === 'name');
    assert.ok(override);
    assert.equal(override.previous.id, 'https://base/name');

    const trace = traces.find(t => t.sourcePath === '$.name');
    assert.equal(trace.expandedIri, 'https://ext/fullName');
    assert.equal(trace.term.via, 'term');
    assert.equal(trace.term.history[0].id, 'https://base/name');
  });
});

describe('containers', () => {
  test('@language container expands into value/language objects', () => {
    const resources = { c: { '@vocab': 'https://v/', 'name': { '@id': 'name', '@container': '@language' } } };
    const { expanded } = parse(
      { '@context': 'local:c', 'name': { en: 'Hello', de: 'Hallo' } },
      resources
    );
    assert.deepEqual(expanded[0]['https://v/name'], [
      { '@value': 'Hello', '@language': 'en' },
      { '@value': 'Hallo', '@language': 'de' }
    ]);
  });

  test('@index container annotates nodes with @index', () => {
    const resources = {
      c: {
        '@vocab': 'https://v/',
        'items': { '@id': 'items', '@container': '@index' }
      }
    };
    const { expanded } = parse(
      { '@context': 'local:c', 'items': { 'first': { 'label': 'A' }, 'second': { 'label': 'B' } } },
      resources
    );
    const items = expanded[0]['https://v/items'];
    assert.deepEqual(items.map(i => i['@index']).sort(), ['first', 'second']);
  });

  test('@id container keys become node @ids', () => {
    const resources = {
      c: { '@vocab': 'https://v/', 'm': { '@id': 'm', '@container': '@id' } }
    };
    const { expanded } = parse(
      { '@context': 'local:c', 'm': { 'https://x/1': { 'label': 'one' } } },
      resources
    );
    assert.equal(expanded[0]['https://v/m'][0]['@id'], 'https://x/1');
  });

  test('@type container keys are merged into @type', () => {
    const resources = {
      c: { '@vocab': 'https://v/', 'm': { '@id': 'm', '@container': '@type' } }
    };
    const { expanded } = parse(
      { '@context': 'local:c', 'm': { 'Product': { 'label': 'p' } } },
      resources
    );
    assert.deepEqual(expanded[0]['https://v/m'][0]['@type'], ['https://v/Product']);
  });

  test('@list container wraps values', () => {
    const resources = {
      c: { '@vocab': 'https://v/', 'seq': { '@id': 'seq', '@container': '@list' } }
    };
    const { expanded } = parse(
      { '@context': 'local:c', 'seq': ['a', 'b'] },
      resources
    );
    assert.deepEqual(
      expanded[0]['https://v/seq'],
      [{ '@list': [{ '@value': 'a' }, { '@value': 'b' }] }]
    );
  });
});

describe('cycles and depth', () => {
  test('direct resource include cycle is rejected with the cycle path', () => {
    const resources = {
      a: { '@context': 'local:b' },
      b: { '@context': 'local:a' }
    };
    assert.throws(
      () => processContext(createInitialContext(), 'local:a',
        { loader: loaderFrom(resources), chain: [] }),
      err => err.code === ERR.CYCLIC_IRI_MAPPING && err.details.cycle.includes('local:a')
    );
  });

  test('self-referencing resource is a cycle', () => {
    const resources = { a: { '@context': 'local:a' } };
    assert.throws(
      () => processContext(createInitialContext(), 'local:a',
        { loader: loaderFrom(resources), chain: [] }),
      err => err.code === ERR.CYCLIC_IRI_MAPPING
    );
  });

  test('deeply nested inline contexts hit context overflow', () => {
    let nested = { '@vocab': 'https://v/' };
    for (let i = 0; i < 40; i++) nested = { '@context': nested };
    assert.throws(
      () => expandDocument({ '@context': nested }, { loader: loaderFrom({}), maxContextDepth: 32 }),
      err => err.code === ERR.CONTEXT_OVERFLOW
    );
  });

  test('deeply nested data hits processing depth exceeded', () => {
    let doc = { '@context': { '@vocab': 'https://v/' }, 'child': null };
    doc.child = {};
    let cur = doc;
    for (let i = 0; i < 80; i++) { cur.child = {}; cur = cur.child; }
    assert.throws(
      () => expandDocument(doc, { loader: loaderFrom({}), maxDepth: 64 }),
      err => err.code === ERR.PROCESSING_DEPTH_EXCEEDED
    );
  });
});

describe('public network is forbidden', () => {
  test('http(s) context reference is refused', () => {
    assert.throws(
      () => processContext(createInitialContext(), 'https://schema.org/docs/jsonldcontext.jsonld',
        { loader: loaderFrom({}), chain: [] }),
      err => err.code === ERR.LOADING_REMOTE_CONTEXT_FAILED && err.message.includes('refused')
    );
  });

  test('non-local scheme is refused even when it looks like a name', () => {
    assert.throws(
      () => processContext(createInitialContext(), 'file:///etc/secret',
        { loader: loaderFrom({}), chain: [] }),
      err => err.code === ERR.LOADING_REMOTE_CONTEXT_FAILED
    );
  });
});

describe('unknown resources', () => {
  test('missing local resource reports known alternatives', () => {
    const resources = { known: { '@vocab': 'https://v/' } };
    assert.throws(
      () => processContext(createInitialContext(), 'local:missing',
        { loader: loaderFrom(resources), chain: [] }),
      err => err.code === ERR.UNKNOWN_RESOURCE && err.details.knownResources.includes('known')
    );
  });
});
