// JSON-LD workbench frontend — vanilla JS, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  resources: [],
  sessionId: null,
  bindings: new Map(),   // name -> revision id (only checked entries)
  result: null,
  editor: { name: null, baseRevision: null, selectedRevision: null, mode: 'edit' },
  pendingBody: null,
  sourcePathEls: new Map(),
  expandedPathEls: new Map()
};

// ---------------------------------------------------------------- API -----
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(json?.error?.message ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.error?.code ?? 'error';
    err.details = json?.error?.details;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------- tabs ----
function switchTab(name) {
  document.body.className = 'show-' + name;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ------------------------------------------------------------ resources ---
async function loadResources() {
  const { resources } = await api('GET', '/api/resources');
  state.resources = resources;
  // prune bindings that vanished
  for (const name of [...state.bindings.keys()]) {
    if (!resources.some(r => r.name === name)) state.bindings.delete(name);
  }
  renderBindings();
  renderResourceQuick();
  renderResourceTable();
}

function renderBindings() {
  const wrap = $('#bindingsList');
  wrap.innerHTML = '';
  if (!state.resources.length) {
    wrap.innerHTML = '<p class="hint">暂无资源，请先在「资源库」中创建。</p>';
    return;
  }
  for (const r of state.resources) {
    const full = api('GET', `/api/resources/${encodeURIComponent(r.name)}`);
    const row = document.createElement('div');
    row.className = 'binding-row';
    const checked = state.bindings.has(r.name);
    row.innerHTML = `
      <input type="checkbox" ${checked ? 'checked' : ''} />
      <label class="name">local:${r.name}</label>
      <select ${checked ? '' : 'disabled'}></select>`;
    const checkbox = $('input', row);
    const select = $('select', row);

    full.then(detail => {
      const opts = ['<option value="latest">latest · ' + shortRev(r.latestRevision) + '</option>']
        .concat(detail.revisions.slice().reverse().map(rv =>
          `<option value="${rv.id}">${shortRev(rv.id)}</option>`));
      select.innerHTML = opts.join('');
      if (state.bindings.has(r.name)) {
        select.value = state.bindings.get(r.name);
      }
    });

    checkbox.addEventListener('change', () => {
      select.disabled = !checkbox.checked;
      if (checkbox.checked) {
        state.bindings.set(r.name, select.value);
      } else {
        state.bindings.delete(r.name);
      }
    });
    select.addEventListener('change', () => {
      if (checkbox.checked) state.bindings.set(r.name, select.value);
    });
    wrap.appendChild(row);
  }
}

function renderResourceQuick() {
  $('#resourceQuickList').innerHTML = state.resources.map(r =>
    `<div class="qr"><span>local:${r.name}</span><span>${shortRev(r.latestRevision)} · ${r.revisionCount} 版</span></div>`
  ).join('') || '<p class="hint">无</p>';
}

function renderResourceTable() {
  $('#resourceTableBody').innerHTML = state.resources.map(r => `
    <tr>
      <td><strong>${r.name}</strong></td>
      <td class="mono">${shortRev(r.latestRevision)}</td>
      <td>${r.revisionCount}</td>
      <td><button class="btn tiny" data-edit="${r.name}">编辑</button></td>
    </tr>`).join('');
  $$('[data-edit]', $('#resourceTableBody')).forEach(btn =>
    btn.addEventListener('click', () => openResource(btn.dataset.edit)));
}

async function openResource(name) {
  const detail = await api('GET', `/api/resources/${encodeURIComponent(name)}`);
  state.editor = { name, baseRevision: detail.latestRevision, selectedRevision: detail.latestRevision, mode: 'edit' };
  $('#resourceName').value = name;
  $('#resourceName').disabled = true;
  $('#resourceBody').value = JSON.stringify(detail.body, null, 2);
  $('#editorBase').textContent = 'base: ' + shortRev(detail.latestRevision);
  const sel = $('#revisionSelect');
  sel.hidden = false;
  $('#loadRevisionBtn').hidden = false;
  sel.innerHTML = detail.revisions.slice().reverse().map(rv =>
    `<option value="${rv.id}">${shortRev(rv.id)} · ${new Date(rv.createdAt).toLocaleString()}</option>`).join('');
  sel.value = detail.latestRevision;
  $('#editorTitle').textContent = `编辑资源 local:${name}`;
  hideMsg();
  $('#conflictBox').classList.add('hidden');
}

$('#revisionSelect').addEventListener('change', async e => {
  const rev = e.target.value;
  const name = state.editor.name;
  if (!name) return;
  const data = await api('GET', `/api/resources/${encodeURIComponent(name)}/revisions/${rev}`);
  $('#resourceBody').value = JSON.stringify(data.body, null, 2);
  state.editor.selectedRevision = rev;
  $('#editorBase').textContent = (rev === state.editor.baseRevision ? 'base: ' : '查看历史: ') + shortRev(rev);
});

$('#newResourceBtn').addEventListener('click', () => {
  state.editor = { name: null, baseRevision: null, selectedRevision: null, mode: 'create' };
  $('#resourceName').disabled = false;
  $('#resourceName').value = '';
  $('#resourceBody').value = JSON.stringify({ '@vocab': 'https://example.com/vocab#' }, null, 2);
  $('#editorBase').textContent = '新资源';
  $('#revisionSelect').hidden = true;
  $('#loadRevisionBtn').hidden = true;
  $('#editorTitle').textContent = '新建本地 context 资源';
  $('#conflictBox').classList.add('hidden');
  hideMsg();
});

function parseBodyFromEditor() {
  try {
    return JSON.parse($('#resourceBody').value);
  } catch (err) {
    showResourceMsg('JSON 解析失败：' + err.message, 'err');
    return undefined;
  }
}

$('#saveResourceBtn').addEventListener('click', () => saveResource(null));

async function saveResource(forceBaseRevision) {
  const name = state.editor.mode === 'create' ? $('#resourceName').value.trim() : state.editor.name;
  if (!name) return showResourceMsg('请填写资源名称', 'err');
  const body = parseBodyFromEditor();
  if (body === undefined) return;

  const baseRevision = forceBaseRevision ?? state.editor.selectedRevision;
  try {
    const out = await api('PUT', `/api/resources/${encodeURIComponent(name)}`, { body, baseRevision });
    state.pendingBody = null;
    $('#conflictBox').classList.add('hidden');
    showResourceMsg(
      out.idempotent ? '内容未变化：revision 相同（幂等），未生成新版本。'
                     : `已保存 → revision ${shortRev(out.revision)}${out.created ? '（新资源）' : ''}`,
      'ok');
    state.editor.mode = 'edit';
    await loadResources();
    await openResource(name);
  } catch (err) {
    if (err.code === 'revision conflict') {
      state.pendingBody = body;
      showConflict(err, name, body);
    } else {
      showResourceMsg(`${err.code}: ${err.message}`, 'err');
    }
  }
}

function showConflict(err, name, body) {
  $('#conflictBox').classList.remove('hidden');
  const based = state.editor.selectedRevision;
  $('#conflictText').textContent =
    `你的修改基于 ${shortRev(based)}，但 local:${name} 当前已是 ${shortRev(err.details.currentRevision)}。` +
    `工作台不会用最后写入覆盖旧修改 —— 请选择如何合并：`;
  $('#conflictBody').textContent = JSON.stringify(err.details.currentBody, null, 2);
  $('#overwriteBtn').onclick = () => saveResource(err.details.currentRevision);
  $('#discardBtn').onclick = async () => {
    $('#conflictBox').classList.add('hidden');
    state.editor.selectedRevision = err.details.currentRevision;
    await openResource(name);
  };
  showResourceMsg(`revision conflict — 保存被拒绝，见下方合并选项。`, 'err');
}

function showResourceMsg(text, kind) {
  const el = $('#resourceMsg');
  el.textContent = text;
  el.className = 'msg ' + kind;
}
function hideMsg() { $('#resourceMsg').className = 'msg hidden'; }

$('#gotoResources').addEventListener('click', (e) => { e.preventDefault(); switchTab('resources'); });

// ------------------------------------------------------------- sessions --
async function loadSessions(selectId = null) {
  const { sessions } = await api('GET', '/api/sessions');
  const sel = $('#sessionSelect');
  sel.innerHTML = '<option value="">（不使用会话：一次性解析）</option>' + sessions.map(s =>
    `<option value="${s.id}">${s.name ? s.name + ' · ' : ''}${s.id} · ${Object.keys(s.resources).length} 资源 · ${new Date(s.createdAt).toLocaleString()}</option>`
  ).join('');
  if (selectId) sel.value = selectId;
}

$('#sessionSelect').addEventListener('change', async e => {
  const id = e.target.value;
  if (!id) {
    state.sessionId = null;
    $('#sessionInfo').textContent = '';
    return;
  }
  const s = await api('GET', `/api/sessions/${id}`);
  state.sessionId = id;
  $('#docInput').value = s.document ? JSON.stringify(s.document, null, 2) : '';
  state.bindings = new Map(Object.entries(s.resources));
  $('#sessionInfo').textContent = `会话 ${id} 已钉死 ${Object.keys(s.resources).length} 个 revision`;
  await loadResources();
  // sync selects to pinned revisions
  $$('#bindingsList .binding-row').forEach(row => {
    const name = $('.name', row).textContent.replace('local:', '');
    const cb = $('input', row), sel = $('select', row);
    if (state.bindings.has(name)) {
      cb.checked = true; sel.disabled = false; sel.value = state.bindings.get(name);
    }
  });
});

$('#newSessionBtn').addEventListener('click', async () => {
  const doc = readDoc(true);
  if (doc === undefined) return;
  const bindings = Object.fromEntries(state.bindings);
  if (!Object.keys(bindings).length) {
    return $('#docError').textContent = '请至少勾选一个本地资源后再创建会话。';
  }
  const name = prompt('会话名称（可留空）:', '');
  if (name === null) return;
  const s = await api('POST', '/api/sessions', { name: name || undefined, bindings, document: doc });
  state.sessionId = s.id;
  $('#sessionInfo').textContent = `会话 ${s.id} 已创建，revision 已钉死`;
  await loadSessions(s.id);
});

// ---------------------------------------------------------------- parse ---
const SAMPLE = {
  '@context': ['local:schema', 'local:ext'],
  'id': 'widget/42',
  'kind': 'Product',
  'name': 'Widget',
  'created': '2026-09-26',
  'homepage': '/about',
  'byCode': {
    'W-001': { 'name': 'Widget variant' }
  },
  'security': {
    '@context': 'local:secure',
    'owner': 'alice',
    'classification': 'internal'
  }
};

$('#sampleBtn').addEventListener('click', () => {
  $('#docInput').value = JSON.stringify(SAMPLE, null, 2);
  $('#docError').classList.add('hidden');
});

$('#formatBtn').addEventListener('click', () => {
  const doc = readDoc(false);
  if (doc !== undefined) $('#docInput').value = JSON.stringify(doc, null, 2);
});

function readDoc(silent = false) {
  try {
    const v = JSON.parse($('#docInput').value);
    $('#docError').classList.add('hidden');
    return v;
  } catch (err) {
    if (!silent) {
      $('#docError').textContent = '文档 JSON 解析失败：' + err.message;
      $('#docError').classList.remove('hidden');
    }
    return undefined;
  }
}

$('#parseBtn').addEventListener('click', doParse);

async function doParse() {
  const document = readDoc();
  if (document === undefined) return;
  const baseUrl = $('#baseUrlInput').value.trim() || null;
  const bindings = Object.fromEntries(state.bindings);
  try {
    const result = state.sessionId
      ? await api('POST', `/api/sessions/${state.sessionId}/parse`, { document, baseUrl })
      : await api('POST', '/api/parse', { document, bindings, baseUrl });
    state.result = result;
    renderResults(result);
    switchTab('trees');
  } catch (err) {
    $('#docError').textContent = `${err.code}\n${err.message}` +
      (err.details ? `\n\n${JSON.stringify(err.details, null, 2)}` : '');
    $('#docError').classList.remove('hidden');
    // still show partial diagnostic chain when available
    state.result = null;
    renderResults(null);
    switchTab('input');
  }
}

// -------------------------------------------------------------- results ---
function renderResults(result) {
  state.sourcePathEls = new Map();
  state.expandedPathEls = new Map();

  const srcRoot = $('#sourceTree');
  const expRoot = $('#expandedTree');
  srcRoot.innerHTML = '';
  expRoot.innerHTML = '';

  if (!result) {
    srcRoot.innerHTML = '<p class="placeholder">解析失败或尚未解析。</p>';
    expRoot.innerHTML = '<p class="placeholder">—</p>';
    $('#traceDetail').innerHTML = '<p class="placeholder">解析失败，无追踪信息。</p>';
    $('#globalChain').innerHTML = '';
    $('#warnings').innerHTML = '';
    return;
  }

  const rawDoc = readDoc(true);
  srcRoot.appendChild(buildTree(rawDoc, '$', 'source'));
  if (!result.expanded.length) {
    expRoot.innerHTML = '<p class="placeholder">展开结果为空（所有字段均被丢弃，见下方警告）。</p>';
  } else {
    expRoot.appendChild(buildTree(result.expanded, '$', 'expanded'));
  }

  $('#warnings').innerHTML = (result.warnings || [])
    .map(w => `<div class="warning">⚠ ${escapeHtml(w.message)}</div>`).join('');
  renderGlobalChain(result.decisionChain);
  $('#traceDetail').innerHTML = '<p class="placeholder">在「展开结果」中点击任意字段。</p>';
}

// -------------------------------------------------------------- tree UI ---
function buildTree(value, path, kind) {
  const ul = document.createElement('ul');
  const li = document.createElement('li');
  li.appendChild(renderNode(value, path, '$', kind, true));
  ul.appendChild(li);
  return ul;
}

function renderNode(value, path, key, kind, isRoot = false) {
  const wrap = document.createElement('div');
  wrap.className = 'node';
  wrap.dataset.path = path;

  const isExpandable = value !== null && typeof value === 'object';
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = isExpandable ? '▸' : '';
  wrap.appendChild(caret);

  if (!isRoot || Array.isArray(value)) {
    const keyEl = document.createElement('span');
    keyEl.className = 'key' + (kind === 'expanded' ? keyClass(key) : (key.startsWith('@') ? ' keyword' : ''));
    keyEl.textContent = isRoot ? '' : key;
    wrap.appendChild(keyEl);
  }
  appendValuePreview(wrap, value, kind);

  // children
  let childrenUl = null;
  if (isExpandable) {
    childrenUl = document.createElement('ul');
    childrenUl.hidden = true;
    const entries = Array.isArray(value)
      ? value.map((v, i) => [`[${i}]`, v, `${path}[${i}]`])
      : Object.entries(value).map(([k, v]) => [k, v, `${path}.${k}`]);
    for (const [childKey, childVal, childPath] of entries) {
      const childLi = document.createElement('li');
      childLi.appendChild(renderNode(childVal, childPath, childKey, kind));
      childrenUl.appendChild(childLi);
    }
    caret.textContent = '▸';
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      childrenUl.hidden = !childrenUl.hidden;
      caret.textContent = childrenUl.hidden ? '▸' : '▾';
    });
    // auto-expand shallow levels
    const depth = path.split(/\.|\[\d+\]/).length - 1;
    if (depth < 2) { childrenUl.hidden = false; caret.textContent = '▾'; }
  }

  const item = document.createElement('div');
  item.appendChild(wrap);
  if (childrenUl) item.appendChild(childrenUl);

  // register + click handling
  if (kind === 'source') {
    state.sourcePathEls.set(path, wrap);
    wrap.classList.add('clickable');
    wrap.addEventListener('click', () => selectFromSource(path));
  } else {
    state.expandedPathEls.set(path, wrap);
    wrap.classList.add('clickable');
    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      selectFromExpanded(path);
    });
  }
  return item;
}

