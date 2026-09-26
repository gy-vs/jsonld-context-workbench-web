// JSON-LD 1.1 Context Processing（面向工作台的子集实现）。
// 支持：嵌套 context、词项覆盖、@base、@vocab、容器、@context 作用域、
// 受保护词项、关键字别名、相对 IRI、空 context 重置、循环引用与最大深度检测。
import {
  isAbsoluteIRI, isKeyword, isRemoteRef, resolveRelative, resolveVocab,
  endsWithGenDelim,
} from './iri.js';
import {
  errInvalidContext, errInvalidTerm, errProtected, errCycle, errDepth,
  errUnknownResource, errRemote,
} from './errors.js';

export const DEFAULT_MAX_CONTEXT_DEPTH = 64;
const CONTAINER_KEYWORDS = new Set(['@list', '@set', '@index', '@language', '@id', '@type', '@graph']);
const DIRECTIONS = new Set(['ltr', 'rtl']);

// ---------------------------------------------------------------------------
// Tracer：记录 context 决策的完整痕迹（layer 树 + 事件流），供前端溯源。
// ---------------------------------------------------------------------------
export class Tracer {
  constructor() {
    this.layers = [];
    this.events = [];
    this.warnings = [];
  }

  layer(kind, attrs = {}) {
    const id = this.layers.length;
    const layer = { id, kind, parentId: this.currentLayer ?? null, ...attrs };
    this.layers.push(layer);
    this.currentLayer = id;
    return id;
  }

  endLayer() {
    const cur = this.layers[this.currentLayer];
    this.currentLayer = cur ? cur.parentId : null;
  }

  event(attrs) {
    const idx = this.events.length;
    this.events.push({ idx, layerId: this.currentLayer, ...attrs });
    return idx;
  }

  warn(message, details = {}) {
    const w = { message, ...details };
    this.warnings.push(w);
    return w;
  }
}

const freshContext = () => ({
  base: null,
  vocab: null,
  language: null,
  direction: null,
  terms: Object.create(null),
  layerPath: [],
});

const cloneContext = (ctx) => ({
  base: ctx.base,
  vocab: ctx.vocab,
  language: ctx.language,
  direction: ctx.direction,
  terms: ctx.terms,            // 以 copy-on-write 方式共享词表
  layerPath: ctx.layerPath.slice(),
});

const newTermDef = () => ({
  iri: null,
  reverse: false,
  type: null,
  container: null,            // Set
  context: null,              // 作用域 context 原文
  language: undefined,        // undefined=未设置；null=显式置空
  direction: undefined,
  nest: null,
  prefix: null,
  protected: false,
  keyAlias: false,
  history: [],
});

// ---------------------------------------------------------------------------
// 入口：解析初始 context，返回活动上下文
// ---------------------------------------------------------------------------
export function processInitialContext(initialContext, loader, options = {}) {
  const tracer = options.tracer ?? new Tracer();
  const maxDepth = options.maxContextDepth ?? DEFAULT_MAX_CONTEXT_DEPTH;
  const active = freshContext();

  if (initialContext !== null) {
    const lid = tracer.layer('inline', { label: '文档内联 @context', depth: 1 });
    active.layerPath.push(lid);
    processContext(active, initialContext, {
      tracer, loader, depth: 1, maxDepth, ancestors: [],
    });
    tracer.endLayer();
  }
  return { active, tracer };
}

/**
 * 懒应用词项/类型作用域 context（值展开时调用）。
 * 返回新的活动上下文，layerPath 追加作用域层。
 */
export function applyScopedContext(parentActive, rawContext, loader, tracer, options) {
  if (rawContext === null || rawContext === undefined) {
    return { active: parentActive };
  }
  const active = cloneContext(parentActive);
  const layerAttrs = {
    label: options.reason === 'type' ? `类型作用域 @type=${options.typeTerm}` : `属性作用域 ${options.term}`,
    reason: options.reason,
    term: options.term ?? null,
    typeTerm: options.typeTerm ?? null,
    propertyPath: options.propertyPath ?? null,
    depth: 1,
  };
  const lid = tracer.layer('scope', layerAttrs);
  active.layerPath.push(lid);
  processContext(active, rawContext, {
    tracer, loader, depth: 1,
    maxDepth: DEFAULT_MAX_CONTEXT_DEPTH, ancestors: [],
    localProtected: false,
    scopeOrigin: options,
  });
  tracer.endLayer();
  return { active, layerId: lid };
}

