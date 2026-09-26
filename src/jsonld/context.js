// JSON-LD 1.1 context processing with full provenance ("decision chain") capture.
// Local contexts only — remote http(s) contexts are rejected by the loader.

import { JsonLdError, ERR } from './errors.js';
import { isAbsoluteIri, isRelativeIri, splitCompactIri, resolveIri, vocabJoin } from './iri.js';

export const KEYWORDS = [
  '@base', '@container', '@context', '@direction', '@graph', '@id', '@import',
  '@included', '@index', '@json', '@language', '@list', '@nest', '@none',
  '@prefix', '@propagate', '@protected', '@reverse', '@set', '@type',
  '@value', '@version', '@vocab'
];

const CONTAINER_KEYWORDS = ['@list', '@set', '@index', '@language', '@id', '@type', '@graph'];

export function isKeyword(value) {
  return typeof value === 'string' && KEYWORDS.includes(value);
}

export function looksLikeKeyword(value) {
  return typeof value === 'string' && value.startsWith('@');
}

export function createInitialContext() {
  return {
    base: null,          // absolute IRI string or null
    vocab: null,         // IRI string or null
    language: null,      // default language or null
    terms: new Map(),    // term -> term definition
    keywordAliases: new Map(), // keyword -> [terms aliasing it]
    warnings: []
  };
}

function warn(ctx, code, message) {
  ctx.warnings.push({ code, message });
}

function cloneTermDef(def) {
  if (!def) return undefined;
  return {
    ...def,
    container: def.container ? [...def.container] : null,
    typeMapping: def.typeMapping ?? null,
    history: def.history ? [...def.history] : []
  };
}

export function cloneContext(ctx) {
  const terms = new Map();
  for (const [k, v] of ctx.terms) terms.set(k, cloneTermDef(v));
  return {
    base: ctx.base,
    vocab: ctx.vocab,
    language: ctx.language,
    terms,
    keywordAliases: new Map([...ctx.keywordAliases].map(([k, v]) => [k, [...v]])),
    warnings: ctx.warnings
  };
}

function rebuildAliases(ctx) {
  ctx.keywordAliases = new Map();
  for (const [term, def] of ctx.terms) {
    if (def && def.id && isKeyword(def.id)) {
      if (!ctx.keywordAliases.has(def.id)) ctx.keywordAliases.set(def.id, []);
      ctx.keywordAliases.get(def.id).push(term);
    }
  }
}

// ---------------------------------------------------------------------------
// Context processing (JSON-LD 1.1 §5.1, adapted: synchronous, local-only)
// ---------------------------------------------------------------------------

/**
 * @param {object} active   active context (mutated clone is returned)
 * @param {*} localContext  null | string (local: ref) | object | array
 * @param {object} opts
 *   loader       required — (ref, chain) => context object
 *   chain        provenance entries accumulated so far (array, appended to)
 *   remoteContexts cycle-detection set of local: refs
 *   depth        current nesting depth
 *   maxDepth     max nesting depth (default 32)
 *   baseUrl      document base for resolving @base
 *   propagate    whether this context propagates (nested scoped contexts don't)
 */
