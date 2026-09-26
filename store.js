// 本地 context 资源存储。
// 设计要点：
//  - 资源正文按内容 hash 保存为不可变 revision（content-addressed）；
//  - 更新采用 CAS：客户端必须携带 expectedRevision，冲突返回 revision-conflict；
//  - 会话绑定资源 revision 快照，解析时只允许从快照加载，禁止公网；
//  - 所有变更串行化并原子落盘（tmp + rename）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isAbsoluteIRI, isRemoteRef } from './iri.js';
import { errConflict, errUnknownResource, errRemote } from './errors.js';

export const SEED_REVISION_NOTE = 'seed';

export class ResourceStore {
  constructor(dataDir) {
    this.dataDirResolver = typeof dataDir === 'function' ? dataDir : () => dataDir;
    this.dataDir = this.dataDirResolver();
    this.resourcesPath = path.join(dataDir, 'resources.json');
    this.sessionsPath = path.join(dataDir, 'sessions.json');
    this.mu = Promise.resolve();
    this.resources = new Map(); // id -> { id, name, head, revisions: [{revision, content, createdAt, note}] }
    this.sessions = new Map();  // id -> session record
    this.seeded = false;
  }

  async init(seedFn) {
    this.dataDir = this.dataDirResolver();
    this.resourcesPath = path.join(this.dataDir, 'resources.json');
    this.sessionsPath = path.join(this.dataDir, 'sessions.json');
    await fs.mkdir(this.dataDir, { recursive: true });
    await this._load();
    // 种子回调直接在调用方持锁语义下运行；约定其内部不再走带锁的公开方法，
    // 避免不可重入互斥锁自锁。
    if (!this.seeded && seedFn) {
      await seedFn(this);
    }
  }

  // 供种子/迁移使用的“直接创建”（不经过互斥锁；init 阶段单线程调用）
  async seedDirect({ id, name, content, note }) {
    if (this.resources.has(id)) {
      return { id, revision: this.resources.get(id).head, head: this.resources.get(id).head, unchanged: true };
    }
    return this._createResourceInternal({ id, name, content, note });
  }

  async _load() {
    try {
      const raw = await fs.readFile(this.resourcesPath, 'utf8');
      const arr = JSON.parse(raw);
      for (const r of arr) this.resources.set(r.id, r);
      this.seeded = true;
    } catch {
      this.seeded = false;
    }
    try {
      const raw = await fs.readFile(this.sessionsPath, 'utf8');
      for (const s of JSON.parse(raw)) this.sessions.set(s.id, s);
    } catch { /* 首次运行无会话文件 */ }
  }

  _withLock(fn) {
    const run = this.mu.then(() => fn());
    this.mu = run.catch(() => {});
    return run;
  }

