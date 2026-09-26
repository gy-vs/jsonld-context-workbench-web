// Value Expansion 的工作台实现：不做标准 1.1 的严格数据丢弃，
// 而是保留每个字段（含无法解析的），并为每个节点附加完整来源决策。
import {
  Tracer, processInitialContext, applyScopedContext, expandIri,
} from './context.js';
import { isKeyword, isAbsoluteIRI, resolveRelative } from './iri.js';
import { errDocDepth, errInvalidContext } from './errors.js';

export const DEFAULT_MAX_DOCUMENT_DEPTH = 128;
const MAP_CONTAINERS = new Set(['@index', '@type', '@language', '@id']);

/**
 * 展开文档入口。
 * @param document JSON 文档对象
 * @param initialContext 文档外的起始 context（会话所选）
 * @param loader (ref) => { document, resourceId, revision }
 */
export function expandDocument(document, initialContext, loader, options = {}) {
  const tracer = new Tracer();
  const maxDocumentDepth = options.maxDocumentDepth ?? DEFAULT_MAX_DOCUMENT_DEPTH;

  // 文档自带的 @context 先合并进来
  let seed = initialContext;
  if (document && typeof document === 'object' && !Array.isArray(document) && '@context' in document) {
    seed = document['@context'];
  }

  const { active } = processInitialContext(seed, loader, { tracer, ...options });

  const path = [];
  const root = expandElement(document, active, {
    tracer, loader, path, depth: 1, maxDocumentDepth, options,
    rootContextConsumed: true, // 根 @context 已在 seed 阶段处理，subject 内勿重复
  });

  return {
    root,
    trace: {
      layers: tracer.layers,
      events: tracer.events,
      warnings: tracer.warnings,
    },
  };
}

function failDepth(tracer, depth, limit, path) {
  tracer.event({ kind: 'error', detail: `文档嵌套深度超过上限 ${limit}`, path: path.join('.') });
  const e = new Error(`文档嵌套深度超过上限 ${limit}`);
  e.code = 'document-depth-overflow';
  throw e;
}

// ---------------------------------------------------------------------------
// 值展开：任意 JSON 值 -> 节点树
// ---------------------------------------------------------------------------
function expandElement(element, active, ctx) {
  const { tracer, loader, depth, maxDocumentDepth } = ctx;
  if (depth > maxDocumentDepth) failDepth(tracer, depth, maxDocumentDepth, ctx.path);

  if (element === null) {
    return scalarNode(null, 'null', active, ctx, { kind: 'value', value: null });
  }
  if (Array.isArray(element)) {
    return expandArray(element, active, ctx);
  }
  const t = typeof element;
  if (t === 'number' || t === 'boolean') {
    return scalarNode(element, t, active, ctx, coerceLiteral(element, active, ctx, t));
  }
  if (t === 'string') {
    return expandString(element, active, ctx);
  }
  // subject 展开前：应用父级 @type 作用域（仅在非“已带作用域”入口生效）
  let subjectActive = active;
  if (!ctx.skipTypeScope) {
    subjectActive = preApplyTypeScope(active, element, ctx.loader, ctx.tracer, ctx.path);
  }
  return expandSubject(element, subjectActive, ctx);
}

function expandArray(arr, active, ctx) {
  const { tracer, containerHint = null, termDef = null } = ctx;
  const items = [];
  arr.forEach((item, i) => {
    items.push(expandElement(item, active, { ...ctx, depth: ctx.depth + 1, path: ctx.path.concat(String(i)) }));
  });

  const isList = termDef?.container?.has('@list');
  if (isList || containerHint === '@list') {
    if (arr.some((v) => v === null)) {
      tracer.warn('@list 中不允许出现 null', { path: ctx.path.join('.') });
    }
    const node = {
      nodeId: nodeSeq.next().value,
      kind: 'list',
      path: ctx.path.slice(),
      items,
      decision: null,
      container: '@list',
      warnings: [],
    };
    items.forEach((it) => { if (it && it.nodeId) it.parentId = node.nodeId; });
    return node;
  }

  const wrapSet = termDef?.container?.has('@set') || containerHint === '@set';
  const node = {
    nodeId: nodeSeq.next().value,
    kind: 'array',
    path: ctx.path.slice(),
    items,
    decision: null,
    container: wrapSet ? '@set' : null,
    warnings: [],
  };
  items.forEach((it) => { if (it && it.nodeId) it.parentId = node.nodeId; });
  return node;
}