export function processContext(active, localContext, opts) {
  const {
    loader,
    chain = [],
    remoteContexts = new Set(),
    depth = 0,
    maxDepth = 32,
    baseUrl = null,
    propagate = true
  } = opts;

  if (depth > maxDepth) {
    throw new JsonLdError(ERR.CONTEXT_OVERFLOW,
      `Maximum context nesting depth (${maxDepth}) exceeded`, { depth, maxDepth });
  }

  let result = cloneContext(active);
  if (baseUrl && !result.base) result.base = baseUrl;

  const items = Array.isArray(localContext) ? localContext : [localContext];

  for (const item of items) {
    // 5.2 null — reset to initial context. Protected terms survive (JSON-LD 1.1).
    if (item === null) {
      const protectedTerms = new Map();
      for (const [term, def] of result.terms) {
        if (def && def.protected) protectedTerms.set(term, def);
      }
      const prevWarnings = result.warnings;
      result = createInitialContext();
      if (baseUrl) result.base = baseUrl;
      result.warnings = prevWarnings;
      for (const [term, def] of protectedTerms) result.terms.set(term, def);
      rebuildAliases(result);
      chain.push({
        kind: 'reset',
        keptProtected: [...protectedTerms.keys()],
        note: 'context reset to initial context (null entry); protected terms retained'
      });
      continue;
    }

    // 5.3 string — local context reference only. Public network is forbidden.
    if (typeof item === 'string') {
      const ref = item;
      if (/^https?:\/\//i.test(ref)) {
        throw new JsonLdError(ERR.LOADING_REMOTE_CONTEXT_FAILED,
          `Remote context "${ref}" refused: this workbench never accesses the public network. ` +
          `Save the context as a local resource and reference it as "local:<name>".`,
          { ref });
      }
      if (!ref.startsWith('local:')) {
        throw new JsonLdError(ERR.LOADING_REMOTE_CONTEXT_FAILED,
          `Context reference "${ref}" is not a local resource. Use "local:<name>" — ` +
          `only immutable local revisions are allowed.`,
          { ref });
      }
      if (remoteContexts.has(ref)) {
        throw new JsonLdError(ERR.CYCLIC_IRI_MAPPING,
          `Cyclic context reference detected: ${[...remoteContexts, ref].join(' -> ')}`,
          { cycle: [...remoteContexts, ref] });
      }
      const entry = { kind: 'include', ref };
      chain.push(entry);
      const resolved = loader(ref, chain); // throws UNKNOWN_RESOURCE when missing
      const nextRemote = new Set(remoteContexts);
      nextRemote.add(ref);
      result = processContext(result, resolved, {
        loader, chain, remoteContexts: nextRemote, depth: depth + 1, maxDepth,
        baseUrl, propagate
      });
      continue;
    }

    if (typeof item !== 'object' || Array.isArray(item)) {
      throw new JsonLdError(ERR.INVALID_CONTEXT_ENTRY,
        `Invalid @context entry: expected null, string or object, got ${JSON.stringify(item)}`);
    }

    // 5.7 context object
    result = applyContextObject(result, item, { loader, chain, remoteContexts, depth, maxDepth, baseUrl, propagate });
  }

  return result;
}

