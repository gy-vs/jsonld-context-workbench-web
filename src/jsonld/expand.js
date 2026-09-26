// JSON-LD expansion with per-property provenance traces.
// Every expanded property records: source field path, expanded output path,
// the context decision chain active at that point, and the term resolution.

import { JsonLdError, ERR } from './errors.js';
import {
  createInitialContext, processContext, expandIri, isKeyword, looksLikeKeyword, serializeContext
} from './context.js';
import { isAbsoluteIri, splitCompactIri } from './iri.js';

const MAX_EXPANSION_DEPTH_DEFAULT = 64;

/**
 * Expand a JSON-LD document using local contexts only.
 *
 * @param {object} doc        parsed JSON-LD document (object or array)
 * @param {object} opts
 *   loader        (ref, chain) => context object   (required)
 *   baseUrl       document base IRI (optional)
 *   maxDepth      max expansion depth (default 64)
 *   maxContextDepth max @context nesting depth (default 32)
 * @returns {{ expanded: Array, traces: Array, warnings: Array, decisionChain: Array }}
 */
export function expandDocument(doc, opts) {
  const {
    loader,
    baseUrl = null,
    maxDepth = MAX_EXPANSION_DEPTH_DEFAULT,
    maxContextDepth = 32
  } = opts;
  if (!loader) throw new JsonLdError(ERR.VALIDATION, 'A local context loader is required');

  const decisionChain = [];
  let active = createInitialContext();
  if (baseUrl) active.base = baseUrl;

  const traces = [];
  const warnings = active.warnings;

  // Document-level @context
  let element = doc;
  if (doc && typeof doc === 'object' && !Array.isArray(doc) && '@context' in doc) {
    active = processContext(active, doc['@context'], {
      loader, chain: decisionChain, maxDepth: maxContextDepth, baseUrl
    });
    element = { ...doc };
    delete element['@context'];
  }

  const expanded = expandElement(active, null, element, {
    loader, traces, decisionChain, chainStack: [decisionChain],
    maxDepth, maxContextDepth,
    depth: 0, sourcePath: '$', outPath: '$', warnings
  });

  const result = expanded === null ? [] : (Array.isArray(expanded) ? expanded : [expanded]);

  return {
    expanded: result,
    traces,
    warnings,
    decisionChain,
    finalContext: serializeContext(active)
  };
}