// ---------------------------------------------------------------------------
// Context Processing 主流程
// ---------------------------------------------------------------------------
function processContext(active, context, opts) {
  const { tracer, loader, depth, maxDepth, ancestors } = opts;
  const localProtected = opts.localProtected ?? false;

  if (depth > maxDepth) {
    throw errDepth(`context 嵌套深度超过上限 ${maxDepth}`, { limit: maxDepth });
  }

  // 5.1 null —— 重置为初始空上下文（@base/@vocab/词项全部清空）
  if (context === null) {
    const lid = tracer.layer('reset', { label: '@context: null（重置）', depth });
    active.base = null;
    active.vocab = null;
    active.language = null;
    active.direction = null;
    active.terms = Object.create(null);
    active.layerPath = active.layerPath.concat(lid);
    tracer.event({ kind: 'reset', detail: '空 context 重置所有映射' });
    tracer.endLayer();
    return;
  }

  // 5.2 数组 —— 按序处理；循环检测使用 DFS 调用栈（进入压栈、退出弹栈），
  // 因此同一层级重复包含同一资源不算循环，嵌套再次进入才算。
  if (Array.isArray(context)) {
    context.forEach((entry) => {
      processContext(active, entry, { ...opts, depth: depth + 1, ancestors });
    });
    return;
  }

  // 5.3 字符串 —— 本地资源引用
  if (typeof context === 'string') {
    processContextRef(active, context, { ...opts, localProtected });
    return;
  }

  if (typeof context !== 'object') {
    throw errInvalidContext('@context 必须是对象、数组、字符串或 null', { received: typeof context });
  }

  // 对象：按身份检测祖先链循环
  for (const a of ancestors) {
    if (a.kind === 'obj' && a.value === context) {
      throw errCycle('检测到 context 内联对象循环引用', { kind: 'inline-object' });
    }
  }
  const lid = opts.inlineLayer ?? tracer.layer('inline', {
    label: opts.layerLabel ?? '内联 context 对象', depth,
  });
  const pushedInline = opts.inlineLayer === undefined;
  if (pushedInline) active.layerPath.push(lid);

  const nextAncestors = ancestors.concat([{ kind: 'obj', value: context }]);

  // 对象级 @protected：作用于本对象内所有词项定义
  const objectProtected = context['@protected'] === true;

  // 按文档键序处理：嵌套 @context / @base / @vocab 与词项定义同序，
  // 因此嵌套 context 可以影响其后出现的词项 IRI 解析。
  const keyOrder = Object.keys(context);
  for (const key of keyOrder) {
    switch (key) {
      case '@version':
        if (context['@version'] !== 1.1) {
          throw errInvalidContext('不支持的 @version，仅支持 1.1', { received: context['@version'] });
        }
        break;
      case '@import':
        if (context['@import'] !== null) {
          tracer.warn('@import 已忽略：工作台仅支持本地 @context 嵌套', { keyword: '@import' });
        }
        break;
      case '@protected':
        break;
      case '@base': {
        const value = context['@base'];
        if (value !== null && typeof value !== 'string') {
          throw errInvalidContext('@base 必须是 IRI 字符串或 null');
        }
        if (value === null) active.base = null;
        else if (isAbsoluteIRI(value)) active.base = value;
        else if (active.base) active.base = resolveRelative(active.base, value);
        else active.base = value;
        tracer.event({ kind: 'base', from: value, to: active.base, reset: value === null });
        break;
      }
      case '@vocab': {
        const value = context['@vocab'];
        if (value !== null && typeof value !== 'string') {
          throw errInvalidContext('@vocab 必须是字符串或 null');
        }
        if (value === null) {
          active.vocab = null;
        } else {
          let v = resolveVocab(active.vocab, value);
          if (!isAbsoluteIRI(v) && active.base) v = resolveRelative(active.base, v);
          active.vocab = v;
        }
        tracer.event({ kind: 'vocab', from: value, to: active.vocab, reset: value === null });
        break;
      }
      case '@language': {
        const value = context['@language'];
        if (value !== null && typeof value !== 'string') {
          throw errInvalidContext('@language 必须是字符串或 null');
        }
        active.language = value === null ? null : String(value).toLowerCase();
        tracer.event({ kind: 'language', to: active.language });
        break;
      }
      case '@direction': {
        const value = context['@direction'];
        if (value !== null && !DIRECTIONS.has(value)) {
          throw errInvalidContext('@direction 必须是 ltr、rtl 或 null');
        }
        active.direction = value;
        tracer.event({ kind: 'direction', to: value });
        break;
      }
      case '@context': {
        // context 对象内部的嵌套 @context（引用+补充的分组写法）
        const sub = context['@context'];
        if (sub !== null && sub !== undefined) {
          processContext(active, sub, {
            ...opts,
            depth: depth + 1,
            ancestors: nextAncestors,
            localProtected,
            layerLabel: '内联 @context 分组',
          });
        }
        break;
      }
      default: {
        if (key.startsWith('@')) {
          if (isKeyword(key)) {
            // 关键字作为词项键：进入定义流程，由映射一致性校验处理
            processTermDefinition(active, key, context[key], {
              ...opts,
              depth: depth + 1,
              ancestors: nextAncestors,
              localProtected: localProtected || objectProtected,
              inlineLayer: lid,
            });
            continue;
          }
          tracer.warn(`未知关键字 ${key} 已忽略`, { keyword: key });
          continue;
        }
        processTermDefinition(active, key, context[key], {
          ...opts,
          depth: depth + 1,
          ancestors: nextAncestors,
          localProtected: localProtected || objectProtected,
          inlineLayer: lid,
        });
      }
    }
  }

  if (pushedInline) tracer.endLayer();
}