function keyClass(key) {
  if (key.startsWith('@')) return 'keyword';
  if (/^https?:|^[a-z][a-z0-9+.-]*:/.test(key)) return 'iri';
  return '';
}

function appendValuePreview(wrap, value, kind) {
  if (value === null || typeof value !== 'object') {
    const v = document.createElement('span');
    v.className = 'val ' + typeof value + (value === null ? ' null' : '');
    v.textContent = value === null ? 'null' : String(value);
    wrap.appendChild(v);
    return;
  }
  const entries = Array.isArray(value) ? value.length : Object.keys(value).length;
  const punct = document.createElement('span');
  punct.className = 'punct';
  punct.textContent = Array.isArray(value)
    ? `[ ${entries} ]`
    : `{ ${entries} }`;
  wrap.appendChild(punct);

  if (kind === 'expanded' && !Array.isArray(value)) {
    if ('@protected' in value) wrap.appendChild(tag('protected', '🛡'));
  }
}

function tag(cls, text) {
  const el = document.createElement('span');
  el.className = 'meta-tag ' + cls;
  el.textContent = text;
  return el;
}

// ----------------------------------------------------------- selection ----
function normPath(p) { return p.replace(/\[\d+\]/g, '[]'); }

function selectFromExpanded(path) {
  const result = state.result;
  if (!result) return;
  const np = normPath(path);
  const candidates = result.traces
    .filter(t => t.outPath)
    .map(t => ({ t, tp: normPath(t.outPath) }))
    .filter(({ tp }) => np === tp || np.startsWith(tp + '.') || np.startsWith(tp + '[]'));
  if (!candidates.length) {
    showNoTrace(path);
    return;
  }
  // longest matching trace outPath, preferring exact
  candidates.sort((a, b) =>
    (b.tp.length - a.tp.length) || (b.t.outPath.length - a.outPath.length));
  showTrace(candidates[0].t, { expandedPath: path });
}