// 字符串值：应用词项 @type 强制（@id/@vocab/类型 IRI/@json/语言）
function expandString(value, active, ctx) {
  const { termDef } = ctx;
  if (!termDef) return scalarNode(value, 'string', active, ctx, { kind: 'value', value });
  return scalarNode(value, 'string', active, ctx, coerceLiteral(value, active, ctx, 'string'));
}

function scalarNode(rawValue, rawType, active, ctx, result) {
  const { tracer, propertyDecision = null, termDef = null } = ctx;
  const node = {
    nodeId: nodeSeq.next().value,
    kind: 'scalar',
    path: ctx.path.slice(),
    rawValue,
    rawType,
    value: result.value,
    valueType: result.type,
    language: result.language ?? termDef?.language ?? null,
    direction: termDef?.direction ?? active.direction ?? null,
    coerced: result.coerced ?? false,
    termDef: termDef ? summarizeTerm(termDef) : null,
    decision: propertyDecision,
    warnings: [],
  };
  if (result.warning) {
    node.warnings.push(result.warning);
    tracer.warn(result.warning, { path: ctx.path.join('.') });
  }
  return node;
}

// JSON-LD 值类型强制（@type: @id/@vocab/@json/类型 IRI；语言映射）
function coerceLiteral(value, active, ctx, rawType) {
  const { termDef, tracer } = ctx;
  if (rawType === 'number' || rawType === 'boolean') {
    if (termDef?.type && termDef.type !== '@none') {
      const type = termDef.type;
      return {
        value: { '@value': value, '@type': type }, type,
        coerced: true,
      };
    }
    const t = rawType === 'boolean' ? 'http://www.w3.org/2001/XMLSchema#boolean'
      : Number.isInteger(value) ? 'http://www.w3.org/2001/XMLSchema#integer'
        : 'http://www.w3.org/2001/XMLSchema#double';
    return { value: { '@value': value, '@type': t }, type: t };
  }

  if (typeof value !== 'string') return { value, type: null };
  if (!termDef || !termDef.type) {
    // 默认语言（活动 @language）只对字符串生效
    const lang = termDef?.language ?? active.language;
    if (lang && !isKeyword(value)) {
      return { value: { '@value': value, '@language': lang }, type: null, language: lang };
    }
    return { value, type: null };
  }

  const type = termDef.type;
  if (type === '@id') {
    const r = expandIri(active, value, { vocab: false });
    return {
      value: { '@id': r.iri }, type: '@id', coerced: true,
      warning: r.mechanism === 'unresolved' ? `相对 IRI "${value}" 无 @base 可解析，原样保留` : null,
    };
  }
  if (type === '@vocab') {
    const r = expandIri(active, value, { vocab: true });
    return {
      value: { '@id': r.iri }, type: '@vocab', coerced: true,
      warning: r.mechanism === 'unresolved' ? `词项/词表无法解析 "${value}"，原样保留` : null,
    };
  }
  if (type === '@none') return { value, type: null };
  if (type === '@json') return { value: { '@value': value, '@type': '@json' }, type: '@json', coerced: true };
  if (isAbsoluteIRI(type) || isKeyword(type)) {
    return { value: { '@value': value, '@type': type }, type, coerced: true };
  }
  tracer.warn(`词项 @type "${type}" 不是绝对 IRI，未强制`, { path: ctx.path.join('.') });
  return { value, type: null };
}