function applyContextObject(result, ctxObj, opts) {
  const { loader, chain, remoteContexts, depth, maxDepth, baseUrl } = opts;

  // Nested include: a context object may itself carry an "@context" entry
  // referencing/embedding another context (file-to-file nesting). Process it
  // first so the included definitions form the base layer.
  if ('@context' in ctxObj) {
    const nested = ctxObj['@context'];
    result = processContext(result, nested, {
      loader, chain, remoteContexts: new Set(remoteContexts),
      depth: depth + 1, maxDepth, baseUrl, propagate: opts.propagate
    });
  }

  // --- @version ---
  if ('@version' in ctxObj) {
    if (ctxObj['@version'] !== 1.1) {
      throw new JsonLdError(ERR.VALIDATION, 'Only JSON-LD 1.1 contexts are supported (@version must be 1.1)');
    }
    chain.push({ kind: 'version', value: 1.1 });
  }

  // --- @base ---
  if ('@base' in ctxObj) {
    const value = ctxObj['@base'];
    if (value === null) {
      result.base = null;
      chain.push({ kind: 'base', value: null, note: 'base cleared' });
    } else if (typeof value === 'string') {
      if (isAbsoluteIri(value)) {
        result.base = value;
        chain.push({ kind: 'base', value, resolved: value });
      } else if (isRelativeIri(value)) {
        if (!result.base) {
          throw new JsonLdError(ERR.INVALID_BASE_IRI,
            `Cannot resolve relative @base "${value}" without an existing base IRI`);
        }
        const resolved = resolveIri(result.base, value);
        chain.push({ kind: 'base', value, resolved, note: `relative to ${result.base}` });
        result.base = resolved;
      } else {
        throw new JsonLdError(ERR.INVALID_BASE_IRI, `Invalid @base value: ${JSON.stringify(value)}`);
      }
    } else {
      throw new JsonLdError(ERR.INVALID_BASE_IRI, `Invalid @base value: ${JSON.stringify(value)}`);
    }
  }

  // --- @vocab ---
  if ('@vocab' in ctxObj) {
    const value = ctxObj['@vocab'];
    if (value === null) {
      result.vocab = null;
      chain.push({ kind: 'vocab', value: null, note: 'vocab mapping removed' });
    } else if (typeof value === 'string' && (isAbsoluteIri(value) || looksLikeKeyword(value))) {
      result.vocab = value;
      chain.push({ kind: 'vocab', value });
    } else {
      throw new JsonLdError(ERR.INVALID_VOCAB_MAPPING,
        `@vocab must be an absolute IRI or null, got ${JSON.stringify(value)}`);
    }
  }

  // --- @language ---
  if ('@language' in ctxObj) {
    const value = ctxObj['@language'];
    if (value !== null && typeof value !== 'string') {
      throw new JsonLdError(ERR.INVALID_LANGUAGE_MAPPING, `Invalid @language: ${JSON.stringify(value)}`);
    }
    result.language = value === null ? null : value.toLowerCase();
    chain.push({ kind: 'language', value: result.language });
  }

  // --- @propagate is advisory here; nested scoped contexts are always applied
  //     to the node being expanded and do not leak to siblings regardless.

  // --- term definitions (two passes: create, then populate) ---
  const defined = new Map(); // term -> boolean (true = fully defined)
  for (const key of Object.keys(ctxObj)) {
    if (key.startsWith('@')) continue; // keyword entries handled above
    createTermDefinition(result, ctxObj, key, defined, chain, { loader, remoteContexts, depth, maxDepth, baseUrl });
  }
  rebuildAliases(result);
  return result;
}

// ---------------------------------------------------------------------------
// Term definitions (JSON-LD 1.1 §5.3 create term definition)
// ---------------------------------------------------------------------------