// 字符串引用：拦截公网 -> 循环检测 -> 本地加载
function processContextRef(active, ref, opts) {
  const { tracer, loader, depth, maxDepth, ancestors, localProtected } = opts;

  if (isRemoteRef(ref)) {
    throw errRemote('禁止访问公网 context，只能引用会话快照中的本地资源', { ref });
  }
  if (isAbsoluteIRI(ref)) {
    // 其它绝对协议（urn 之外）本地无法解析
    throw errUnknownResource(`无法解析的绝对 context 引用: ${ref}`, { ref });
  }
  for (const a of ancestors) {
    if (a.kind === 'ref' && a.value === ref) {
      throw errCycle(`检测到 context 循环引用: ${[...ancestors.filter((x) => x.kind === 'ref').map((x) => x.value), ref].join(' -> ')}`, {
        ref, chain: ancestors.filter((x) => x.kind === 'ref').map((x) => x.value).concat(ref),
      });
    }
  }

  const loaded = loader(ref); // 未知资源时 loader 抛 unknown-resource
  const lid = tracer.layer('include', {
    label: ref, ref, resourceId: loaded.resourceId, revision: loaded.revision, depth,
  });
  active.layerPath.push(lid);
  tracer.event({ kind: 'include', ref, resourceId: loaded.resourceId, revision: loaded.revision });

  const doc = loaded.document;
  const nested = doc && typeof doc === 'object' && '@context' in doc ? doc['@context'] : doc;

  processContext(active, nested, {
    tracer, loader, depth: depth + 1, maxDepth,
    ancestors: ancestors.concat([{ kind: 'ref', value: ref }]),
    localProtected,
    layerLabel: `${ref} 内容`,
  });
  tracer.endLayer();
}