function expandElement(active, activeProperty, element, env) {
  const { maxDepth, depth } = env;
  if (depth > maxDepth) {
    throw new JsonLdError(ERR.PROCESSING_DEPTH_EXCEEDED,
      `Maximum expansion depth (${maxDepth}) exceeded at ${env.sourcePath}`,
      { depth, maxDepth, path: env.sourcePath });
  }

  if (element === null || element === undefined) return null;

  // scalars
  if (typeof element !== 'object') {
    if (activeProperty === null || activeProperty === '@graph') {
      drop(env, env.sourcePath, 'scalar without active property');
      return null;
    }
    return expandValue(active, activeProperty, element, env);
  }

  // arrays
  if (Array.isArray(element)) {
    const out = [];
    element.forEach((item, i) => {
      const expanded = expandElement(active, activeProperty, item, {
        ...env, depth: depth + 1,
        sourcePath: `${env.sourcePath}[${i}]`,
        outPath: `${env.outPath}[${i}]`
      });
      if (expanded === null) return;
      if (Array.isArray(expanded) && containerOf(active, activeProperty)?.includes('@list')) {
        env.warnings.push({ code: 'list of lists', message: `List of lists at ${env.sourcePath}[${i}] is not representable; item dropped` });
        return;
      }
      if (Array.isArray(expanded)) out.push(...expanded);
      else out.push(expanded);
    });
    return out;
  }

  // objects ---------------------------------------------------------------
  let ctx = active;
  let scopedChain = null;

  // scoped context
  if ('@context' in element) {
    scopedChain = [];
    ctx = processContext(active, element['@context'], {
      loader: env.loader, chain: scopedChain, maxDepth: env.maxContextDepth
    });
  }
  // Chain visible to everything expanded inside this node: the document-level
  // chain plus every scoped chain on the path from the root to this node.
  const nodeStack = scopedChain ? [...env.chainStack, scopedChain] : env.chainStack;
  const nodeEnv = { ...env, chainStack: nodeStack };

  const keys = Object.keys(element).filter(k => k !== '@context');
  const node = {};

  // pass 1: @id / @type so sibling properties see them (not strictly needed
  // for expansion output but keeps traces ordered naturally)
  const orderedKeys = [
    ...keys.filter(k => expandIri(ctx, k, { vocab: true }) === '@id'),
    ...keys.filter(k => expandIri(ctx, k, { vocab: true }) === '@type'),
    ...keys.filter(k => {
      const e = expandIri(ctx, k, { vocab: true });
      return e !== '@id' && e !== '@type';
    })
  ];

  for (const key of orderedKeys) {
    const value = element[key];
    const expandedProperty = expandIri(ctx, key, { vocab: true, documentRelative: false });
    const keyPath = `${env.sourcePath}.${key}`;

    if (expandedProperty === null || expandedProperty === undefined) {
      drop(nodeEnv, keyPath, `property "${key}" has no IRI mapping (no term definition and no @vocab)`);
      continue;
    }
    if (!isKeyword(expandedProperty) && !expandedProperty.includes(':')) {
      // JSON-LD expansion: free-floating values whose expanded property is
      // neither a keyword nor contains a colon are dropped.
      drop(nodeEnv, keyPath, `property "${key}" does not expand to an IRI (no term, no @vocab)`);
      continue;
    }
    if (!isKeyword(expandedProperty) && looksLikeKeyword(expandedProperty)) {
      drop(nodeEnv, keyPath, `"${key}" expands to "${expandedProperty}" which looks like a keyword`);
      continue;
    }

    if (expandedProperty === '@id') {
      if (typeof value !== 'string') {
        throw new JsonLdError(ERR.INVALID_IRI_MAPPING, `@id value must be a string at ${keyPath}`);
      }
      const resolved = expandIri(ctx, value, { documentRelative: true });
      node['@id'] = resolved;
      emitTrace(nodeEnv, {
        kind: 'node-id', sourcePath: keyPath, outPath: `${env.outPath}.@id`,
        sourceKey: key, expandedIri: '@id', value, resolved,
        decisionChain: snapshotChain(nodeEnv)
      });
      continue;
    }

    if (expandedProperty === '@type') {
      const values = Array.isArray(value) ? value : [value];
      const resolved = values.map(v => {
        if (typeof v !== 'string') {
          throw new JsonLdError(ERR.INVALID_TYPE_MAPPING, `@type values must be strings at ${keyPath}`);
        }
        return expandIri(ctx, v, { vocab: true, documentRelative: true });
      });
      node['@type'] = resolved.length === 1 && !Array.isArray(value) ? [resolved[0]] : resolved;
      emitTrace(nodeEnv, {
        kind: 'node-type', sourcePath: keyPath, outPath: `${env.outPath}.@type`,
        sourceKey: key, expandedIri: '@type', value, resolved: node['@type'],
        decisionChain: snapshotChain(nodeEnv)
      });
      continue;
    }

    if (expandedProperty === '@value') {
      node['@value'] = value;
      continue;
    }
    if (expandedProperty === '@language') {
      if (typeof value !== 'string') {
        throw new JsonLdError(ERR.INVALID_LANGUAGE_MAPPING, `@language must be a string at ${keyPath}`);
      }
      node['@language'] = value.toLowerCase();
      continue;
    }
    if (expandedProperty === '@index') {
      node['@index'] = String(value);
      continue;
    }
    if (expandedProperty === '@list') {
      const expanded = expandElement(ctx, key, value, {
        ...nodeEnv, depth: nodeEnv.depth + 1, sourcePath: keyPath, outPath: `${env.outPath}.@list`
      });
      node['@list'] = Array.isArray(expanded) ? expanded : (expanded === null ? [] : [expanded]);
      continue;
    }
    if (expandedProperty === '@graph') {
      const expanded = expandElement(ctx, key, value, {
        ...nodeEnv, depth: nodeEnv.depth + 1, sourcePath: keyPath, outPath: `${env.outPath}.@graph`
      });
      node['@graph'] = Array.isArray(expanded) ? expanded : (expanded === null ? [] : [expanded]);
      continue;
    }
    if (isKeyword(expandedProperty)) {
      // @set, @reverse, @included etc. — pass through with expansion of content
      const expanded = expandElement(ctx, key, value, {
        ...nodeEnv, depth: nodeEnv.depth + 1, sourcePath: keyPath, outPath: `${env.outPath}.${expandedProperty}`
      });
      if (expanded !== null) node[expandedProperty] = expanded;
      continue;
    }

    // regular property
    const expandedValue = expandPropertyValue(ctx, key, expandedProperty, value, {
      ...nodeEnv, depth: nodeEnv.depth + 1, sourcePath: keyPath
    });
    if (expandedValue === null) continue;
    if (!node[expandedProperty]) node[expandedProperty] = [];
    const items = Array.isArray(expandedValue) ? expandedValue : [expandedValue];
    node[expandedProperty].push(...items);

    emitTrace(nodeEnv, {
      kind: 'property',
      sourcePath: keyPath,
      outPath: `${env.outPath}.${expandedProperty}`,
      sourceKey: key,
      expandedIri: expandedProperty,
      term: termSnapshot(ctx, key),
      container: containerOf(ctx, key) ?? undefined,
      decisionChain: snapshotChain(nodeEnv)
    });
  }

  // value object fix-ups
  if ('@value' in node) {
    const allowed = ['@value', '@language', '@type', '@index'];
    for (const k of Object.keys(node)) {
      if (!allowed.includes(k)) {
        throw new JsonLdError(ERR.INVALID_VALUE_OBJECT ?? ERR.VALIDATION,
          `Value object at ${env.sourcePath} may not contain "${k}" alongside @value`);
      }
    }
    if (node['@value'] === null) return null;
  }

  // @type on value objects must not be an array of one for JSON-LD 1.1 output;
  // keep array form for node objects (spec) — leave as-is.

  if (Object.keys(node).length === 0) return null;
  if (Object.keys(node).length === 1 && ('@id' in node || '@index' in node) && activeProperty !== null) {
    // bare reference node — still valid, keep
  }
  return node;
}