// ---------------------------------------------------------------------------
// 节点对象（subject / map / @value 对象）展开
// ---------------------------------------------------------------------------
function expandSubject(element, active, ctx) {
  const { tracer, loader, options } = ctx;

  // @value 对象
  if ('@value' in element) {
    return expandValueObject(element, active, ctx);
  }
  // @list / @set 包装
  if ('@list' in element) {
    if (Object.keys(element).some((k) => k !== '@list' && k !== '@index' && !(isKeywordAliasKey(element, k, active)))) {
      tracer.warn('@list 对象只能附带 @index', { path: ctx.path.join('.') });
    }
    return expandArray(asArray(element['@list']), active, { ...ctx, containerHint: '@list' });
  }
  if ('@set' in element) {
    return expandArray(asArray(element['@set']), active, { ...ctx, containerHint: '@set' });
  }

  const node = {
    nodeId: nodeSeq.next().value,
    kind: 'subject',
    path: ctx.path.slice(),
    id: null,
    types: [],
    properties: [],
    included: [],
    graphs: [],
    contextChain: active.layerPath.slice(),
    scopeLayerId: ctx.scopeLayerId ?? null,
    decision: ctx.propertyDecision ?? null,
    termDef: ctx.termDef ? summarizeTerm(ctx.termDef) : null,
    unresolvedKeys: [],
    warnings: [],
  };

  const pushWarn = (message, key) => {
    const w = { message, key };
    node.warnings.push(w);
    tracer.warn(message, { path: ctx.path.concat(key).filter((x) => x !== undefined).join('.') });
  };

  // 1) 就地应用对象内联 @context（嵌套 context）。
  //    根文档的 @context 已在入口 seed 阶段处理（rootContextConsumed），跳过。
  let workActive = active;
  if ('@context' in element && !ctx.rootContextConsumed) {
    const eventIdx = tracer.event({
      kind: 'inline-context', key: '@context', path: ctx.path.concat('@context').join('.'),
    });
    try {
      const { active: next, layerId } = applyScopedContext(active, element['@context'], loader, tracer, {
        reason: 'property', term: '@context', propertyPath: ctx.path.concat('@context'),
      });
      workActive = next;
      node.contextChain = workActive.layerPath.slice();
      node.scopeLayerId = layerId;
      node.inlineContextEvent = eventIdx;
    } catch (e) {
      node.warnings.push({ message: e.message });
      tracer.event({ kind: 'context-error', message: e.message, code: e.code, path: ctx.path.join('.') });
      if (options.throwOnError) throw e;
    }
  }

  // 2) 定位关键字别名后的 @id / @type 键
  let idKey = '@id';
  let typeKey = '@type';
  for (const key of Object.keys(element)) {
    if (key === '@context') continue;
    const r = expandIri(workActive, key, { vocab: true });
    if (r.iri === '@id') idKey = key;
    else if (r.iri === '@type') typeKey = key;
  }

  // 3) @id
  if (idKey in element) {
    const raw = element[idKey];
    if (typeof raw === 'string') {
      const idr = expandIri(workActive, raw, { vocab: false });
      node.id = idr.iri;
      node.idMechanism = idr.mechanism;
      if (idr.mechanism === 'unresolved') pushWarn(`@id "${raw}" 无 @base 可解析，原样保留`, idKey);
    } else {
      pushWarn('@id 必须是字符串，原样保留', idKey);
      node.id = JSON.stringify(raw);
    }
    node.idKey = idKey;
  }

  // 4) @type（此时仅收集原始类型词，供类型作用域判断）
  if (typeKey in element) {
    for (const v of asArray(element[typeKey])) {
      node.types.push({ raw: v, iri: null, mechanism: null });
    }
  }

  // 5) @type：用最终活动上下文展开类型 IRI
  if (node.types.length > 0) {
    node.types = node.types.map((t) => {
      const tr = expandIri(workActive, t.raw, { vocab: true });
      return {
        raw: t.raw, iri: tr.iri, mechanism: tr.mechanism,
        warning: tr.mechanism === 'unresolved' ? `类型 "${t.raw}" 无法解析` : null,
      };
    });
    node.typeScopeTypes = node.types.map((t) => t.iri);
  }

  // 6) 其余属性
  for (const key of Object.keys(element)) {
    if (key === '@context' || key === idKey || key === typeKey) continue;
    const r = expandIri(workActive, key, { vocab: true });

    if (r.iri === '@reverse' || r.def?.reverse) {
      expandReverseEntry(node, element[key], workActive, { ...ctx, key, tracer }, r);
      continue;
    }
    if (r.iri === '@included' || r.iri === '@graph') {
      const vals = asArray(element[key]);
      vals.forEach((v, i) => {
        const child = expandElement(v, workActive, {
          ...ctx, depth: ctx.depth + 1, path: ctx.path.concat(key, String(i)),
        });
        (r.iri === '@graph' ? node.graphs : node.included).push(child);
      });
      continue;
    }
    if (r.iri === '@nest' || r.def?.nest) {
      pushWarn(`@nest（键 ${key}）分组在展开中被忽略`, key);
      continue;
    }
    if (isKeyword(key) && !r.def) {
      pushWarn(`未知/不支持的关键字 ${key} 已忽略`, key);
      continue;
    }

    // 普通属性
    expandProperty(node, key, element[key], workActive, r, { ...ctx, tracer, loader, options }, pushWarn);
  }

  return node;
}