// ---------------------------------------------------------------------------
// 词项定义
// ---------------------------------------------------------------------------
function processTermDefinition(active, term, value, opts) {
  const { tracer, localProtected = false } = opts;

  if (typeof term !== 'string') {
    throw errInvalidTerm(`词项必须是字符串`, { term });
  }

  const existing = active.terms[term];

  // null 定义：词项从活动上下文中移除。
  // JSON-LD 1.1：显式 null 定义可以清除受保护词项（之后即可重新定义），
  // 这是规范留给 profile 覆盖的逃生舱。
  if (value === null) {
    const idx = tracer.event({
      kind: 'remove', term, before: existing ? existing.iri : null,
      protected: localProtected, clearedProtection: Boolean(existing?.protected),
    });
    delete active.terms[term];
    return idx;
  }

  let def = typeof value === 'string' ? { '@id': value } : { ...value };
  if (typeof def !== 'object') {
    throw errInvalidTerm(`词项 "${term}" 的定义必须是对象或字符串`, { term });
  }

  // 先解析出新定义，再做 protected 兼容性比较
  const candidate = newTermDef();
  candidate.protected = def['@protected'] !== undefined ? def['@protected'] === true : localProtected;

  // @id（IRI 映射）
  let idValue;
  if ('@id' in def) {
    idValue = def['@id'];
    if (idValue !== null && typeof idValue !== 'string') {
      throw errInvalidTerm(`词项 "${term}" 的 @id 必须是字符串或 null`, { term });
    }
  } else {
    idValue = term;
  }

  // 保留关键字名校验：键名恰为关键字时（如 "@id"），映射必须保持为该关键字
  if (isKeyword(term) && idValue !== term) {
    throw errInvalidTerm(`关键字 ${term} 不能映射到 ${idValue}`, { term });
  }

  // "@id": null —— 与 null 定义等价，允许清除（含受保护）词项
  if (idValue === null) {
    const idx = tracer.event({
      kind: 'remove', term, before: existing ? existing.iri : null,
      protected: candidate.protected, clearedProtection: Boolean(existing?.protected),
    });
    delete active.terms[term];
    return idx;
  }

  // @reverse 简写/属性
  const hasReverse = '@reverse' in def;
  if (hasReverse) {
    if ('@id' in def) {
      throw errInvalidTerm(`词项 "${term}" 不能同时包含 @id 与 @reverse`, { term });
    }
    const rv = def['@reverse'];
    if (typeof rv !== 'string') {
      throw errInvalidTerm(`词项 "${term}" 的 @reverse 必须是字符串`, { term });
    }
    candidate.iri = expandMappingIri(active, rv, term, '@reverse');
    if (isKeyword(candidate.iri)) {
      throw errInvalidTerm(`词项 "${term}" 的 @reverse 不能映射到关键字`, { term });
    }
    candidate.reverse = true;
  } else {
    candidate.iri = expandMappingIri(active, idValue, term, '@id', { termIsImplicit: !('@id' in def) });
    // 关键字别名：仅允许映射到关键字自身，或 @type -> @id/@vocab
    if (isKeyword(idValue)) {
      // 关键字别名：映射目标必须仍是关键字本身；
      // 唯一例外是 @type 键可以别名到 @id 或 @vocab。
      if (candidate.iri === idValue) {
        candidate.keyAlias = true;
      } else if (idValue === '@type' && (candidate.iri === '@id' || candidate.iri === '@vocab')) {
        candidate.keyAlias = true;
      } else {
        throw errInvalidTerm(`关键字 ${idValue} 不能被别名到其它 IRI`, { term });
      }
    } else if (isKeyword(term)) {
      throw errInvalidTerm(`关键字 ${term} 不能作为词项`, { term });
    }
    if (!isKeyword(candidate.iri) && !isAbsoluteIRI(candidate.iri) && !candidate.iri.startsWith('_:')) {
      throw errInvalidTerm(`词项 "${term}" 的 IRI 映射无法解析为绝对 IRI: ${candidate.iri}`, {
        term, mapping: candidate.iri,
      });
    }
  }

  // @type
  if ('@type' in def && !hasReverse) {
    const tv = def['@type'];
    if (typeof tv !== 'string') {
      throw errInvalidTerm(`词项 "${term}" 的 @type 必须是字符串`, { term });
    }
    candidate.type = isKeyword(tv) ? tv : expandMappingIri(active, tv, term, '@type');
    if (isKeyword(candidate.type) && !['@id', '@vocab', '@json', '@none'].includes(candidate.type)) {
      throw errInvalidTerm(`词项 "${term}" 的 @type 不能是关键字 ${candidate.type}`, { term });
    }
    if (!isKeyword(candidate.type) && !isAbsoluteIRI(candidate.type)) {
      throw errInvalidTerm(`词项 "${term}" 的 @type 无法解析为绝对 IRI: ${candidate.type}`, { term });
    }
  }

  // @container
  if ('@container' in def) {
    let cv = def['@container'];
    if (cv !== null && cv !== undefined) {
      const arr = Array.isArray(cv) ? cv : [cv];
      for (const c of arr) {
        if (!CONTAINER_KEYWORDS.has(c)) {
          throw errInvalidTerm(`词项 "${term}" 的 @container 含非法成员 ${c}`, { term });
        }
      }
      const set = new Set(arr);
      if (set.has('@list') && set.size !== 1) {
        throw errInvalidTerm(`词项 "${term}" 的 @list 容器不能与其它容器组合`, { term });
      }
      if (hasReverse && set.size !== 0 && !(set.size === 1 && set.has('@set'))) {
        throw errInvalidTerm(`@reverse 词项 "${term}" 的容器只能是 @set`, { term });
      }
      candidate.container = set;
    }
  }

  // @type 别名（@id 为 "@type"）的容器只允许 @set / @index
  if (idValue === '@type' && candidate.container) {
    const allowed = [...candidate.container].every((c) => c === '@set' || c === '@index');
    if (!allowed) {
      throw errInvalidTerm(`@type 别名 "${term}" 不能使用容器 ${[...candidate.container].join(',')}`, { term });
    }
  }

  // @context（属性/类型作用域）
  if ('@context' in def) {
    const cv = def['@context'];
    const t = typeof cv;
    if (cv !== null && !(t === 'string' || Array.isArray(cv) || t === 'object')) {
      throw errInvalidTerm(`词项 "${term}" 的 @context 必须是 context`, { term });
    }
    candidate.context = cv;
  }

  if ('@language' in def) {
    const lv = def['@language'];
    if (lv !== null && typeof lv !== 'string') {
      throw errInvalidTerm(`词项 "${term}" 的 @language 必须是字符串或 null`, { term });
    }
    candidate.language = lv === null ? null : String(lv).toLowerCase();
  }
  if ('@direction' in def) {
    const dv = def['@direction'];
    if (dv !== null && !DIRECTIONS.has(dv)) {
      throw errInvalidTerm(`词项 "${term}" 的 @direction 必须是 ltr、rtl 或 null`, { term });
    }
    candidate.direction = dv;
  }
  if ('@nest' in def) {
    if (typeof def['@nest'] !== 'string') {
      throw errInvalidTerm(`词项 "${term}" 的 @nest 必须是字符串`, { term });
    }
    candidate.nest = def['@nest'];
  }
  if ('@prefix' in def) {
    if (typeof def['@prefix'] !== 'boolean') {
      throw errInvalidTerm(`词项 "${term}" 的 @prefix 必须是布尔值`, { term });
    }
    candidate.prefix = def['@prefix'];
  } else {
    candidate.prefix = candidate.keyAlias ? false : endsWithGenDelim(candidate.iri);
  }
  if (candidate.prefix && !validTermForPrefix(term)) {
    throw errInvalidTerm(`词项 "${term}" 含非法字符，不能作为前缀（@prefix: true）`, { term });
  }

  // protected 兼容性比较
  if (existing && existing.protected) {
    if (!definitionsCompatible(existing, candidate)) {
      throw errProtected(
        `受保护词项 "${term}" 不能被重定义（${describeConflict(existing, candidate)}）`,
        { term, existing: describeDef(existing), replacement: describeDef(candidate) },
      );
    }
    const idxKeep = tracer.event({
      kind: 'protected-kept', term, iri: existing.iri,
      detail: '新定义与受保护定义一致，保留原定义',
    });
    existing.history.push({ event: idxKeep });
    return;
  }

  candidate.history = (existing?.history ?? []).slice();
  const idx = tracer.event({
    kind: existing ? 'override' : 'define',
    term,
    iri: candidate.iri,
    before: existing ? existing.iri : null,
    protected: candidate.protected,
    keywordAlias: candidate.keyAlias,
    reverse: candidate.reverse,
    type: candidate.type,
    container: candidate.container ? [...candidate.container] : null,
    prefix: candidate.prefix,
    hasScopedContext: candidate.context !== null && candidate.context !== undefined,
  });
  candidate.history.push({ event: idx });
  active.terms = { ...active.terms, [term]: candidate };
}

