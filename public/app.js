// 工作台前端：会话/资源管理、解析、双树对照、来源决策链。
// 无框架；状态集中在 state，渲染函数式。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  view: { tab: 'doc', sub: 'document', tree: 'orig' },
  sessions: [],
  sessionId: null,
  session: null,
  resources: [],
  selectedResourceId: null,
  selectedResourceRevision: null, // 编辑器所基于的 revision（CAS）
  documentRaw: '',
  result: null,                     // { root, trace }
  selection: { path: null, side: null, node: null, origNode: null },
  drill: { orig: [], exp: [] },     // 窄屏逐层钻取栈（保存被钻取的节点）
  expandedKeys: new Set(['']),      // 展开的树节点路径（'' 为根）
  isNarrow: () => window.matchMedia('(max-width: 980px)').matches,
};

const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message ?? `HTTP ${res.status}`);
    err.code = json?.error?.code ?? 'http-error';
    err.details = json?.error?.details;
    err.status = res.status;
    throw err;
  }
  return json;
};

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function boot() {
  bindStaticEvents();
  await refreshAll();
  render();
  // 演示文档预填
  try {
    const seed = await api('GET', '/api/seed-document');
    state.documentRaw = JSON.stringify(seed.document, null, 2);
    $('#docInput').value = state.documentRaw;
  } catch { /* ignore */ }
}

function bindStaticEvents() {
  $('#parseBtn').addEventListener('click', onParse);
  $('#loadSeedBtn').addEventListener('click', onLoadSeed);
  $('#newSessionBtn').addEventListener('click', onNewSession);
  $('#sessionSelect').addEventListener('change', (e) => selectSession(e.target.value));
  $('#newResourceBtn').addEventListener('click', onNewResource);
  $('#saveResourceBtn').addEventListener('click', onSaveResource);
  $('#resourceSelect').addEventListener('change', (e) => selectResource(e.target.value));
  $('#rebindHeadBtn').addEventListener('click', onRebindAllHead);
  $('#docInput').addEventListener('input', (e) => { state.documentRaw = e.target.value; });
  $('#modalCloseBtn').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#modalRefreshBtn').addEventListener('click', onConflictRefresh);

  $$('.sub-tab').forEach((btn) => btn.addEventListener('click', () => {
    state.view.sub = btn.dataset.sub;
    renderSubTabs();
  }));
  $$('.mobile-tabs button').forEach((btn) => btn.addEventListener('click', () => {
    switchMobileTab(btn.dataset.tab);
  }));
  $$('[data-gotree]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.view.tree = btn.dataset.gotree;
    renderMobilePanels();
  }));

  window.addEventListener('resize', () => render());
}

async function refreshAll() {
  const [{ sessions }, { resources }] = await Promise.all([
    api('GET', '/api/sessions'),
    api('GET', '/api/resources'),
  ]);
  state.sessions = sessions;
  state.resources = resources;
  if (!state.sessionId && sessions.length) state.sessionId = sessions[0].id;
  if (state.sessionId) await loadSession(state.sessionId);
}

async function loadSession(id) {
  state.sessionId = id;
  const data = await api('GET', `/api/sessions/${encodeURIComponent(id)}`);
  state.session = data.session;
  state.staleness = data.staleness.stale;
  $('#sessionSelect').value = id;
  renderStaleBadge();
  renderPins();
}