// 父上下文依据值的 @type 词查找类型作用域定义
function findTypeScopeDef(parentActive, rawType) {
  const direct = parentActive.terms?.[rawType];
  if (direct && direct.context !== null && direct.context !== undefined) return direct;
  const expanded = expandIri(parentActive, rawType, { vocab: true }).iri;
  for (const name of Object.keys(parentActive.terms ?? {})) {
    const d = parentActive.terms[name];
    if (d.iri === expanded && d.context !== null && d.context !== undefined) return d;
  }
  return null;
}

// 在展开 subject 值之前应用父级类型作用域：
// 返回可能被替换的活动上下文；@type 链上首个带 scoped @context 的类型生效。
function preApplyTypeScope(parentActive, subject, loader, tracer, path) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return parentActive;
  // 定位 @type 键（考虑关键字别名）
  let typeKey = '@type';
  for (const key of Object.keys(subject)) {
    const rr = expandIri(parentActive, key, { vocab: true });
    if (rr.iri === '@type') { typeKey = key; break; }
  }
  if (!(typeKey in subject)) return parentActive;
  for (const rawType of asArray(subject[typeKey])) {
    if (typeof rawType !== 'string') continue;
    const tdef = findTypeScopeDef(parentActive, rawType);
    if (!tdef) continue;
    const res = applyScopedContext(parentActive, tdef.context, loader, tracer, {
      reason: 'type', term: rawType, typeTerm: rawType, propertyPath: path,
    });
    tracer.event({ kind: 'scoped-applied', scope: 'type-pre', term: rawType, layerId: res.layerId, path: path.join('.') });
    return res.active;
  }
  return parentActive;
}

function expandValueObject(element, active, ctx) {
  const { tracer, termDef } = ctx;
  const value = element['@value'];
  let type = '@type' in element ? element['@type'] : null;
  let lang = '@language' in element ? element['@language'] : null;
  const dir = '@direction' in element ? element['@direction'] : (termDef?.direction ?? active.direction ?? null);

  if (type !== null && lang !== null) {
    tracer.warn('@value 对象不能同时含 @type 与 @language', { path: ctx.path.join('.') });
  }
  if (lang !== null) lang = String(lang).toLowerCase();

  const node = {
    nodeId: nodeSeq.next().value,
    kind: 'scalar',
    path: ctx.path.slice(),
    rawValue: value,
    rawType: value === null ? 'null' : typeof value,
    value: { '@value': value, ...(type ? { '@type': type } : {}), ...(lang ? { '@language': lang } : {}), ...(dir ? { '@direction': dir } : {}) },
    valueType: type,
    language: lang,
    direction: dir,
    coerced: false,
    termDef: termDef ? summarizeTerm(termDef) : null,
    decision: ctx.propertyDecision ?? null,
    warnings: [],
  };
  return node;
}

