// IRI / 关键字基础工具，遵循 JSON-LD 1.1 API 的 IRI Expansion 语义。

const KEYWORDS = new Set([
  '@base', '@container', '@context', '@default', '@direction', '@embed',
  '@explicit', '@first', '@graph', '@id', '@import', '@included', '@index',
  '@json', '@language', '@list', '@nest', '@none', '@omitDefault', '@prefix',
  '@preserve', '@propagate', '@protected', '@requireAll', '@rest', '@reverse',
  '@set', '@type', '@value', '@version', '@vocab',
]);

// 绝对 IRI 判定：scheme 后跟 ':'（与 JSON-LD 规范中的正则一致）
export const isAbsoluteIRI = (v) =>
  typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(v) && !v.startsWith('@');

export const isKeyword = (v) => typeof v === 'string' && v.startsWith('@') && KEYWORDS.has(v);

// 公网（以及一切非本地 URN 的远程协议）引用判定
export const REMOTE_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'file:']);

export const isRemoteRef = (ref) => {
  if (!isAbsoluteIRI(ref)) return false;
  try {
    const u = new URL(ref);
    return REMOTE_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
};

const GEN_DELIMS = new Set([':', '/', '?', '#', '[', ']', '@']);
export const endsWithGenDelim = (iri) => iri.length > 0 && GEN_DELIMS.has(iri[iri.length - 1]);

/**
 * 文档相对解析（@base 场景，标准 URL 语义）。
 * base 缺失时相对引用保持原样返回。
 */
export function resolveRelative(base, ref) {
  if (typeof ref !== 'string' || isAbsoluteIRI(ref)) return ref;
  if (!base) return ref;
  try {
    return new URL(ref, base).href;
  } catch {
    return base + ref;
  }
}

/**
 * 词表相对解析（@vocab 场景）。
 * JSON-LD 1.1 规定：只有 @vocab 以 '/' 或 '?' 结尾时才用 URL 基解析；
 * 其它情况（含以 '#' 结尾，如 https://ex/vocab#）一律字符串拼接。
 */
export function resolveVocab(vocab, value) {
  if (typeof value !== 'string' || isAbsoluteIRI(value)) return value;
  if (!vocab) return value;
  const delim = vocab.endsWith('/') || vocab.endsWith('?');
  if (delim) {
    try {
      return new URL(value, vocab).href;
    } catch {
      /* fallthrough 拼接 */
    }
  }
  return vocab + value;
}