function createTermDefinition(result, ctxObj, term, defined, chain, env) {
  if (defined.has(term)) {
    if (defined.get(term)) return;
    throw new JsonLdError(ERR.CYCLIC_IRI_MAPPING, `Cyclic term definition involving "${term}"`, { term });
  }
  defined.set(term, false);

  const value = ctxObj[term];
  if (term === '@type' && !(value && typeof value === 'object')) {
    // handled as keyword entry elsewhere; ignore
    defined.set(term, true);
    return;
  }

  const previousDef = result.terms.has(term) ? cloneTermDef(result.terms.get(term)) : undefined;

  // null removes the term
  if (value === null) {
    if (previousDef && previousDef.protected) {
      throw new JsonLdError(ERR.INVALID_PROTECTED_TERM_REDEFINITION,
        `Protected term "${term}" cannot be removed (set to null)`, { term });
    }
    result.terms.delete(term);
    chain.push({ kind: 'term-cleared', term, note: 'term mapping removed' });
    defined.set(term, true);
    return;
  }

  let def;
  if (typeof value === 'string') {
    def = { '@id': value };
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    def = { ...value };
  } else {
    throw new JsonLdError(ERR.INVALID_TERM_DEFINITION,
      `Term "${term}" must be defined as a string, object or null`, { term });
  }

  const isProtected = def['@protected'] === true;

  // Protected terms: any redefinition that is not byte-identical fails.
  if (previousDef && previousDef.protected) {
    const sameId = (def['@id'] ?? term) === (previousDef.id ?? term);
    const sameContainer = JSON.stringify(normalizeContainer(def['@container'])) ===
      JSON.stringify(previousDef.container);
    const sameType = (def['@type'] ?? null) === (previousDef.typeMapping ?? null);
    if (!(sameId && sameContainer && sameType)) {
      throw new JsonLdError(ERR.INVALID_PROTECTED_TERM_REDEFINITION,
        `Protected term "${term}" cannot be redefined with a different mapping ` +
        `(attempted @id: ${JSON.stringify(def['@id'] ?? term)}, ` +
        `current: ${JSON.stringify(previousDef.id ?? term)})`,
        { term, attempted: def['@id'] ?? term, current: previousDef.id ?? term });
    }
    // Identical redefinition is allowed and is a no-op.
    defined.set(term, true);
    return;
  }

  // --- @id ---
  let id;
  if ('@id' in def) {
    const raw = def['@id'];
    if (raw === null) {
      id = null; // term will never expand (property is dropped)
    } else if (typeof raw !== 'string') {
      throw new JsonLdError(ERR.INVALID_IRI_MAPPING, `@id of "${term}" must be a string or null`);
    } else if (isKeyword(raw)) {
      id = raw;
      chain.push({ kind: 'keyword-alias', term, keyword: raw, note: `"${term}" is now an alias of ${raw}` });
    } else if (looksLikeKeyword(raw)) {
      throw new JsonLdError(ERR.KEYWORD_REDEFINITION ?? ERR.INVALID_IRI_MAPPING,
        `"${raw}" looks like a keyword but is not defined in JSON-LD 1.1`, { term, id: raw });
    } else {
      id = expandIri(result, raw, { vocab: true, documentRelative: false, defined, ctxObj, chain, env });
    }
  } else {
    // No @id: compact IRI / absolute IRI term maps to itself, otherwise vocab-relative.
    const split = splitCompactIri(term);
    if (isAbsoluteIri(term)) {
      id = term;
    } else if (split && result.terms.get(split.prefix)?.id) {
      id = expandIri(result, term, { vocab: true, documentRelative: false, defined, ctxObj, chain, env });
    } else if (result.vocab !== null && result.vocab !== undefined) {
      id = vocabJoin(result.vocab, term);
    } else {
      throw new JsonLdError(ERR.INVALID_IRI_MAPPING,
        `Term "${term}" has no @id and no @vocab is active — it cannot be expanded`, { term });
    }
  }

  // --- @reverse ---
  if ('@reverse' in def) {
    throw new JsonLdError(ERR.INVALID_IRI_MAPPING,
      `@reverse terms are not supported by this workbench (term "${term}")`, { term });
  }

  // --- @container ---
  const container = normalizeContainer(def['@container']);
  if (container) {
    for (const c of container) {
      if (!CONTAINER_KEYWORDS.includes(c)) {
        throw new JsonLdError(ERR.INVALID_CONTAINER_MAPPING,
          `Invalid @container value "${c}" for term "${term}"`, { term, container: c });
      }
    }
    if (container.includes('@list') && container.length > 1) {
      throw new JsonLdError(ERR.INVALID_CONTAINER_MAPPING,
        `@list cannot be combined with other container values (term "${term}")`, { term });
    }
  }

  // --- @type ---
  let typeMapping = null;
  if ('@type' in def) {
    const t = def['@type'];
    if (typeof t !== 'string') {
      throw new JsonLdError(ERR.INVALID_TYPE_MAPPING, `@type of "${term}" must be a string`);
    }
    if (t === '@id' || t === '@vocab') {
      typeMapping = t;
    } else if (t === '@json') {
      typeMapping = t;
    } else {
      typeMapping = expandIri(result, t, { vocab: true, documentRelative: false, defined, ctxObj, chain, env });
    }
  }

  // --- @language ---
  let language = null;
  if ('@language' in def) {
    if (def['@language'] !== null && typeof def['@language'] !== 'string') {
      throw new JsonLdError(ERR.INVALID_LANGUAGE_MAPPING, `Invalid @language for term "${term}"`);
    }
    language = def['@language'] === null ? null : def['@language'].toLowerCase();
  }

  // --- @prefix ---
  const prefix = def['@prefix'] === true;

  const history = previousDef && previousDef.id !== undefined
    ? [...(previousDef.history || []), snapshotTerm(previousDef)]
    : (previousDef ? [snapshotTerm(previousDef)] : []);

  const termDef = {
    id,
    container,
    typeMapping,
    language,
    prefix,
    protected: isProtected,
    reverse: false,
    history,
    definedIn: chain.length ? chain[chain.length - 1]?.ref ?? null : null
  };

  result.terms.set(term, termDef);

  chain.push({
    kind: previousDef ? 'term-override' : 'term',
    term,
    id,
    container: container ?? undefined,
    typeMapping: typeMapping ?? undefined,
    language: language ?? undefined,
    protected: isProtected || undefined,
    previous: previousDef ? snapshotTerm(previousDef) : undefined,
    note: previousDef
      ? `term "${term}" overrides earlier mapping ${JSON.stringify(previousDef.id)} -> ${JSON.stringify(id)}`
      : undefined
  });

  defined.set(term, true);
}

