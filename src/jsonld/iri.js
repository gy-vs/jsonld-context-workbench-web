// Minimal IRI helpers sufficient for JSON-LD context processing & expansion.
// No network access anywhere in this file.

const ABSOLUTE_IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function isAbsoluteIri(value) {
  return typeof value === 'string' && ABSOLUTE_IRI_RE.test(value);
}

export function isRelativeIri(value) {
  return typeof value === 'string' && !ABSOLUTE_IRI_RE.test(value);
}

// Split "prefix:suffix". Returns null when there is no colon or the colon is
// the first character (e.g. ":foo" is not a compact IRI prefix use).
export function splitCompactIri(value) {
  if (typeof value !== 'string') return null;
  const idx = value.indexOf(':');
  if (idx <= 0) return null;
  return { prefix: value.slice(0, idx), suffix: value.slice(idx + 1) };
}

// RFC 3986-ish resolution, good enough for JSON-LD document/base handling.
export function resolveIri(base, relative) {
  if (relative === '') return base;
  if (isAbsoluteIri(relative)) return normalize(relative);
  if (!base) return relative;

  if (relative.startsWith('//')) {
    const scheme = base.split(':')[0];
    return `${scheme}:${normalize(relative)}`;
  }

  const m = base.match(/^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/)?([^/?#]*)?(.*)$/);
  if (!m) return relative;
  const [, scheme, slashes, authority, rest] = m;
  const pathQueryFrag = rest || '';
  const path = pathQueryFrag.split(/[?#]/)[0];

  if (relative.startsWith('/')) {
    const auth = slashes ? `//${authority || ''}` : '';
    return normalize(`${scheme}${auth}${removeDotSegments(relative)}`);
  }

  const baseDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const auth = slashes ? `//${authority || ''}` : '';
  const merged = removeDotSegments(baseDir + relative.split(/[?#]/)[0]);
  const tail = relative.slice(relative.split(/[?#]/)[0].length); // keep ?query#frag
  return normalize(`${scheme}${auth}${merged}${tail}`);
}

function removeDotSegments(path) {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  // Preserve leading slash, collapse duplicates produced by popping.
  let joined = out.join('/');
  if (path.startsWith('/') && !joined.startsWith('/')) joined = '/' + joined;
  return joined.replace(/\/{2,}/g, '/');
}

function normalize(iri) {
  return iri;
}

// Join a vocab/base IRI with a suffix, keeping "genDelim" characters intact.
export function vocabJoin(base, suffix) {
  if (!base) return suffix;
  if (!suffix) return base;
  return base + suffix;
}