  async _persistResources() {
    const tmp = this.resourcesPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify([...this.resources.values()], null, 2));
    await fs.rename(tmp, this.resourcesPath);
  }

  async _persistSessions() {
    const tmp = this.sessionsPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify([...this.sessions.values()], null, 2));
    await fs.rename(tmp, this.sessionsPath);
  }

  // ---- 查询 ----------------------------------------------------------------

  listResources() {
    return [...this.resources.values()].map((r) => ({
      id: r.id,
      name: r.name,
      head: r.head,
      revisions: r.revisions.map((x) => ({
        revision: x.revision,
        createdAt: x.createdAt,
        note: x.note ?? null,
      })),
    }));
  }

  getResource(id) {
    const r = this.resources.get(id);
    if (!r) throw errUnknownResource(`资源不存在: ${id}`, { resourceId: id });
    return r;
  }

  getRevision(id, revision) {
    const r = this.getResource(id);
    const rev = r.revisions.find((x) => x.revision === revision)
      ?? r.revisions.find((x) => x.revision === r.head && revision === undefined);
    if (!rev) throw errUnknownResource(`资源 ${id} 不存在 revision ${revision}`, { resourceId: id, revision });
    return rev;
  }

  // ---- 变更（仅内部串行调用） ----------------------------------------------

  static contentHash(content) {
    const canonical = typeof content === 'string' ? content : JSON.stringify(canonicalize(content));
    return 'r-' + createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  async _createResourceInternal({ id, name, content, note }) {
    if (this.resources.has(id)) {
      const e = new Error(`资源已存在: ${id}`);
      e.code = 'resource-exists';
      throw e;
    }
    const revision = ResourceStore.contentHash(content);
    const rec = {
      id, name, head: revision,
      revisions: [{ revision, content, createdAt: new Date().toISOString(), note: note ?? null }],
      createdAt: new Date().toISOString(),
    };
    this.resources.set(id, rec);
    await this._persistResources();
    return { id, revision, head: revision };
  }

  async createResource(args) {
    return this._withLock(() => this._createResourceInternal(args));
  }

  async _updateResourceInternal({ id, content, expectedRevision, note }) {
    const r = this.getResource(id);
    if (r.head !== expectedRevision) {
      throw errConflict(
        `资源 ${id} 已被其它会话修改：你基于 ${expectedRevision.slice(0, 10)}，当前 head 为 ${r.head.slice(0, 10)}`,
        {
          resourceId: id,
          expectedRevision,
          currentHead: r.head,
          currentContent: r.revisions.find((x) => x.revision === r.head).content,
        },
      );
    }
    const revision = ResourceStore.contentHash(content);
    // 幂等：内容未变化直接返回当前 revision，不产生新版本
    if (!r.revisions.some((x) => x.revision === revision)) {
      r.revisions.push({ revision, content, createdAt: new Date().toISOString(), note: note ?? null });
      r.head = revision;
      await this._persistResources();
    }
    return { id, revision, head: r.head, unchanged: revision === r.head };
  }

  async updateResource(args) {
    return this._withLock(() => this._updateResourceInternal(args));
  }

  // 种子引导（首启时调用，绕过 CAS）
  async seedResource(args) {
    return this._withLock(async () => {
      if (this.resources.has(args.id)) {
        return { id: args.id, revision: this.resources.get(args.id).head, head: this.resources.get(args.id).head, unchanged: true };
      }
      return this._createResourceInternal({ ...args, note: args.note ?? SEED_REVISION_NOTE });
    });
  }

  // ---- 会话（资源快照绑定） -------------------------------------------------

  async createSession({ id, name, rootRefs, document }) {
    return this._withLock(async () => {
      const pins = {};
      for (const ref of rootRefs ?? []) {
        const r = this.getResource(ref.resourceId);
        const rev = ref.revision ?? r.head;
        if (!r.revisions.some((x) => x.revision === rev)) {
          throw errUnknownResource(`快照引用了不存在的 revision`, { resourceId: ref.resourceId, revision: rev });
        }
        pins[ref.resourceId] = rev;
      }
      const record = {
        id,
        name: name ?? id,
        pins,
        document: document ?? null,
        createdAt: new Date().toISOString(),
      };
      this.sessions.set(id, record);
      await this._persistSessions();
      return this._publicSession(record);
    });
  }

  getSession(id) {
    const s = this.sessions.get(id);
    if (!s) throw errUnknownResource(`会话不存在: ${id}`, { sessionId: id });
    return s;
  }

  listSessions() {
    return [...this.sessions.values()].map((s) => this._publicSession(s));
  }

  _publicSession(s) {
    return {
      id: s.id, name: s.name, pins: { ...s.pins },
      hasDocument: s.document !== null,
      createdAt: s.createdAt,
    };
  }

  async setSessionDocument(id, document) {
    return this._withLock(async () => {
      const s = this.getSession(id);
      s.document = document;
      await this._persistSessions();
      return { id };
    });
  }

  // 会话是否落后于任意资源 head
  sessionStaleness(id) {
    const s = this.getSession(id);
    const stale = [];
    for (const [rid, rev] of Object.entries(s.pins)) {
      const r = this.resources.get(rid);
      if (r && r.head !== rev) {
        stale.push({ resourceId: rid, pinned: rev, head: r.head });
      }
    }
    return { sessionId: id, stale };
  }

  async rebindSession(id, pins = null) {
    return this._withLock(async () => {
      const s = this.getSession(id);
      const next = pins ?? {};
      for (const ref of Object.entries(next)) {
        const r = this.getResource(ref[0]);
        if (!r.revisions.some((x) => x.revision === ref[1])) {
          throw errUnknownResource(`快照引用了不存在的 revision`, { resourceId: ref[0], revision: ref[1] });
        }
      }
      s.pins = next;
      await this._persistSessions();
      return this._publicSession(s);
    });
  }

  /**
   * 为某次解析构造 loader：仅从会话快照解析引用，禁止任何公网/绝对协议。
   * ref 匹配规则："<resourceId>" 或 "<resourceId>#<fragment>"（fragment 取节点）。
   */
  createLoader(sessionId) {
    const s = this.getSession(sessionId);
    return (ref) => {
      if (typeof ref !== 'string') {
        const e = new Error('context 引用必须是字符串');
        e.code = 'invalid-context';
        throw e;
      }
      // 1) 公网/远程协议一律拒绝（即使快照里恰好有同名资源）
    if (isRemoteRef(ref)) {
      throw errRemote('禁止访问公网 context，只能引用会话快照中的本地资源', { ref });
    }
    // 2) 其它绝对协议本地无法解析
    if (isAbsoluteIRI(ref)) {
      throw errUnknownResource(`无法解析的绝对 context 引用: ${ref}`, { ref });
    }
    const hashIdx = ref.indexOf('#');
      const rid = hashIdx >= 0 ? ref.slice(0, hashIdx) : ref;
      const fragment = hashIdx >= 0 ? ref.slice(hashIdx + 1) : null;
      const pinned = s.pins[rid];
      if (!pinned) {
        throw errUnknownResource(
          `引用的本地资源 "${rid}" 不在会话快照中（先把资源固定到会话）`,
          { ref, resourceId: rid, sessionId },
        );
      }
      const r = this.resources.get(rid);
      const rev = r.revisions.find((x) => x.revision === pinned);
      let document = rev.content;
      if (fragment) {
        document = extractFragment(rev.content, fragment, ref);
      }
      return { document, resourceId: rid, revision: pinned };
    };
  }
}

function extractFragment(content, fragment, ref) {
  if (content && typeof content === 'object') {
    // 支持 JSON Pointer 风格（#/a/b）与点分风格（#a.b）
    let parts;
    if (fragment.startsWith('/')) parts = fragment.split('/').slice(1);
    else if (fragment.includes('.')) parts = fragment.split('.');
    else parts = [fragment];
    let cur = content;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
      else throw errUnknownResource(`资源片段不存在: ${ref}`, { ref });
    }
    return cur;
  }
  throw errUnknownResource(`非 JSON 资源不支持片段引用: ${ref}`, { ref });
}

// 规范化用于 hash 的对象（键排序），保证等价内容产生同一 revision
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}