function selectFromSource(path) {
  const result = state.result;
  if (!result) return;
  const np = normPath(path);
  // a source node relates to the trace whose sourcePath is it or its descendant
  const hit = result.traces
    .filter(t => t.sourcePath)
    .find(t => t.sourcePath === path) ||
    result.traces
      .filter(t => t.sourcePath && (normPath(t.sourcePath) === np || normPath(t.sourcePath).startsWith(np + '.')))
      .sort((a, b) => a.sourcePath.length - b.sourcePath.length)[0];
  if (hit) showTrace(hit, {});
}

function clearSelectionMarks() {
  $$('.node.selected').forEach(n => n.classList.remove('selected'));
  $$('.node.source-hit').forEach(n => n.classList.remove('source-hit'));
}

function showNoTrace(path) {
  $('#traceDetail').innerHTML =
    `<p class="placeholder">该展开节点（<code>${escapeHtml(path)}</code>）没有对应的属性决策 —— 它可能是词项对象内部结构（如 <code>@value</code>、<code>@list</code> 元素）。请点击其上层属性节点。</p>`;
  switchTab('trace');
}

function showTrace(trace, { expandedPath }) {
  clearSelectionMarks();
  if (expandedPath) state.expandedPathEls.get(expandedPath)?.classList.add('selected');
  const srcEl = state.sourcePathEls.get(trace.sourcePath);
  srcEl?.classList.add('source-hit');
  srcEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const finalCtx = state.result.finalContext;
  const detail = $('#traceDetail');
  const termInfo = renderTermInfo(trace);
  detail.innerHTML = `
    <div class="trace-source">
      <strong>原始字段</strong>
      <div><code>${escapeHtml(trace.sourcePath)}</code></div>
      <div class="hint" style="margin-top:4px">${escapeHtml(describeTraceKind(trace))}</div>
    </div>
    <dl class="trace-kv">
      ${trace.sourceKey !== undefined ? `<dt>原始键</dt><dd>${escapeHtml(trace.sourceKey)}</dd>` : ''}
      <dt>展开为</dt><dd>${trace.expandedIri ? `<span class="key iri">${escapeHtml(trace.expandedIri)}</span>`
        : '—（已丢弃）'}</dd>
      ${trace.outPath ? `<dt>输出路径</dt><dd>${escapeHtml(trace.outPath)}</dd>` : ''}
      ${trace.kind === 'node-id' ? `<dt>@id 解析</dt><dd><code>${escapeHtml(trace.value)}</code> → ${escapeHtml(trace.resolved)}</dd>` : ''}
    </dl>
    ${termInfo}
    ${trace.reason ? `<div class="warning">丢弃原因：${escapeHtml(trace.reason)}</div>` : ''}
    <div>
      <strong style="font-size:12px">该字段可见的完整 context 决策链（${trace.decisionChain?.length ?? 0} 步）</strong>
      <div class="chain-list" style="margin-top:6px">${(trace.decisionChain ?? []).map(c => chainStepHtml(c, trace)).join('') || '<p class="hint">无</p>'}</div>
    </div>
  `;
  // mark the resolved value nodes for node-id too
  if (trace.kind === 'node-id' && trace.outPath) {
    const el = state.expandedPathEls.get(trace.outPath);
    if (el) el.classList.add('selected');
  }
  switchTab('trace');
}