function snapshotTerm(def) {
  return {
    id: def.id ?? null,
    container: def.container ? [...def.container] : null,
    typeMapping: def.typeMapping ?? null,
    language: def.language ?? null,
    protected: !!def.protected
  };
}

function normalizeContainer(value) {
  if (value === undefined || value === null) return null;
  const arr = Array.isArray(value) ? value : [value];
  return arr.length ? [...arr] : null;
}

// ---------------------------------------------------------------------------
// IRI expansion (JSON-LD 1.1 §5.2)
// ---------------------------------------------------------------------------

/**
 * Expand a value to an absolute IRI (or keyword).
 * options: { vocab, documentRelative, defined, ctxObj, chain, env }
 */
export function expandIri(ctx, value, options = {}) {
  const { vocab = false, documentRelative = false, defined = null, ctxObj = null, chain = null, env = null } = options;

  if (value === null || value === undefined) return null;
  if (isKeyword(value)) return value;

  // 1. term mapping
  if (vocab && ctx.terms.has(value)) {
    const def = ctx.terms.get(value);
    if (def === null || def === undefined) return null;
    return def.id;
  }

  // 2. compact IRI / absolute IRI / blank node
  const split = splitCompactIri(value);
  if (split) {
    const { prefix, suffix } = split;
    if (prefix === '_' || suffix.startsWith('//')) {
      // Blank node identifier ("_:b0") or an already-absolute IRI
      // ("https://…") — per the spec, return as-is and never touch @vocab.
      return value;
    }
    // defining a prefix on the fly (rare in this workbench) — resolve via definitions
    if (ctxObj && defined && ctxObj[prefix] !== undefined && !ctx.terms.has(prefix)) {
      createTermDefinition(ctx, ctxObj, prefix, defined, chain ?? [], env ?? {});
    }
    const def = ctx.terms.get(prefix);
    if (def && typeof def.id === 'string') {
      // JSON-LD 1.1 IRI expansion: a prefix is joined at a property/type
      // position only when the prefix term declares @prefix: true; at a
      // value position (neither vocab nor document-relative) an IRI mapping
      // alone is sufficient.
      if (def.prefix === true || (!vocab && !documentRelative)) {
        return vocabJoin(def.id, suffix);
      }
    }
  }

  // 3. vocab
  if (vocab && ctx.vocab !== null && ctx.vocab !== undefined) {
    return vocabJoin(ctx.vocab, value);
  }

  // 4. document-relative
  if (documentRelative) {
    if (isAbsoluteIri(value)) return value;
    if (ctx.base) return resolveIri(ctx.base, value);
    return value;
  }

  return value;
}

// Serialize an active context for the UI (decision-chain view).
export function serializeContext(ctx) {
  const terms = {};
  for (const [term, def] of [...ctx.terms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    terms[term] = {
      id: def.id ?? null,
      container: def.container ?? undefined,
      typeMapping: def.typeMapping ?? undefined,
      language: def.language ?? undefined,
      protected: def.protected || undefined,
      prefix: def.prefix || undefined,
      history: def.history && def.history.length ? def.history : undefined
    };
  }
  return {
    '@base': ctx.base,
    '@vocab': ctx.vocab,
    '@language': ctx.language,
    terms
  };
}