// 普通属性：属性 IRI 决策 + 属性作用域 context + 值展开 + 容器处理
function expandProperty(node, key, rawValue, active, iriResult, ctx, pushWarn) {
  const { tracer, loader } = ctx;
  const termDef = iriResult.def ?? null;

  const propPath = ctx.path.concat(key);
  const decision = {
    rawKey: key,
    iri: isKeyword(iriResult.iri) ? iriResult.iri : iriResult.iri,
    isKeyword: isKeyword(iriResult.iri),
    mechanism: iriResult.mechanism,
    vocab: active.vocab,
    base: active.base,
    prefixTerm: iriResult.prefixTerm ?? null,
    prefixIri: iriResult.prefixIri ?? null,
    resolvedTerm: termDef ? {
      iri: termDef.iri,
      type: termDef.type,
      container: termDef.container ? [...termDef.container] : null,
      language: termDef.language,
      direction: termDef.direction,
      reverse: termDef.reverse,
      prefix: termDef.prefix,
      protected: termDef.protected,
      history: termDef.history.map((h) => h.event),
    } : null,
    contextLayers: active.layerPath.slice(),
    scopeLayerId: null,
    unresolved: iriResult.mechanism === 'unresolved',
  };
  tracer.event({
    kind: 'property', key, iri: decision.iri, mechanism: decision.mechanism,
    path: propPath.join('.'),
    prefixTerm: decision.prefixTerm,
    termEvent: termDef?.history?.at(-1)?.event ?? null,
  });

  if (decision.unresolved) {
    node.unresolvedKeys.push(key);
    pushWarn(`属性 "${key}" 无词项/词表/@base 可解析，原样保留`, key);
  }

  // 属性作用域 context
  let valueActive = active;
  if (termDef?.context !== null && termDef?.context !== undefined) {
    try {
      const res = applyScopedContext(active, termDef.context, loader, tracer, {
        reason: 'property', term: key, propertyPath: propPath,
      });
      valueActive = res.active;
      decision.scopeLayerId = res.layerId;
      tracer.event({ kind: 'scoped-applied', scope: 'property', term: key, layerId: res.layerId, path: propPath.join('.') });
    } catch (e) {
      pushWarn(`属性 "${key}" 的作用域 context 无法应用: ${e.message}`, key);
    }
  }

  const containers = termDef?.container ?? null;
  const childCtx = {
    ...ctx,
    path: propPath,
    depth: ctx.depth + 1,
    termDef,
    propertyDecision: decision,
  };

  let valuesNode;
  if (containers && [...containers].some((c) => MAP_CONTAINERS.has(c))) {
    valuesNode = expandContainerMap(rawValue, valueActive, childCtx, containers, node, key, pushWarn);
  } else if (containers?.has('@graph')) {
    valuesNode = expandArray(asArray(rawValue), valueActive, childCtx);
    valuesNode.container = '@graph';
  } else {
    valuesNode = Array.isArray(rawValue)
      ? expandArray(rawValue, valueActive, childCtx)
      : expandElement(rawValue, valueActive, childCtx);
  }

  node.properties.push({
    name: key,
    iri: decision.iri,
    mechanism: decision.mechanism,
    unresolved: decision.unresolved,
    termDef: decision.resolvedTerm,
    container: containers ? [...containers] : null,
    values: valuesNode,
    decision,
  });
}