function describeTraceKind(t) {
  if (t.kind === 'node-id') return '节点标识符（@id）经 @base 解析';
  if (t.kind === 'node-type') return '节点类型（@type）解析';
  if (t.kind === 'dropped') return '该字段被展开算法丢弃';
  if (t.container?.length) return `属性展开（容器：${t.container.join(' + ')}）`;
  return '属性展开';
}

function renderTermInfo(trace) {
  const t = trace.term;
  if (!t) return '';
  let body = '';
  if (t.via === 'term') {
    body = `直接命中词项定义 → <code>${escapeHtml(t.id)}</code>` +
      (t.protected ? ' <span class="meta-tag protected">受保护</span>' : '');
    if (t.history?.length) {
      body += `<div class="hint" style="margin-top:6px">词项覆盖历史（新→旧）：</div>` +
        `<div class="chain-list" style="margin-top:4px">` +
        [`<div class="chain-step"><span class="step-icon term-override">●</span><div class="step-body">
           <div class="step-title">当前: ${escapeHtml(t.id)}</div></div></div>`]
          .concat(t.history.map((h, i) =>
            `<div class="chain-step"><span class="step-icon ${i === 0 ? 'term-override' : 'term'}">○</span>
             <div class="step-body"><div class="step-title">${escapeHtml(h.id)}</div>
             <div class="step-note">${h.container ? '容器 ' + h.container.join('+') : ''} ${h.typeMapping ? '类型 ' + escapeHtml(h.typeMapping) : ''} ${h.protected ? '🛡 受保护' : ''}</div></div></div>`
          )).join('') + `</div>`;
    }
  } else if (t.via === 'compact-iri') {
    body = `compact IRI：前缀 <code>${escapeHtml(t.prefix)}</code> = <code>${escapeHtml(t.prefixId)}</code>`;
  } else if (t.via === '@vocab') {
    body = `无词项，走 <code>@vocab</code>：<code>${escapeHtml(t.vocab)}</code> + 键名`;
  } else if (t.via === 'absolute-iri') {
    body = '键本身是绝对 IRI，原样使用';
  }
  return body ? `<div class="trace-kv" style="grid-template-columns:82px 1fr"><dt>解析方式</dt><dd>${body}</dd></div>` : '';
}