function expandPropertyValue(ctx, key, expandedProperty, value, env) {
  const container = containerOf(ctx, key) ?? [];
  const termDef = ctx.terms.get(key);
  const keyPath = env.sourcePath;

  // @list container
  if (container.includes('@list')) {
    const expanded = expandElement(ctx, key, value, {
      ...env, outPath: `${env.outPath}.${expandedProperty}[].@list`
    });
    const list = Array.isArray(expanded) ? expanded : (expanded === null ? [] : [expanded]);
    return { '@list': list };
  }

  // @language map
  if (container.includes('@language') && value && typeof value === 'object' && !Array.isArray(value)) {
    const out = [];
    for (const [lang, v] of Object.entries(value)) {
      const values = Array.isArray(v) ? v : [v];
      for (const item of values) {
        if (typeof item !== 'string') {
          throw new JsonLdError(ERR.INVALID_LANGUAGE_MAPPING,
            `Language map values must be strings at ${keyPath}.${lang}`);
        }
        out.push({ '@value': item, '@language': lang.toLowerCase() });
      }
    }
    return out;
  }

  // @index map
  if (container.includes('@index') && value && typeof value === 'object' && !Array.isArray(value)) {
    const out = [];
    for (const [index, v] of Object.entries(value)) {
      const expanded = expandElement(ctx, key, v, {
        ...env, depth: env.depth + 1,
        sourcePath: `${keyPath}.${index}`,
        outPath: `${env.outPath}.${expandedProperty}[]`
      });
      const items = Array.isArray(expanded) ? expanded : (expanded === null ? [] : [expanded]);
      for (const item of items) {
        if (typeof item === 'object' && item !== null && !('@index' in item) && index !== '@none') {
          item['@index'] = index;
        }
        out.push(item);
      }
    }
    return out;
  }

  // @id map
  if (container.includes('@id') && value && typeof value === 'object' && !Array.isArray(value)) {
    const out = [];
    for (const [idKey, v] of Object.entries(value)) {
      const expanded = expandElement(ctx, key, v, {
        ...env, depth: env.depth + 1,
        sourcePath: `${keyPath}.${idKey}`,
        outPath: `${env.outPath}.${expandedProperty}[]`
      });
      const items = Array.isArray(expanded) ? expanded : (expanded === null ? [] : [expanded]);
      for (const item of items) {
        if (typeof item === 'object' && item !== null && !('@id' in item) && idKey !== '@none') {
          item['@id'] = expandIri(ctx, idKey, { documentRelative: true });
        }
        out.push(item);
      }
    }
    return out;
  }

  // @type map
  if (container.includes('@type') && value && typeof value === 'object' && !Array.isArray(value)) {
    const out = [];
    for (const [typeKey, v] of Object.entries(value)) {
      const expanded = expandElement(ctx, key, v, {
        ...env, depth: env.depth + 1,
        sourcePath: `${keyPath}.${typeKey}`,
        outPath: `${env.outPath}.${expandedProperty}[]`
      });
      const items = Array.isArray(expanded) ? expanded : (expanded === null ? [] : [expanded]);
      for (const item of items) {
        if (typeof item === 'object' && item !== null && typeKey !== '@none') {
          const t = expandIri(ctx, typeKey, { vocab: true, documentRelative: true });
          item['@type'] = [...(item['@type'] ?? []), t];
        }
        out.push(item);
      }
    }
    return out;
  }

  // plain expansion
  const expanded = expandElement(ctx, key, value, {
    ...env, outPath: `${env.outPath}.${expandedProperty}[]`
  });
  if (expanded === null) return null;

  // apply term coercion (@type on the term definition)
  const coerce = termDef?.typeMapping ?? null;
  const items = Array.isArray(expanded) ? expanded : [expanded];
  return items.map(item => applyCoercion(item, coerce, ctx));
}