function selectSession(id) {
  state.sessionId = id;
  loadSession(id).then(render);
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------
async function onNewSession() {
  const rootRefs = state.resources.map((r) => ({ resourceId: r.id, revision: r.head }));
  const s = await api('POST', '/api/sessions', {
    name: `会话 ${state.sessions.length + 1}`,
    rootRefs,
  });
  await refreshAll();
  await selectSession(s.id);
}

function renderStaleBadge() {
  const badge = $('#staleBadge');
  const stale = state.staleness ?? [];
  badge.classList.toggle('hidden', stale.length === 0);
  badge.textContent = stale.length ? `快照过期 ×${stale.length}` : '';
}

function renderPins() {
  const wrap = $('#pinList');
  if (!state.session) { wrap.innerHTML = '<p class="hint">无会话</p>'; return; }
  const staleMap = Object.fromEntries((state.staleness ?? []).map((s) => [s.resourceId, s]));
  wrap.innerHTML = '';
  const pinnedIds = Object.keys(state.session.pins);
  if (pinnedIds.length === 0) wrap.innerHTML = '<p class="hint">该会话未固定任何资源。</p>';

  for (const id of pinnedIds) {
    const rev = state.session.pins[id];
    const res = state.resources.find((r) => r.id === id);
    const stale = staleMap[id];
    const item = document.createElement('div');
    item.className = 'pin-item' + (stale ? ' stale' : '');
    item.innerHTML = `
      <div class="pin-row">
        <strong>${escapeHtml(id)}</strong>
        <span class="hint">${escapeHtml(res?.name ?? '(已删除资源)')}</span>
      </div>
      <div class="pin-row" style="margin-top:5px">
        <span class="rev-id mono">${shortRev(rev)}</span>
        ${stale ? `<span class="hint">head: <span class="mono" style="color:var(--warn)">${shortRev(stale.head)}</span></span>` : '<span class="hint">＝ head</span>'}
      </div>
      <div class="pin-actions">
        <select data-id="${escapeHtml(id)}" class="pin-rev-select"></select>
        <button class="btn small ghost pin-unpin">移出快照</button>
      </div>`;
    const select = item.querySelector('.pin-rev-select');
    for (const r of res?.revisions ?? []) {
      const opt = document.createElement('option');
      opt.value = r.revision;
      opt.textContent = shortRev(r.revision) + (r.revision === res.head ? ' (head)' : '');
      if (r.revision === rev) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', async (e) => {
      await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/rebind`, {
        pins: { ...state.session.pins, [id]: e.target.value },
      });
      await loadSession(state.sessionId);
      render();
    });
    item.querySelector('.pin-unpin').addEventListener('click', async () => {
      const pins = { ...state.session.pins };
      delete pins[id];
      await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/rebind`, { pins });
      await loadSession(state.sessionId);
      render();
    });
    wrap.appendChild(item);
  }

  // 可加入的资源
  const unpinned = state.resources.filter((r) => !(r.id in state.session.pins));
  if (unpinned.length) {
    const addWrap = document.createElement('div');
    addWrap.style.marginTop = '10px';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">加入资源到快照…</option>' +
      unpinned.map((r) => `<option value="${r.id}">${r.id} (${shortRev(r.head)})</option>`).join('');
    sel.style.width = '100%';
    sel.addEventListener('change', async (e) => {
      if (!e.target.value) return;
      await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/rebind`, {
        pins: { ...state.session.pins, [e.target.value]: unpinned.find((r) => r.id === e.target.value).head },
      });
      await loadSession(state.sessionId);
      render();
    });
    addWrap.appendChild(sel);
    wrap.appendChild(addWrap);
  }
}

async function onRebindAllHead() {
  const pins = Object.fromEntries(state.resources
    .filter((r) => r.id in state.session.pins)
    .map((r) => [r.id, r.head]));
  await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/rebind`, { pins });
  await loadSession(state.sessionId);
  render();
}

// ---------------------------------------------------------------------------
// 资源编辑
// ----------------------------------------------------------------""-----------
function renderResourceList() {
  const sel = $('#resourceSelect');
  sel.innerHTML = state.resources
    .map((r) => `<option value="${r.id}">${r.id} — ${escapeHtml(r.name)}</option>`).join('');
  $('#resCount').textContent = state.resources.length;
  if (!state.selectedResourceId && state.resources.length) {
    state.selectedResourceId = state.resources[0].id;
  }
  sel.value = state.selectedResourceId ?? '';
}

async function selectResource(id) {
  state.selectedResourceId = id;
  await loadResourceIntoEditor(id);
  renderResourceMeta();
  renderRevisions();
}

async function loadResourceIntoEditor(id) {
  const res = state.resources.find((r) => r.id === id);
  if (!res) return;
  const data = await api('GET', `/api/resources/${encodeURIComponent(id)}/head`);
  state.selectedResourceRevision = data.revision.revision;
  $('#resourceInput').value = JSON.stringify(data.revision.content, null, 2);
}

function renderResourceMeta() {
  const res = state.resources.find((r) => r.id === state.selectedResourceId);
  if (!res) { $('#resourceMeta').textContent = ''; return; }
  $('#resourceMeta').innerHTML =
    `${escapeHtml(res.name)} · head <span class="mono">${shortRev(res.head)}</span> · 共 ${res.revisions.length} 个 revision`;
}

function renderRevisions() {
  const wrap = $('#revisionList');
  const res = state.resources.find((r) => r.id === state.selectedResourceId);
  if (!res) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = '';
  [...res.revisions].reverse().forEach((rev) => {
    const div = document.createElement('div');
    div.className = 'rev-item' + (rev.revision === res.head ? ' head' : '');
    div.innerHTML = `
      <span class="rev-id mono">${shortRev(rev.revision)}</span>
      <span class="rev-note">${rev.note ? escapeHtml(rev.note) : ''} · ${new Date(rev.createdAt).toLocaleString()}</span>
      <button class="btn small ghost" style="float:right">查看</button>`;
    div.querySelector('button').addEventListener('click', async () => {
      const data = await api('GET', `/api/resources/${encodeURIComponent(res.id)}/revisions/${encodeURIComponent(rev.revision)}`);
      $('#resourceInput').value = JSON.stringify(data.revision.content, null, 2);
      state.selectedResourceRevision = rev.revision;
      $('#resourceMeta').innerHTML = `查看历史 revision <span class="mono">${shortRev(rev.revision)}</span>（编辑前请先回到 head）`;
    });
    wrap.appendChild(div);
  });
}

async function onNewResource() {
  const id = prompt('新资源 ID（文档中用此字符串引用，例如 person-context）：');
  if (!id) return;
  const content = { '@context': { '@vocab': 'https://example.com/vocab#' } };
  try {
    await api('POST', '/api/resources', { id, name: id, content });
    await refreshAll();
    state.selectedResourceId = id;
    $('#resourceInput').value = JSON.stringify(content, null, 2);
    state.selectedResourceRevision = state.resources.find((r) => r.id === id)?.head ?? null;
    render();
  } catch (e) {
    showError(e, '创建资源失败');
  }
}

async function onSaveResource() {
  const id = state.selectedResourceId;
  if (!id) return;
  let content;
  try {
    content = JSON.parse($('#resourceInput').value);
  } catch {
    showSimple('JSON 解析失败', '资源正文不是合法 JSON，请检查语法。');
    return;
  }
  const res = state.resources.find((r) => r.id === id);
  // 编辑器若停在历史 revision，要求先回到 head 再改
  const expectedRevision = res.head;
  try {
    const out = await api('PUT', `/api/resources/${encodeURIComponent(id)}`, {
      content, expectedRevision, note: '手工编辑',
    });
    state.lastConflict = null;
    await refreshAll();
    await loadResourceIntoEditor(id);
    render();
    if (out.unchanged) showSimple('内容未变化', '正文与 head 完全一致，未产生新 revision。');
  } catch (e) {
    if (e.code === 'revision-conflict') {
      state.lastConflict = { id, expectedRevision, serverHead: e.details.currentHead, serverContent: e.details.currentContent };
      showConflict(e, id);
    } else {
      showError(e, '保存失败');
    }
  }
}

function showConflict(err, id) {
  $('#modalTitle').textContent = `revision 冲突：资源 ${id} 已被另一个页面修改`;
  const d = err.details;
  $('#modalBody').textContent =
    `${err.message}\n\n` +
    `你的编辑基于: ${d.expectedRevision}\n` +
    `服务端当前 head: ${d.currentHead}\n\n` +
    `服务端当前内容（合并参考）:\n${JSON.stringify(d.currentContent, null, 2)}`;
  $('#modalRefreshBtn').classList.remove('hidden');
  $('#modal').classList.remove('hidden');
}

async function onConflictRefresh() {
  const c = state.lastConflict;
  if (!c) return;
  $('#resourceInput').value = JSON.stringify(c.serverContent, null, 2);
  state.selectedResourceRevision = c.serverHead;
  $('#modal').classList.add('hidden');
  await refreshAll();
  render();
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------
async function onLoadSeed() {
  const seed = await api('GET', '/api/seed-document');
  state.documentRaw = JSON.stringify(seed.document, null, 2);
  $('#docInput').value = state.documentRaw;
}

async function onParse() {
  let document;
  try {
    document = JSON.parse(state.documentRaw);
  } catch {
    $('#docStatus').innerHTML = '<span style="color:var(--bad)">文档不是合法 JSON</span>';
    return;
  }
  if (!state.sessionId) {
    showSimple('没有会话', '请先创建会话并固定 context 资源。');
    return;
  }
  $('#docStatus').textContent = '解析中…';
  try {
    const result = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/expand`, {
      document,
      maxContextDepth: Number($('#maxContextDepth').value),
      maxDocumentDepth: Number($('#maxDocumentDepth').value),
    });
    state.result = result;
    state.selection = { path: null, side: null, node: null, origNode: null };
    state.drill = { orig: [], exp: [] };
    state.expandedKeys = new Set(['']);
    $('#docStatus').innerHTML =
      `<span style="color:var(--accent-2)">解析完成</span> · 事件 ${result.trace.events.length} · 上下文层 ${result.trace.layers.length} · 警告 ${result.trace.warnings.length}`;
    renderTrees();
    if (state.isNarrow()) switchMobileTab('trees');
  } catch (e) {
    state.result = null;
    renderTrees();
    $('#docStatus').innerHTML = `<span style="color:var(--bad)">${escapeHtml(e.code)}</span>: ${escapeHtml(e.message)}`;
    showError(e, '解析失败（已按当前会话快照）');
  }
}

// ---------------------------------------------------------------------------
// 树渲染（共享虚拟结构）
// ---------------------------------------------------------------------------
// 原始 JSON -> 与展开节点同路径的索引
function indexOrig(doc) {
  const map = new Map();
  const walk = (v, path) => {
    map.set(pathKey(path), v);
    if (Array.isArray(v)) v.forEach((c, i) => walk(c, path.concat(String(i))));
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], path.concat(k)));
  };
  walk(doc, []);
  return map;
}

// 展开节点 -> path 索引
function indexExpanded(root) {
  const map = new Map();
  const walk = (n) => {
    if (!n) return;
    map.set(pathKey(n.path), n);
    if (n.kind === 'subject') {
      n.properties.forEach((p) => walk(p.values));
      n.included?.forEach(walk);
      n.graphs?.forEach(walk);
    } else if (n.kind === 'array' || n.kind === 'list') {
      n.items?.forEach(walk);
    } else if (n.kind === 'map') {
      n.entries?.forEach((e) => walk(e.value));
    }
  };
  walk(root);
  return map;
}

const pathKey = (p) => p.join('/');

// 窄屏钻取栈顶（当前子树根）路径，用于强制展开与无边距展示
function narrowDrillRoot(side, pathArr) {
  if (!state.isNarrow()) return false;
  const stack = side === 'orig' ? state.drill.orig : state.drill.exp;
  const top = stack[stack.length - 1];
  return top !== undefined && top === pathKey(pathArr);
}

// 递归遍历原始 JSON 生成树 DOM
function buildOrigTree(value, path) {
  const key = pathKey(path);
  const node = document.createElement('div');
  node.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = key;
  row.dataset.side = 'orig';

  const isObj = value && typeof value === 'object';
  const isArr = Array.isArray(value);
  const expandable = isObj;
  const open = narrowDrillRoot('orig', path) || state.expandedKeys.has(key) || path.length === 0;

  const twisty = document.createElement('span');
  twisty.className = 'twisty' + (expandable ? (open ? ' open' : '') : ' leaf');
  twisty.textContent = '▶';
  row.appendChild(twisty);

  const label = document.createElement('span');
  if (path.length) {
    const k = path[path.length - 1];
    label.innerHTML = `<span class="key ${isKeywordStr(k) ? 'kw' : ''}">${escapeHtml(k)}</span><span class="punct">:</span> `;
  } else {
    label.innerHTML = '<span class="key">（文档根）</span> ';
  }
  row.appendChild(label);

  if (!expandable) {
    row.appendChild(renderScalar(value, true));
    if (typeof value === 'string' && looksLikeIRI(value)) {
      const tag = document.createElement('span');
      tag.className = 'mech-tag absolute';
      tag.textContent = 'IRI?';
      row.appendChild(tag);
    }
  } else {
    const size = isArr ? value.length : Object.keys(value).length;
    const hint = document.createElement('span');
    hint.className = 'collapsed-hint';
    hint.textContent = isArr ? `[ ${size} ]` : `{ ${size} }`;
    row.appendChild(hint);
    if (isObj) {
      const ctxKey = Object.keys(value).find((k) => k === '@context' || k.startsWith('@'));
      if (ctxKey === '@context') {
        const tag = document.createElement('span');
        tag.className = 'mech-tag keyword';
        tag.textContent = '@context';
        row.appendChild(tag);
      }
    }
  }
  node.appendChild(row);

  if (expandable) {
    const children = document.createElement('div');
    children.className = 'children';
    if (open) {
      const entries = isArr
        ? value.map((c, i) => [String(i), c])
        : Object.keys(value).map((k) => [k, value[k]]);
      for (const [k, child] of entries) children.appendChild(buildOrigTree(child, path.concat(k)));
    }
    node.appendChild(children);
  }
  bindRowEvents(row, key, 'orig');
  return node;
}

function renderScalar(v, origSide) {
  const span = document.createElement('span');
  if (v === null) span.innerHTML = '<span class="value-null">null</span>';
  else if (typeof v === 'number') span.innerHTML = `<span class="value-num">${v}</span>`;
  else if (typeof v === 'boolean') span.innerHTML = `<span class="value-bool">${v}</span>`;
  else span.innerHTML = `<span class="value-str">"${escapeHtml(String(v))}"</span>`;
  void origSide;
  return span;
}

// 展开树（遍历 result.root 结构）
function buildExpandedTree(n) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = pathKey(n.path);
  row.dataset.side = 'exp';

  if (n.kind === 'subject') {
    const isDrillRoot = narrowDrillRoot('exp', n.path);
    const open = isDrillRoot || state.expandedKeys.has(pathKey(n.path)) || n.path.length === 0;
    row.appendChild(twisty(open, true));
    const label = document.createElement('span');
    label.className = 'key';
    label.textContent = n.path.length ? n.path[n.path.length - 1] : '（展开根）';
    row.appendChild(label);
    const hint = document.createElement('span');
    hint.className = 'collapsed-hint';
    hint.textContent = `{ ${n.properties.length + n.types.length + (n.id ? 1 : 0)} }`;
    row.appendChild(hint);
    if (n.id) {
      const idTag = document.createElement('span');
      idTag.className = 'value-iri';
      idTag.style.fontSize = '11px';
      idTag.textContent = n.id;
      row.appendChild(idTag);
    }
    n.types.forEach((t) => {
      const tag = document.createElement('span');
      tag.className = 'mech-tag keyword';
      tag.textContent = `a ${t.iri}`;
      row.appendChild(tag);
    });
    if (n.decision?.scopeLayerId !== null && n.decision?.scopeLayerId !== undefined) {
      row.appendChild(makeContTag('作用域'));
    }
    appendNodeWarnings(row, n);
    node.appendChild(row);
    const children = document.createElement('div');
    children.className = 'children';
    if (open) {
      if (n.id) children.appendChild(kvLine('@id', n.id, 'keyword', null, pathKey(n.path)));
      n.types.forEach((t) => children.appendChild(kvLine('@type', t.iri, 'keyword', t.mechanism, pathKey(n.path))));
      n.properties.forEach((p) => children.appendChild(buildProperty(p, n.path)));
      n.graphs.forEach((g, i) => {
        const wrap = labeledChild('@graph', g, n.path.concat('@graph', String(i)));
        children.appendChild(wrap);
      });
      n.included.forEach((g, i) => {
        children.appendChild(labeledChild('@included', g, n.path.concat('@included', String(i))));
      });
    }
    node.appendChild(children);
  } else if (n.kind === 'array' || n.kind === 'list') {
    const open = narrowDrillRoot('exp', n.path) || state.expandedKeys.has(pathKey(n.path));
    row.appendChild(twisty(open, true));
    row.appendChild(labelFor(n));
    const tag = document.createElement('span');
    tag.className = 'cont-tag';
    tag.textContent = n.kind === 'list' ? '@list' : (n.container === '@set' ? '@set' : 'array');
    row.appendChild(tag);
    node.appendChild(row);
    const children = document.createElement('div');
    children.className = 'children';
    if (open) n.items.forEach((c) => children.appendChild(buildExpandedTree(c)));
    node.appendChild(children);
  } else if (n.kind === 'map') {
    const open = narrowDrillRoot('exp', n.path) || state.expandedKeys.has(pathKey(n.path));
    row.appendChild(twisty(open, true));
    row.appendChild(labelFor(n));
    row.appendChild(makeContTag(n.mapType.startsWith('@') ? n.mapType : '@' + n.mapType));
    node.appendChild(row);
    const children = document.createElement('div');
    children.className = 'children';
    if (open) {
      n.entries.forEach((e) => {
        const wrap = document.createElement('div');
        wrap.className = 'tree-node';
        const r2 = document.createElement('div');
        r2.className = 'tree-row';
        r2.dataset.side = 'exp';
        r2.dataset.path = pathKey(e.value.path);
        r2.appendChild(twisty(false, childExpandable(e.value)));
        const kspan = document.createElement('span');
        kspan.innerHTML = `<span class="key">[${escapeHtml(e.index)}</span><span class="punct">]</span> `;
        r2.appendChild(kspan);
        if (String(e.normalizedIndex) !== String(e.index)) {
          const norm = document.createElement('span');
          norm.className = 'hint';
          norm.style.fontSize = '10px';
          norm.textContent = `→ ${e.normalizedIndex}`;
          r2.appendChild(norm);
        }
        bindRowEvents(r2, pathKey(e.value.path), 'exp', e.value);
        wrap.appendChild(r2);
        const inner = document.createElement('div');
        inner.className = 'children';
        inner.appendChild(buildExpandedTree(e.value));
        inner.style.marginLeft = '14px';
        wrap.appendChild(inner);
        children.appendChild(wrap);
      });
    }
    node.appendChild(children);
  } else {
    // scalar
    row.appendChild(twisty(false, false));
    row.appendChild(labelFor(n));
    const valSpan = document.createElement('span');
    valSpan.appendChild(renderExpandedValue(n));
    row.appendChild(valSpan);
    if (n.valueType) row.appendChild(makeContTag(shortIri(n.valueType)));
    if (n.language) {
      const lang = document.createElement('span');
      lang.className = 'lang-tag';
      lang.textContent = `@${n.language}`;
      row.appendChild(lang);
    }
    if (n.coerced) row.appendChild(makeContTag('coerced'));
    appendNodeWarnings(row, n);
    node.appendChild(row);
  }

  bindRowEvents(row, pathKey(n.path), 'exp', n);
  return node;
}

function buildProperty(p, parentPath) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.side = 'exp';
  // 属性行直接锚定到其值节点路径，保证选择/高亮与决策链一致
  row.dataset.path = pathKey(p.values.path);
  row.appendChild(twisty(false, childExpandable(p.values)));
  const keySpan = document.createElement('span');
  keySpan.innerHTML = `<span class="key">${escapeHtml(p.name)}</span><span class="punct">:</span> `;
  row.appendChild(keySpan);
  const iriSpan = document.createElement('span');
  iriSpan.className = 'value-iri';
  iriSpan.style.fontSize = '11px';
  iriSpan.textContent = p.iri;
  row.appendChild(iriSpan);
  const tag = document.createElement('span');
  tag.className = `mech-tag ${p.mechanism}`;
  tag.textContent = mechanismLabel(p.mechanism);
  row.appendChild(tag);
  (p.container ?? []).forEach((c) => {
    if (c !== '@reverse') row.appendChild(makeContTag(c));
  });
  if (p.reverse) row.appendChild(makeContTag('@reverse'));
  if (p.unresolved) {
    const w = document.createElement('span');
    w.className = 'warn-tag';
    w.textContent = '⚠ 未解析';
    row.appendChild(w);
  }
  wrap.appendChild(row);
  const children = document.createElement('div');
  children.className = 'children';
  children.appendChild(buildExpandedTree(p.values));
  wrap.appendChild(children);
  bindRowEvents(row, pathKey(p.values.path), 'exp', p.values, p);
  return wrap;
}

function childExpandable(n) {
  return n && (n.kind === 'subject' || n.kind === 'array' || n.kind === 'list' || n.kind === 'map');
}

function twisty(open, expandable) {
  const t = document.createElement('span');
  t.className = 'twisty' + (expandable ? (open ? ' open' : '') : ' leaf');
  t.textContent = '▶';
  return t;
}
function labelFor(n) {
  const span = document.createElement('span');
  if (n.path.length) {
    span.innerHTML = `<span class="key">${escapeHtml(n.path[n.path.length - 1])}</span><span class="punct">:</span> `;
  } else span.textContent = '';
  return span;
}
function makeContTag(text) {
  const t = document.createElement('span');
  t.className = 'cont-tag';
  t.textContent = text;
  return t;
}
function kvLine(k, v, cls, mech, nodePathForChain) {
  const div = document.createElement('div');
  div.className = 'tree-row';
  div.dataset.side = 'exp';
  div.dataset.path = nodePathForChain ?? '';
  div.innerHTML = `<span class="twisty leaf">▶</span><span class="key ${cls}">${escapeHtml(k)}</span><span class="punct">:</span> `;
  const s = document.createElement('span');
  s.className = 'value-iri';
  s.textContent = v;
  div.appendChild(s);
  if (mech) {
    const tag = document.createElement('span');
    tag.className = `mech-tag ${mech}`;
    tag.textContent = mechanismLabel(mech);
    div.appendChild(tag);
  }
  if (nodePathForChain) bindRowEvents(div, nodePathForChain, 'exp');
  return div;
}
function labeledChild(label, node, path) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';
  wrap.innerHTML = `<div class="tree-row" data-side="exp" data-path="${pathKey(path)}">
    <span class="twisty leaf">▶</span><span class="key kw">${escapeHtml(label)}</span></div>`;
  const row = wrap.querySelector('.tree-row');
  bindRowEvents(row, pathKey(path), 'exp', node);
  const children = document.createElement('div');
  children.className = 'children';
  children.appendChild(buildExpandedTree(node));
  wrap.appendChild(children);
  return wrap;
}
function appendNodeWarnings(row, n) {
  (n.warnings ?? []).forEach((w) => {
    const el = document.createElement('span');
    el.className = 'warn-tag';
    el.title = w.message;
    el.textContent = '⚠';
    row.appendChild(el);
  });
}
function renderExpandedValue(n) {
  const frag = document.createDocumentFragment();
  const v = n.value;
  if (v && typeof v === 'object' && '@value' in v) {
    const inner = v['@value'];
    frag.appendChild(renderScalar(inner, false));
    return frag;
  }
  if (v && typeof v === 'object' && '@id' in v) {
    const a = document.createElement('span');
    a.className = 'value-iri';
    a.textContent = v['@id'];
    frag.appendChild(a);
    return frag;
  }
  frag.appendChild(renderScalar(v, false));
  return frag;
}

const mechanismLabel = (m) => ({
  term: '词项', prefix: '前缀', vocab: '@vocab', base: '@base',
  absolute: '绝对IRI', keyword: '关键字', blank: '空节点', unresolved: '未解析',
  'non-string': '非字符串',
}[m] ?? m);

function isKeywordStr(s) {
  return typeof s === 'string' && s.startsWith('@') &&
    ['@context', '@id', '@type', '@value', '@language', '@set', '@list', '@reverse', '@graph', '@included', '@index'].includes(s);
}
function looksLikeIRI(s) {
  return /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(s) || s.startsWith('/');
}
function shortIri(i) {
  if (typeof i !== 'string') return i;
  return i.replace('http://www.w3.org/2001/XMLSchema#', 'xsd:')
    .replace('https://schema.org/', 'schema:');
}
function shortRev(r) { return r ? r.slice(0, 10) : '—'; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// 选择联动
// ---------------------------------------------------------------------------
function bindRowEvents(row, key, side, node, propEntry) {
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    // 点 twisty 区域：折叠/展开
    if (e.target.classList.contains('twisty')) {
      if (!e.target.classList.contains('leaf')) {
        if (state.expandedKeys.has(key)) state.expandedKeys.delete(key);
        else state.expandedKeys.add(key);
        renderTrees();
      }
      return;
    }
    selectNode(key, side, node ?? null, propEntry ?? null);
  });
}

function selectNode(path, side, node, propEntry) {
  if (!state.result) return;
  state.selection.side = side;
  state.selection.path = path;
  if (side === 'exp') {
    state.selection.node = node ?? findExpNode(path);
    state.selection.propEntry = propEntry ?? findPropertyEntry(path);
  }
  renderTrees();
  renderChain();
  if (state.isNarrow() && state.view.tab === 'trees') {
    if (side === 'orig') {
      const target = findOrigNode(path);
      if (target && typeof target === 'object') {
        // 可展开：在原文树内逐层下钻
        state.expandedKeys.add(path);
        drillInto('orig', path);
      } else {
        // 叶子：跳到展开树同路径对照
        state.view.tree = 'exp';
        renderMobilePanels();
        renderTrees();
      }
    } else {
      const target = node ?? findExpNode(path);
      if (childExpandable(target)) {
        state.expandedKeys.add(path);
        drillInto('exp', path);
      } else {
        switchMobileTab('chain');
      }
    }
  }
}

function drillInto(side, path) {
  const stack = side === 'orig' ? state.drill.orig : state.drill.exp;
  // 避免重复入栈
  if (stack[stack.length - 1] !== path) stack.push(path);
  renderTrees();
}

function findExpNode(path) {
  return state._expIndex?.get(path) ?? null;
}
function findPropertyEntry(path) {
  if (!state.result) return null;
  const key = path;
  let found = null;
  const walkProps = (n) => {
    if (!n) return;
    if (n.kind === 'subject') {
      for (const p of n.properties) {
        if (pathKey(p.values?.path ?? []) === key) found = p;
        walkProps(p.values);
      }
      n.included?.forEach(walkProps);
      n.graphs?.forEach(walkProps);
    } else if (n.kind === 'array' || n.kind === 'list') n.items?.forEach(walkProps);
    else if (n.kind === 'map') n.entries?.forEach((e) => walkProps(e.value));
  };
  walkProps(state.result.root);
  return found;
}
function findOrigNode(path) {
  return state._origIndex?.get(path) ?? null;
}

// ---------------------------------------------------------------------------
// 决策链渲染
// ---------------------------------------------------------------------------
function renderChain() {
  const body = $('#chainBody');
  const sel = state.selection;
  $('#chainCount').classList.toggle('hidden', !state.result);
  $('#chainCount').textContent = state.result ? '●' : '';
  if (!state.result || !sel.path) {
    body.innerHTML = '<p class="placeholder">选择双树中的任意展开节点，这里会显示：' +
      '原始字段 → compact IRI 解析机制 → 命中的词项定义与历次覆盖 → 经过的 context 层。</p>';
    $('#selectedPath').textContent = '';
    return;
  }
  $('#selectedPath').textContent = sel.path;

  const parts = [];
  const expNode = sel.side === 'exp' ? sel.node : findExpNode(sel.path);
  const propEntry = sel.side === 'exp' ? sel.propEntry : findPropertyEntry(sel.path);
  const origVal = findOrigNode(sel.path);
  const decision = propEntry?.decision ?? expNode?.decision ?? null;

  // 1) 字段对照
  parts.push(section('字段对照', fieldComparison(sel.path, origVal, expNode, propEntry)));

  // 2) IRI 解析机制
  if (decision) parts.push(section('IRI 解析', iriDecisionCard(decision)));

  // 3) 词项定义与覆盖历史
  if (decision?.resolvedTerm) {
    parts.push(section('词项定义（含历次覆盖）', termTimeline(decision.resolvedTerm)));
  }

  // 4) context 层链
  const layerIds = decision?.contextLayers
    ?? (expNode?.kind === 'subject' ? expNode.contextChain : null)
    ?? [];
  if (layerIds.length) parts.push(section('经过的 context 层（决策路径）', layerChips(layerIds, decision)));

  // 5) 该属性相关的时间线事件
  parts.push(section('相关 context 事件', eventTimeline(sel.path, decision, propEntry)));

  // 6) 警告
  const warns = collectWarnings(sel.path);
  if (warns.length) parts.push(section('警告', warnList(warns)));

  body.innerHTML = parts.join('');
  body.querySelectorAll('.layer-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = Number(chip.dataset.layer);
      showLayerEvents(id);
    });
  });
}

function section(title, innerHtml) {
  return `<div class="chain-section"><p class="chain-title">${title}</p>${innerHtml}</div>`;
}

function fieldComparison(path, origVal, expNode, propEntry) {
  const origDisp = origVal === undefined ? '<em>（原文无此精确路径，如容器索引节点）</em>'
    : `<code>${escapeHtml(JSON.stringify(origVal))}</code>`;
  let expDisp;
  if (propEntry) {
    expDisp = `<span class="value-iri">${escapeHtml(propEntry.iri)}</span>
      <span class="mech-tag ${propEntry.mechanism}" style="margin-left:6px">${mechanismLabel(propEntry.mechanism)}</span>
      ${(propEntry.container ?? []).map((c) => `<span class="cont-tag">${c}</span>`).join(' ')}`;
  } else if (expNode) {
    expDisp = `<em>${expNode.kind}</em>` + (expNode.iri ? ` <span class="value-iri">${escapeHtml(expNode.iri)}</span>` : '');
  } else expDisp = '<em>（无对应展开节点）</em>';
  return `<div class="kv">
    <span class="k">路径</span><span class="v">${escapeHtml(path)}</span>
    <span class="k">原文</span><span class="v">${origDisp}</span>
    <span class="k">展开</span><span class="v">${expDisp}</span>
  </div>`;
}

function iriDecisionCard(d) {
  const rows = [
    ['原始键', d.rawKey],
    ['解析 IRI', d.iri],
    ['机制', mechanismLabel(d.mechanism)],
  ];
  if (d.prefixTerm) rows.push(['前缀词项', `${d.prefixTerm} → ${d.prefixIri}`]);
  if (d.vocab) rows.push(['@vocab', d.vocab]);
  if (d.base) rows.push(['@base', d.base]);
  if (d.unresolved) rows.push(['状态', '⚠ 无词项/词表/@base 可解析，原样保留并标记']);
  return `<div class="kv">${rows.map(([k, v]) =>
    `<span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span>`).join('')}</div>`;
}

function termTimeline(td) {
  const events = (td.history ?? []).map((idx) => state.result.trace.events[idx]).filter(Boolean);
  const head = `<div class="kv" style="margin-bottom:8px">
    <span class="k">IRI</span><span class="v">${escapeHtml(td.iri)}</span>
    ${td.type ? `<span class="k">@type</span><span class="v">${escapeHtml(td.type)}</span>` : ''}
    ${td.container?.length ? `<span class="k">容器</span><span class="v">${td.container.join(', ')}</span>` : ''}
    ${td.language ? `<span class="k">@language</span><span class="v">${td.language}</span>` : ''}
    ${td.prefix !== null ? `<span class="k">可当前缀</span><span class="v">${td.prefix ? '是' : '否'}</span>` : ''}
    <span class="k">受保护</span><span class="v">${td.protected ? '是（重定义受兼容校验）' : '否'}</span>
  </div>`;
  const tl = events.map((ev) => `
    <div class="tl-item ${ev.kind}">
      <div class="tl-card">
        <span class="tl-kind">${eventKindLabel(ev.kind)}</span>
        <span class="tl-main">${escapeHtml(ev.term ?? '')}</span>
        <div class="tl-sub">
          ${ev.before ? `覆盖前：${escapeHtml(ev.before)} → ` : ''}
          ${ev.iri ? `映射：<span class="value-iri">${escapeHtml(ev.iri)}</span>` : ''}
          ${ev.protected ? '· @protected' : ''}
          ${ev.keywordAlias ? '· 关键字别名' : ''}
        </div>
        <div class="tl-layer">层 #${ev.layerId}（${escapeHtml(layerName(ev.layerId))}）</div>
      </div>
    </div>`).join('');
  return head + `<div class="timeline">${tl}</div>`;
}

function layerChips(layerIds, decision) {
  const chips = layerIds.map((id) => {
    const l = state.result.trace.layers[id];
    if (!l) return '';
    const cls = l.kind === 'scope' ? 'scope' : l.kind === 'include' ? 'include' : l.kind === 'reset' ? 'reset' : '';
    const active = decision?.scopeLayerId === id ? 'active' : '';
    return `<button class="layer-chip ${cls} ${active}" data-layer="${id}">
      #${id} ${layerIcon(l.kind)} ${escapeHtml(l.label ?? l.ref ?? l.kind)}
      ${l.revision ? `<span class="hint">${shortRev(l.revision)}</span>` : ''}
    </button>`;
  }).join('');
  return `<div>${chips}</div>
  <p class="hint" style="margin-top:6px">点击任意层查看该层中的 context 事件。${decision?.scopeLayerId ? '高亮层为属性/类型作用域 context。' : ''}</p>`;
}

function eventTimeline(path, decision, propEntry) {
  const layerSet = new Set(decision?.contextLayers ?? []);
  // 收集：与选中路径相关的属性事件 + 词项历史事件 + 相关层中的 define/override/base/vocab/include/reset
  const historyEvents = new Set(decision?.resolvedTerm?.history ?? []);
  const items = state.result.trace.events.filter((ev) => {
    if (historyEvents.has(ev.idx)) return true;
    if (ev.path === path) return true;
    if ((ev.kind === 'property') && path && path.startsWith(ev.path + '/')) return true;
    if (layerSet.has(ev.layerId) && ['include', 'reset', 'base', 'vocab', 'scoped-applied', 'inline-context', 'protected-kept'].includes(ev.kind)) return true;
    return false;
  });
  if (!items.length) return '<p class="hint">无相关事件。</p>';
  return `<div class="timeline">${items.map((ev) => `
    <div class="tl-item ${ev.kind}">
      <div class="tl-card">
        <span class="tl-kind">${eventKindLabel(ev.kind)}</span>
        <span class="tl-main">${escapeHtml(ev.term ?? ev.key ?? ev.ref ?? '')}</span>
        <div class="tl-sub">${escapeHtml(eventSub(ev))}</div>
        <div class="tl-layer">#${ev.layerId} ${escapeHtml(layerName(ev.layerId))}${ev.path ? ' · ' + escapeHtml(ev.path) : ''}</div>
      </div>
    </div>`).join('')}</div>`;
  void propEntry;
}

function showLayerEvents(layerId) {
  const events = state.result.trace.events.filter((e) => e.layerId === layerId);
  const l = state.result.trace.layers[layerId];
  showSimple(`层 #${layerId}：${l.label ?? l.ref ?? l.kind}`,
    events.map((e) => `[${eventKindLabel(e.kind)}] ${e.term ?? e.key ?? e.ref ?? ''} ${eventSub(e)}`).join('\n') || '（该层无事件）');
}

function collectWarnings(path) {
  const out = [];
  for (const w of state.result.trace.warnings) {
    if (!w.path || path === w.path || path.startsWith(w.path + '.') || w.path.startsWith(path + '.')) out.push(w);
  }
  const n = findExpNode(path);
  (n?.warnings ?? []).forEach((w) => { if (!out.some((x) => x.message === w.message)) out.push(w); });
  return out;
}
function warnList(ws) {
  return `<div class="warn-list">${ws.map((w) =>
    `<div class="warn-item">⚠ ${escapeHtml(w.message)}${w.path ? ` <span class="hint">@ ${w.path}</span>` : ''}</div>`).join('')}</div>`;
}

const eventKindLabel = (k) => ({
  define: '定义', override: '覆盖', remove: '移除', base: '@base', vocab: '@vocab',
  language: '@language', direction: '@direction', include: '引用资源', reset: '空context重置',
  property: '属性展开', 'scoped-applied': '作用域context', 'inline-context': '内联context',
  'protected-kept': '受保护定义保留', error: '错误', 'context-error': 'context错误',
}[k] ?? k);

function eventSub(ev) {
  switch (ev.kind) {
    case 'define':
    case 'override':
      return `${ev.before ? `(${ev.before}) → ` : ''}${ev.iri ?? ''}` +
        `${ev.container?.length ? ' 容器[' + ev.container.join(',') + ']' : ''}`;
    case 'include': return `${ev.resourceId} @ ${shortRev(ev.revision)}`;
    case 'base': return ev.reset ? '清空 @base' : `${ev.from ?? ''} → ${ev.to ?? ''}`;
    case 'vocab': return ev.reset ? '清空 @vocab' : `${ev.from ?? ''} → ${ev.to ?? ''}`;
    case 'property': return `${ev.key} → ${ev.iri}（${mechanismLabel(ev.mechanism)}）`;
    case 'reset': return ev.detail ?? '';
    case 'remove': return ev.clearedProtection ? '清除受保护定义' : (ev.before ?? '');
    case 'scoped-applied': return `${ev.scope === 'type' ? '类型' : '属性'}作用域 · ${ev.term ?? ''} → 层 #${ev.layerId}`;
    default: return ev.detail ?? ev.message ?? ev.to ?? '';
  }
}
function layerName(id) {
  const l = state.result?.trace.layers[id];
  return l?.label ?? l?.ref ?? l?.kind ?? '';
}
function layerIcon(kind) {
  return { include: '⤵', scope: '⌖', reset: '⟲', inline: '{…}' }[kind] ?? '•';
}

// ---------------------------------------------------------------------------
// 渲染调度
// ---------------------------------------------------------------------------
function renderTrees() {
  if (!state.result) {
    $('#origTree').innerHTML = '<p class="placeholder">解析后在此显示原文树。</p>';
    $('#expandedTree').innerHTML = '<p class="placeholder">展开节点显示 IRI、容器与类型。</p>';
    renderChain();
    return;
  }
  state._origIndex = indexOrig(state.result.document ?? safeParse(state.documentRaw));
  state._expIndex = indexExpanded(state.result.root);

  // 窄屏钻取：仅渲染当前可见的树，并以其 drill 栈顶为根
  const narrow = state.isNarrow();
  const showOrig = !narrow || state.view.tree === 'orig';
  const showExp = !narrow || state.view.tree === 'exp';
  if (showOrig) renderOneTree($('#origTree'), state._origIndex, 'orig');
  else $('#origTree').innerHTML = '';
  if (showExp) renderOneTree($('#expandedTree'), state._expIndex, 'exp');
  else $('#expandedTree').innerHTML = '';
  highlightSelection();
  renderDrillBar();
  renderChain();
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function renderOneTree(container, index, side) {
  const narrow = state.isNarrow();
  const stack = side === 'orig' ? state.drill.orig : state.drill.exp;
  let rootPath = '';
  if (narrow && stack.length) rootPath = stack[stack.length - 1];
  const rootVal = index.get(rootPath);
  container.innerHTML = '';
  if (rootVal === undefined) {
    container.innerHTML = '<p class="placeholder">无内容</p>';
    return;
  }
  const rootNodePath = rootPath ? rootPath.split('/').filter(Boolean) : [];
  const dom = side === 'orig' ? buildOrigTree(rootVal, rootNodePath) : buildExpandedTree(rootVal);
  container.appendChild(dom);
}

function renderDrillBar() {
  if (!state.isNarrow() || state.view.tab !== 'trees') { $('#drillBar').classList.add('hidden'); return; }
  const side = state.view.tree;
  const stack = side === 'orig' ? state.drill.orig : state.drill.exp;
  const bar = $('#drillBar');
  bar.classList.toggle('hidden', stack.length === 0);
  if (stack.length) {
    $('#drillCrumb').textContent = (side === 'orig' ? '原文' : '展开') + ' / ' + stack[stack.length - 1];
    $('#drillUpBtn').onclick = () => { stack.pop(); renderTrees(); };
  }
}

function highlightSelection() {
  const path = state.selection.path;
  if (!path) return;
  ['origTree', 'expandedTree'].forEach((id) => {
    const container = document.getElementById(id);
    container.querySelectorAll('.tree-row').forEach((r) => r.classList.remove('selected', 'coupled'));
    const exact = container.querySelector(`.tree-row[data-path="${cssPath(path)}"]`);
    if (exact) exact.classList.add('selected');
    // 父子路径弱高亮
    container.querySelectorAll('.tree-row').forEach((r) => {
      const p = r.dataset.path;
      if (p && p !== path && (path.startsWith(p + '/') || p.startsWith(path + '/'))) {
        r.classList.add('coupled');
      }
    });
  });
}
function cssPath(p) { return p.replace(/"/g, '\\"'); }

// ---------------------------------------------------------------------------
// Tab/子 Tab/窄屏
// ---------------------------------------------------------------------------
function switchMobileTab(tab) {
  state.view.tab = tab;
  $$('.mobile-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderMobilePanels();
  renderTrees();
}

function renderMobilePanels() {
  const narrow = state.isNarrow();
  // 双树切换按钮仅窄屏可见
  $('#treeSwitchOrig')?.classList.toggle('hidden', !narrow);
  $('#treeSwitchExp')?.classList.toggle('hidden', !narrow);

  if (!narrow) {
    $$('.panel').forEach((p) => p.classList.add('active-mobile'));
    return;
  }
  const tab = state.view.tab;
  $$('.panel').forEach((p) => {
    const panels = p.dataset.panel.split(' ');
    if (!panels.includes(tab)) { p.classList.remove('active-mobile'); return; }
    if (tab === 'trees') {
      p.classList.toggle('active-mobile', p.dataset.tree === state.view.tree);
    } else {
      p.classList.add('active-mobile');
    }
  });
}

function renderSubTabs() {
  $$('.sub-tab').forEach((b) => b.classList.toggle('active', b.dataset.sub === state.view.sub));
  $$('.sub-body').forEach((el) => el.classList.toggle('hidden', el.id !== 'sub-' + state.view.sub));
}

// ---------------------------------------------------------------------------
// 错误提示
// ---------------------------------------------------------------------------
function showError(e, title) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = `${e.code ?? ''}\n${e.message}` +
    (e.details ? `\n\n${JSON.stringify(e.details, null, 2)}` : '');
  $('#modalRefreshBtn').classList.add('hidden');
  $('#modal').classList.remove('hidden');
}
function showSimple(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modalRefreshBtn').classList.add('hidden');
  $('#modal').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// 总渲染
// ---------------------------------------------------------------------------
function render() {
  renderResourceList();
  if (state.selectedResourceId) {
    $('#resourceSelect').value = state.selectedResourceId;
    renderResourceMeta();
    renderRevisions();
  }
  // 会话下拉
  const sel = $('#sessionSelect');
  if (sel.options.length !== state.sessions.length ||
      ![...sel.options].some((o) => o.value === state.sessionId)) {
    sel.innerHTML = state.sessions.map((s) =>
      `<option value="${s.id}">${escapeHtml(s.name)} (${Object.keys(s.pins).length} 资源)</option>`).join('');
    sel.value = state.sessionId ?? '';
  }
  renderStaleBadge();
  renderPins();
  renderSubTabs();
  renderMobilePanels();
  renderTrees();
}

boot();