// ------------------------------------------------------------- chain UI ----
function renderGlobalChain(chain) {
  $('#globalChain').innerHTML =
    (chain || []).map(c => chainStepHtml(c, null)).join('') ||
    '<p class="hint">无 context 决策（文档未使用 @context）。</p>';
}

function chainStepHtml(c, trace) {
  const icon = { 'term-override': '⇄', 'term': 'T', 'include': '↳', 'reset': '∅',
    'base': 'B', 'vocab': 'V', 'language': 'L', 'keyword-alias': 'K', 'term-cleared': '×',
    'version': '#' }[c.kind] ?? '·';
  let title = '', sub = '';
  switch (c.kind) {
    case 'include':
      title = `引入 ${c.ref}`;
      sub = `钉死 revision ${c.revision ? shortRev(c.revision) : '?'}`;
      break;
    case 'term':
      title = `定义词项 "${c.term}" → ${c.id}`;
      sub = [c.container ? `容器 ${c.container.join('+')}` : null, c.typeMapping ? `@type ${c.typeMapping}` : null,
        c.protected ? '受保护' : null].filter(Boolean).join(' · ');
      break;
    case 'term-override':
      title = `覆盖词项 "${c.term}"`;
      sub = `${escapeHtml(c.previous?.id)} <span class="step-arrow">⇒</span> ${escapeHtml(c.id)}`;
      break;
    case 'term-cleared':
      title = `删除词项 "${c.term}"`;
      sub = escapeHtml(c.note ?? '');
      break;
    case 'reset':
      title = '空 context 重置';
      sub = escapeHtml(c.keptProtected?.length ? `保留受保护词项: ${c.keptProtected.join(', ')}` : '所有词项/@vocab/@base 已清空');
      break;
    case 'base':
      title = '@base';
      sub = escapeHtml(c.value === null ? '清除 base' : (c.resolved ? `${c.value} → ${c.resolved}` : c.value));
      break;
    case 'vocab':
      title = '@vocab';
      sub = escapeHtml(c.value === null ? '清除 vocab' : c.value);
      break;
    case 'language':
      title = '@language';
      sub = escapeHtml(c.value ?? '（清除）');
      break;
    case 'keyword-alias':
      title = `关键字别名 "${c.term}" → ${c.keyword}`;
      sub = escapeHtml(c.note ?? '');
      break;
    default:
      title = c.kind;
      sub = escapeHtml(c.note ?? '');
  }
  const relevant = trace && (c.term === trace.sourceKey);
  return `<div class="chain-step${relevant ? ' selected-step' : ''}" style="${relevant ? 'outline:1px solid var(--accent)' : ''}">
    <span class="step-icon ${c.kind}">${icon}</span>
    <div class="step-body">
      <div class="step-title">${escapeHtml(title)}</div>
      ${sub ? `<div class="step-note">${sub}</div>` : ''}
    </div>
  </div>`;
}

$('#copyChainBtn').addEventListener('click', () => {
  if (!state.result) return;
  navigator.clipboard?.writeText(JSON.stringify(state.result.decisionChain, null, 2));
});

// -------------------------------------------------------------- utils ----
function shortRev(r) { return r ? String(r).replace(/^rev_/, '').slice(0, 10) : '?'; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------------------------------------------------------------- boot ----
(async function boot() {
  document.body.className = 'show-input';
  try {
    await loadResources();
    await loadSessions();
    $('#docInput').value = JSON.stringify(SAMPLE, null, 2);
    // bind seeded resources by default for an instant first run
    for (const name of ['schema', 'ext']) {
      const r = state.resources.find(x => x.name === name);
      if (r) state.bindings.set(name, 'latest');
    }
    renderBindings();
  } catch (err) {
    $('#docError').textContent = '初始化失败：' + err.message;
    $('#docError').classList.remove('hidden');
  }
})();
