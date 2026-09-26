// Persistent store: immutable resource revisions + sessions bound to snapshots.
// Storage is a single JSON file written atomically. No external services.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonLdError, ERR } from './jsonld/errors.js';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function revisionIdOf(body) {
  return 'rev_' + createHash('sha256').update(canonical(body)).digest('hex').slice(0, 16);
}

const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, resources: {}, sessions: {} };
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  // --- resources -----------------------------------------------------------

  listResources() {
    return Object.entries(this.data.resources)
      .map(([name, r]) => ({
        name,
        latestRevision: r.latest,
        revisionCount: r.revisions.length,
        updatedAt: r.revisions[r.revisions.length - 1].createdAt,
        createdAt: r.revisions[0].createdAt
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getResource(name) {
    const r = this.data.resources[name];
    if (!r) throw new JsonLdError(ERR.UNKNOWN_RESOURCE, `Resource "${name}" does not exist`, { name });
    return this._describeResource(name, r);
  }

  _describeResource(name, r) {
    const rev = r.revisions.find(x => x.id === r.latest);
    return {
      name,
      latestRevision: r.latest,
      revisionCount: r.revisions.length,
      revisions: r.revisions.map(x => ({ id: x.id, createdAt: x.createdAt })),
      body: rev.body
    };
  }

  getRevision(name, revision) {
    const r = this.data.resources[name];
    if (!r) throw new JsonLdError(ERR.UNKNOWN_RESOURCE, `Resource "${name}" does not exist`, { name });
    const rev = r.revisions.find(x => x.id === revision);
    if (!rev) {
      throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
        `Revision ${revision} not found for resource "${name}" (latest: ${r.latest})`,
        { name, revision, latestRevision: r.latest });
    }
    return { name, revision: rev.id, createdAt: rev.createdAt, body: rev.body };
  }

  /**
   * Create a resource or append a revision.
   * @param {string} name
   * @param {object} body parsed context body
   * @param {string|null} baseRevision revision the editor based its change on
   *   (null only when creating a brand-new resource)
   */
  putResource(name, body, baseRevision = null) {
    if (!VALID_NAME_RE.test(name)) {
      throw new JsonLdError(ERR.VALIDATION,
        `Invalid resource name "${name}": use letters, digits, dot, dash or underscore`);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new JsonLdError(ERR.VALIDATION, `Resource "${name}" body must be a JSON object`);
    }

    const newRevision = revisionIdOf(body);
    const existing = this.data.resources[name];

    if (!existing) {
      if (baseRevision !== null && baseRevision !== undefined) {
        throw new JsonLdError(ERR.REVISION_CONFLICT,
          `Resource "${name}" does not exist; cannot base an edit on revision ${baseRevision}`,
          { name, baseRevision });
      }
      const now = new Date().toISOString();
      this.data.resources[name] = {
        latest: newRevision,
        revisions: [{ id: newRevision, createdAt: now, body }]
      };
      this.save();
      return { created: true, name, revision: newRevision, baseRevision: null };
    }

    // Idempotent: identical body → same revision, no conflict and no history entry.
    if (existing.latest === newRevision) {
      return { created: false, idempotent: true, name, revision: newRevision, baseRevision };
    }

    // Optimistic concurrency: updating an existing resource REQUIRES the
    // caller to declare the revision its edit is based on. Omitting it would
    // silently degrade to last-write-wins, which this store forbids.
    if (baseRevision === null || baseRevision === undefined) {
      throw new JsonLdError(ERR.REVISION_CONFLICT,
        `Resource "${name}" already exists at revision ${existing.latest}. ` +
        `Updates must declare baseRevision; refetch and retry.`,
        {
          name,
          baseRevision: null,
          currentRevision: existing.latest,
          currentBody: existing.revisions.find(x => x.id === existing.latest).body
        });
    }

    if (baseRevision !== existing.latest) {
      throw new JsonLdError(ERR.REVISION_CONFLICT,
        `Revision conflict for "${name}": this edit was based on ${baseRevision ?? 'unspecified'}, ` +
        `but the current revision is ${existing.latest}. Refetch and merge before saving.`,
        {
          name,
          baseRevision,
          currentRevision: existing.latest,
          currentBody: existing.revisions.find(x => x.id === existing.latest).body
        });
    }

    const now = new Date().toISOString();
    existing.revisions.push({ id: newRevision, createdAt: now, body });
    existing.latest = newRevision;
    this.save();
    return { created: false, name, revision: newRevision, baseRevision };
  }

  // --- sessions ------------------------------------------------------------

  listSessions() {
    return Object.entries(this.data.sessions)
      .map(([id, s]) => ({
        id, name: s.name ?? null, createdAt: s.createdAt,
        resources: s.resources, hasDocument: s.document !== undefined
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * @param {object} input
   * @param {string} [input.name]
   * @param {Record<string,string>} input.bindings name -> "latest" | revision id
   * @param {*} [input.document]
   */
  createSession(input = {}) {
    const bindings = input.bindings ?? {};
    const pinned = {};
    for (const [name, ref] of Object.entries(bindings)) {
      const r = this.data.resources[name];
      if (!r) throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
        `Cannot bind session: resource "${name}" does not exist`, { name });
      const revision = ref === 'latest' ? r.latest : ref;
      if (!r.revisions.some(x => x.id === revision)) {
        throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
          `Cannot bind session: revision ${revision} not found for "${name}" (latest: ${r.latest})`,
          { name, revision, latestRevision: r.latest });
      }
      pinned[name] = revision;
    }
    const id = 'ses_' + createHash('sha256')
      .update(JSON.stringify({ pinned, t: Date.now(), r: Math.random() }))
      .digest('hex').slice(0, 12);
    this.data.sessions[id] = {
      id,
      name: typeof input.name === 'string' && input.name ? input.name : null,
      createdAt: new Date().toISOString(),
      resources: pinned,
      document: input.document ?? null
    };
    this.save();
    return this.getSession(id);
  }

  getSession(id) {
    const s = this.data.sessions[id];
    if (!s) throw new JsonLdError(ERR.NOT_FOUND, `Session "${id}" does not exist`, { sessionId: id });
    return {
      id, name: s.name, createdAt: s.createdAt,
      resources: s.resources, document: s.document ?? null,
      snapshot: this.snapshotFor(s)
    };
  }

  deleteSession(id) {
    if (!this.data.sessions[id]) {
      throw new JsonLdError(ERR.NOT_FOUND, `Session "${id}" does not exist`, { sessionId: id });
    }
    delete this.data.sessions[id];
    this.save();
  }

  snapshotFor(session) {
    const map = new Map();
    for (const [name, revision] of Object.entries(session.resources)) {
      const r = this.data.resources[name];
      if (!r) {
        throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
          `Session "${session.id}" references deleted resource "${name}"`, { name });
      }
      const rev = r.revisions.find(x => x.id === revision);
      if (!rev) {
        throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
          `Session "${session.id}" references missing revision ${revision} of "${name}"`,
          { name, revision });
      }
      map.set(name, { revision, body: rev.body });
    }
    return map;
  }

  // Ad-hoc parsing without a stored session: pin whatever revisions are asked.
  resolveAdHocSnapshot(bindings = {}) {
    const map = new Map();
    const pinned = {};
    for (const [name, ref] of Object.entries(bindings)) {
      const r = this.data.resources[name];
      if (!r) throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
        `Unknown resource "${name}" — save it before parsing`, { name });
      const revision = ref === 'latest' ? r.latest : ref;
      const rev = r.revisions.find(x => x.id === revision);
      if (!rev) {
        throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
          `Revision ${revision} not found for "${name}" (latest: ${r.latest})`,
          { name, revision, latestRevision: r.latest });
      }
      map.set(name, { revision, body: rev.body });
      pinned[name] = revision;
    }
    return { map, pinned };
  }
}