function applyCoercion(item, coerce, ctx) {
  if (!coerce) return item;
  if (coerce === '@id') {
    if (typeof item === 'string') return { '@id': expandIri(ctx, item, { documentRelative: true }) };
    return item;
  }
  if (coerce === '@vocab') {
    if (typeof item === 'string') return { '@id': expandIri(ctx, item, { vocab: true, documentRelative: true }) };
    return item;
  }
  if (coerce === '@json') return item;
  // typed literal coercion
  if (typeof item === 'object' && item !== null && '@value' in item) {
    if (!('@type' in item)) return { ...item, '@type': coerce };
    return item;
  }
  if (typeof item !== 'object') {
    return { '@value': item, '@type': coerce };
  }
  return item;
}

function expandValue(ctx, activeProperty, value, env) {
  const def = activeProperty ? ctx.terms.get(activeProperty) : null;
  if (def?.typeMapping === '@id' && typeof value === 'string') {
    return { '@id': expandIri(ctx, value, { documentRelative: true }) };
  }
  if (def?.typeMapping === '@vocab' && typeof value === 'string') {
    return { '@id': expandIri(ctx, value, { vocab: true, documentRelative: true }) };
  }
  if (def?.typeMapping && def.typeMapping !== '@json') {
    return { '@value': value, '@type': def.typeMapping };
  }
  if (typeof value === 'string') {
    const lang = def?.language ?? ctx.language;
    if (lang) return { '@value': value, '@language': lang };
  }
  return { '@value': value };
}

// ---------------------------------------------------------------------------

function containerOf(ctx, property) {
  if (!property) return null;
  return ctx.terms.get(property)?.container ?? null;
}

function termSnapshot(ctx, key) {
  const def = ctx.terms.get(key);
  if (!def) {
    // resolved via @vocab / compact IRI / absolute IRI rather than a term
    const split = splitCompactIri(key);
    if (split && ctx.terms.get(split.prefix)) {
      return { via: 'compact-iri', prefix: split.prefix, prefixId: ctx.terms.get(split.prefix).id };
    }
    if (isAbsoluteIri(key)) return { via: 'absolute-iri' };
    if (ctx.vocab) return { via: '@vocab', vocab: ctx.vocab };
    return null;
  }
  return {
    via: 'term',
    id: def.id,
    protected: def.protected || undefined,
    history: def.history && def.history.length ? def.history : undefined
  };
}

function snapshotChain(env) {
  // Full decision chain visible at this node: document-level entries plus the
  // scoped chains of every ancestor node that declared its own @context.
  return env.chainStack.flat();
}

function emitTrace(env, trace) {
  env.traces.push(trace);
}

function drop(env, sourcePath, reason) {
  env.warnings.push({ code: 'dropped', message: `Dropped ${sourcePath}: ${reason}` });
  env.traces.push({
    kind: 'dropped',
    sourcePath,
    outPath: null,
    reason,
    decisionChain: snapshotChain(env)
  });
}