// 词项 @id/@type/@reverse 的 IRI 展开（带词项链循环检测）
function expandMappingIri(active, value, term, field, opts = {}) {
  if (typeof value !== 'string') {
    throw errInvalidTerm(`词项 "${term}" 的 ${field} 必须是字符串`, { term });
  }
  if (isKeyword(value)) return value;
  if (value.startsWith('_:')) return value;

  // 词项链（规范 IRI Expansion 步骤 6）：@id 引用其它词项时沿链追溯。
  // 即使 value 形如 scheme:xxx（匹配绝对 IRI 正则），只要活动上下文里
  // 存在同名的普通词项，就优先用词项映射。
  // 若映射直接引用正在定义的词项自身，属于自环循环（此时词项尚未写入）。
  if (value === term && !opts.termIsImplicit) {
    throw errCycle(`词项 "${term}" 的 IRI 映射引用了自身`, { term, chain: [term, term] });
  }
  {
    const chain = [];
    let cur = value;
    for (;;) {
      if (chain.includes(cur)) {
        throw errCycle(`词项 IRI 映射存在循环: ${[...chain, cur].join(' -> ')}`, {
          term, chain: chain.concat(cur),
        });
      }
      const def = active.terms[cur];
      if (!def) break;
      chain.push(cur);
      cur = def.iri;
      if (isKeyword(cur) || cur.startsWith('_:')) return cur;
      if (isAbsoluteIRI(cur)) {
        // 词项链解析出绝对 IRI；但若起点含 ':' 且该词项 prefix=false，
        // 规范不采用此映射（穿透到 compact IRI）。
        if (chain.length === 1 && value.indexOf(':') > 0 && def.prefix === false) break;
        return cur;
      }
    }
  }

  // compact IRI 前缀（规范步骤 7）；前缀映射自身也可能是另一个 compact IRI
  const colon = value.indexOf(':');
  if (colon > 0) {
    const suffix = value.slice(colon + 1);
    let prefix = value.slice(0, colon);
    if (prefix === '_') return value;
    const seen = new Set();
    for (;;) {
      if (seen.has(prefix)) {
        throw errCycle(`compact IRI 前缀链存在循环: ${[...seen, prefix].join(' -> ')}`, {
          term, value, prefixChain: [...seen, prefix],
        });
      }
      seen.add(prefix);
      const pdef = active.terms[prefix];
      // 词项不存在，或显式 "prefix": false，前缀展开终止；
      // prefix===null（未设置）时按默认规则处理（IRI 以定界符结尾即可作前缀）。
      if (!pdef || isKeyword(pdef.iri) || pdef.prefix === false) break;
      if (isAbsoluteIRI(pdef.iri)) return pdef.iri + suffix;
      const c = pdef.iri.indexOf(':');
      if (c <= 0) break;
      prefix = pdef.iri.slice(0, c);
    }
  }

  // 词项/前缀都未命中：绝对 IRI 原样返回
  if (isAbsoluteIRI(value)) return value;

  // 相对引用。无 @id 的普通词项名（termIsImplicit）先试 @vocab；
  // 未命中再按 document-relative 回退 @base（IRI Expansion 步骤 8.7）。
  if (opts.termIsImplicit && active.vocab !== null) {
    return resolveVocab(active.vocab, value);
  }
  if (active.base) return resolveRelative(active.base, value);
  return value;
}

