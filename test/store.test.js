// Store tests: immutable revisions, conflict detection, session snapshots.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, revisionIdOf } from '../src/store.js';
import { ERR } from '../src/jsonld/errors.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-store-'));
  return new Store(join(dir, 'store.json'));
}

describe('immutable revisions', () => {
  let store;
  beforeEach(() => { store = freshStore(); });

  test('revision id is a content hash; identical bodies share a revision', () => {
    const body = { '@vocab': 'https://v/', b: 1, a: [2] };
    const id1 = revisionIdOf(body);
    const id2 = revisionIdOf({ a: [2], b: 1, '@vocab': 'https://v/' }); // key order independent
    assert.equal(id1, id2);
    assert.notEqual(revisionIdOf({ '@vocab': 'https://v/' }), id1);
  });

  test('revisions are never mutated; old bodies stay retrievable', () => {
    store.putResource('ctx', { '@vocab': 'https://v1/' }, null);
    const r1 = store.getResource('ctx').latestRevision;
    store.putResource('ctx', { '@vocab': 'https://v2/' }, r1);
    const r2 = store.getResource('ctx').latestRevision;
    assert.notEqual(r1, r2);
    assert.equal(store.getRevision('ctx', r1).body['@vocab'], 'https://v1/');
    assert.equal(store.getRevision('ctx', r2).body['@vocab'], 'https://v2/');
    assert.equal(store.getResource('ctx').revisionCount, 2);
  });

  test('re-saving the identical body is idempotent (no new revision, no conflict)', () => {
    const body = { '@vocab': 'https://v/' };
    store.putResource('ctx', body, null);
    const r1 = store.getResource('ctx').latestRevision;
    const again = store.putResource('ctx', body, r1);
    assert.equal(again.idempotent, true);
    assert.equal(store.getResource('ctx').revisionCount, 1);
  });

  test('unknown resource and unknown revision raise unknown resource', () => {
    assert.throws(() => store.getResource('nope'),
      err => err.code === ERR.UNKNOWN_RESOURCE);
    store.putResource('ctx', { '@vocab': 'https://v/' }, null);
    assert.throws(() => store.getRevision('ctx', 'rev_missing'),
      err => err.code === ERR.UNKNOWN_RESOURCE);
  });
});

describe('revision conflicts (no last-write-wins)', () => {
  let store;
  beforeEach(() => { store = freshStore(); });

  test('two editors based on the same revision: second save conflicts', () => {
    store.putResource('ctx', { '@vocab': 'https://v0/' }, null);
    const base = store.getResource('ctx').latestRevision;

    // Both "pages" fetched at `base` and now save diverging edits.
    store.putResource('ctx', { '@vocab': 'https://editor-A/' }, base); // A wins the race
    assert.throws(
      () => store.putResource('ctx', { '@vocab': 'https://editor-B/' }, base),
      err => {
        assert.equal(err.code, ERR.REVISION_CONFLICT);
        assert.equal(err.details.baseRevision, base);
        assert.ok(err.details.currentRevision !== base);
        assert.equal(err.details.currentBody['@vocab'], 'https://editor-A/');
        return true;
      }
    );
    // Loser refetches and saves on top of the winner's revision.
    const current = store.getResource('ctx').latestRevision;
    const ok = store.putResource('ctx', { '@vocab': 'https://editor-B-merged/' }, current);
    assert.equal(ok.baseRevision, current);
  });

  test('stale baseRevision is rejected even for a different resource state', () => {
    store.putResource('ctx', { '@vocab': 'https://v1/' }, null);
    const r1 = store.getResource('ctx').latestRevision;
    store.putResource('ctx', { '@vocab': 'https://v2/' }, r1);
    assert.throws(
      () => store.putResource('ctx', { '@vocab': 'https://v3/' }, r1),
      err => err.code === ERR.REVISION_CONFLICT
    );
  });

  test('creating an existing resource with baseRevision null conflicts implicitly', () => {
    store.putResource('ctx', { '@vocab': 'https://v1/' }, null);
    // A second "create" (baseRevision null) must not silently overwrite:
    // it is treated as based on nothing, which mismatches the current head.
    assert.throws(
      () => store.putResource('ctx', { '@vocab': 'https://v2/' }, null),
      err => err.code === ERR.REVISION_CONFLICT
    );
  });

  test('interleaved edits across two resources do not affect each other', () => {
    store.putResource('a', { '@vocab': 'https://a1/' }, null);
    store.putResource('b', { '@vocab': 'https://b1/' }, null);
    const a1 = store.getResource('a').latestRevision;
    const b1 = store.getResource('b').latestRevision;
    store.putResource('a', { '@vocab': 'https://a2/' }, a1);
    // b can still save against its own base revision.
    const ok = store.putResource('b', { '@vocab': 'https://b2/' }, b1);
    assert.equal(ok.revision, store.getResource('b').latestRevision);
  });
});

describe('sessions pin immutable snapshots', () => {
  let store;
  beforeEach(() => { store = freshStore(); });

  test('session binds the revisions current at creation time', () => {
    store.putResource('ctx', { '@vocab': 'https://v1/' }, null);
    const r1 = store.getResource('ctx').latestRevision;
    const session = store.createSession({ bindings: { ctx: 'latest' }, document: { '@context': 'local:ctx' } });
    assert.equal(session.resources.ctx, r1);

    // Resource moves on; the session snapshot must not.
    store.putResource('ctx', { '@vocab': 'https://v2/' }, r1);
    const again = store.getSession(session.id);
    assert.equal(again.resources.ctx, r1);
    assert.equal(again.snapshot.get('ctx').body['@vocab'], 'https://v1/');
  });

  test('binding to a missing resource or revision fails at creation', () => {
    assert.throws(() => store.createSession({ bindings: { ghost: 'latest' } }),
      err => err.code === ERR.UNKNOWN_RESOURCE);
    store.putResource('ctx', { '@vocab': 'https://v1/' }, null);
    assert.throws(() => store.createSession({ bindings: { ctx: 'rev_nope' } }),
      err => err.code === ERR.UNKNOWN_RESOURCE);
  });

  test('explicit revision binding is honored', () => {
    store.putResource('ctx', { '@vocab': 'https://v1/' }, null);
    const r1 = store.getResource('ctx').latestRevision;
    store.putResource('ctx', { '@vocab': 'https://v2/' }, r1);
    const session = store.createSession({ bindings: { ctx: r1 } });
    assert.equal(session.snapshot.get('ctx').body['@vocab'], 'https://v1/');
  });

  test('sessions persist across store reloads', () => {
    store.putResource('ctx', { '@vocab': 'https://v1/' }, null);
    const session = store.createSession({ bindings: { ctx: 'latest' } });
    const reloaded = new Store(store.file);
    assert.equal(reloaded.getSession(session.id).resources.ctx, session.resources.ctx);
  });
});