// 索引/类型/语言/ID 容器：对象变成 map 节点
function expandContainerMap(rawValue, active, ctx, containers, node, key, pushWarn) {
  const mapType = ['@index', '@type', '@language', '@id'].find((c) => containers.has(c));
  if (typeof rawValue !== 'object' || rawValue === null || Array.isArray(rawValue)) {
    pushWarn(`${mapType} 容器要求属性值为对象，回退为普通展开`, key);
    return expandElement(rawValue, active, ctx);
  }

  const mapNode = {
    nodeId: nodeSeq.next().value,
    kind: 'map',
    path: ctx.path.slice(),
    mapType,
    entries: [],
    container: [...containers],
    decision: ctx.propertyDecision ?? null,
    warnings: [],
  };

  for (const indexKey of Object.keys(rawValue)) {
    let normalizedKey = indexKey;
    if (mapType === '@language') normalizedKey = String(indexKey).toLowerCase();
    if (mapType === '@id') normalizedKey = expandIri(active, indexKey, { vocab: false }).iri;
    if (mapType === '@type') normalizedKey = expandIri(active, indexKey, { vocab: true }).iri;

    const childPath = ctx.path.concat(indexKey);
    // @language 容器：索引键即语言标签，注入到子节点（无显式 @language 时）
    let mapCtx = { ...ctx, path: childPath, containerKey: normalizedKey };
    if (mapType === '@language') mapCtx = { ...mapCtx, languageHint: normalizedKey };
    const child = Array.isArray(rawValue[indexKey])
      ? expandArray(rawValue[indexKey], active, mapCtx)
      : expandElement(rawValue[indexKey], active, mapCtx);
    annotateLanguage(child, normalizedKey, mapType === '@language');
    mapNode.entries.push({ index: indexKey, normalizedIndex: normalizedKey, value: child });
  }
  return mapNode;
}

// 给语言容器的子值补 @language（值未自带语言标签时）
function annotateLanguage(node, lang, isLanguageMap) {
  if (!isLanguageMap || !node) return;
  if (node.kind === 'array' || node.kind === 'list') {
    node.items.forEach((it) => annotateLanguage(it, lang, true));
    return;
  }
  if (node.kind === 'scalar' && node.language === null && typeof node.rawValue === 'string') {
    node.language = lang;
    if (node.valueType === null && typeof node.value === 'string') {
      node.value = { '@value': node.value, '@language': lang };
    }
  }
}

function expandReverseEntry(node, rawValue, active, ctx, iriResult) {
  const { tracer, key } = ctx;
  if (typeof rawValue !== 'object' || rawValue === null || Array.isArray(rawValue)) {
    tracer.warn(`@reverse 键 "${key}" 需要对象值，已忽略`, { path: ctx.path.join('.') });
    return;
  }
  for (const subKey of Object.keys(rawValue)) {
    const r = expandIri(active, subKey, { vocab: true });
    const decision = {
      rawKey: subKey, iri: r.iri, mechanism: r.mechanism,
      reverseOf: iriResult.mechanism === 'term' ? iriResult.def?.iri ?? key : key,
      contextLayers: active.layerPath.slice(),
      unresolved: r.mechanism === 'unresolved',
    };
    const child = Array.isArray(rawValue[subKey])
      ? expandArray(rawValue[subKey], active, { ...ctx, depth: ctx.depth + 1, path: ctx.path.concat(key, subKey) })
      : expandElement(rawValue[subKey], active, { ...ctx, depth: ctx.depth + 1, path: ctx.path.concat(key, subKey), propertyDecision: decision });
    node.properties.push({
      name: subKey, iri: r.iri, mechanism: r.mechanism, unresolved: decision.unresolved,
      container: ['@reverse'], values: child, decision, reverse: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const asArray = (v) => (Array.isArray(v) ? v : [v]);

function* idGenerator() {
  let n = 0;
  for (;;) yield `n${n++}`;
}
const nodeSeq = idGenerator();

const summarizeTerm = (d) => ({
  iri: d.iri,
  type: d.type,
  container: d.container ? [...d.container] : null,
  language: d.language,
  direction: d.direction,
  reverse: d.reverse,
  prefix: d.prefix,
  protected: d.protected,
  history: d.history.map((h) => h.event),
});

const describeMechanism = (r) => {
  switch (r.mechanism) {
    case 'term': return { label: `关键字别名 → @id` };
    default: return null;
  }
};

export { errInvalidContext };