// ---------------------------------------------------------------------------
// 文档/属性使用时的 IRI Expansion
// ---------------------------------------------------------------------------
export function expandIri(active, value, options = {}) {
  const useVocab = options.vocab !== false;
  const useBase = options.base !== false;
  if (typeof value !== 'string') return { iri: value, mechanism: 'non-string' };
  if (isKeyword(value)) return { iri: value, mechanism: 'keyword' };

  if (useVocab) {
    const def = active.terms[value];
    // 规范 6.2：value 含 ':' 且命中的词项 prefix=false 时，不采用词项映射
    if (def && !(value.indexOf(':') > 0 && def.prefix === false)) {
      return { iri: def.iri, mechanism: 'term', def };
    }

    const colon = value.indexOf(':');
    if (colon > 0) {
      const prefix = value.slice(0, colon);
      const suffix = value.slice(colon + 1);
      if (prefix === '_') return { iri: value, mechanism: 'blank' };
      const pdef = active.terms[prefix];
      if (pdef && !isKeyword(pdef.iri) && pdef.prefix !== false) {
        return { iri: pdef.iri + suffix, mechanism: 'prefix', prefixTerm: prefix, prefixIri: pdef.iri };
      }
    }
  }

  if (isAbsoluteIRI(value)) return { iri: value, mechanism: 'absolute' };
  if (value.startsWith('_:')) return { iri: value, mechanism: 'blank' };
  if (useVocab && active.vocab != null) {
    return { iri: resolveVocab(active.vocab, value), mechanism: 'vocab', vocab: active.vocab };
  }
  if (useBase && active.base != null) {
    return { iri: resolveRelative(active.base, value), mechanism: 'base', base: active.base };
  }
  return { iri: value, mechanism: 'unresolved' };
}

// ---------------------------------------------------------------------------
// protected 兼容性（JSON-LD 1.1 Value Expansion 规则的实现）
// ---------------------------------------------------------------------------
function definitionsCompatible(existing, replacement) {
  const e = describeDef(existing);
  const r = describeDef(replacement);
  if (e.iri !== r.iri) return false;
  if (e.reverse !== r.reverse) return false;
  if (e.type !== r.type) return false;
  if (!containerEqual(existing.container, replacement.container)) return false;
  if (e.context !== r.context) return false;
  if (e.language !== r.language) return false;
  if (e.direction !== r.direction) return false;
  if (e.nest !== r.nest) return false;
  if (e.prefix !== r.prefix) return false;
  return true;
}

function containerEqual(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined || b.size === 0;
  if (b === null || b === undefined) return a.size === 0;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

const describeDef = (d) => ({
  iri: d.iri,
  reverse: d.reverse,
  type: d.type,
  container: d.container ? [...d.container].sort().join(',') : null,
  context: d.context === undefined ? null : JSON.stringify(d.context),
  language: d.language === undefined ? null : d.language,
  direction: d.direction === undefined ? null : d.direction,
  nest: d.nest,
  prefix: d.prefix,
});

const describeConflict = (existing, replacement) => {
  const e = describeDef(existing);
  const r = describeDef(replacement);
  for (const k of Object.keys(r)) {
    if (e[k] !== r[k]) return `属性 @${k === 'iri' ? 'id' : k} 不一致（${fmt(e[k])} ≠ ${fmt(r[k])}）`;
  }
  return '定义不一致';
};

const fmt = (v) => (v === null || v === undefined || v === '' ? '∅' : String(v));

function validTermForPrefix(term) {
  // 作为 compact IRI 前缀的词项不能包含空白等字符
  return !/[\s]/.test(term);
}
