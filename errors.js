// 引擎统一错误类型。code 会原样透传到 API 响应，便于前端区分处理。
export class JsonLdError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'JsonLdError';
    this.code = code;
    this.details = details;
  }
}

export const errInvalidIRI = (msg, d) => new JsonLdError('invalid-iri', msg, d);
export const errInvalidContext = (msg, d) => new JsonLdError('invalid-context', msg, d);
export const errInvalidTerm = (msg, d) => new JsonLdError('invalid-term-definition', msg, d);
export const errProtected = (msg, d) => new JsonLdError('invalid-protected-term-redefinition', msg, d);
export const errCycle = (msg, d) => new JsonLdError('context-cycle', msg, d);
export const errDepth = (msg, d) => new JsonLdError('context-depth-overflow', msg, d);
export const errDocDepth = (msg, d) => new JsonLdError('document-depth-overflow', msg, d);
export const errUnknownResource = (msg, d) => new JsonLdError('unknown-resource', msg, d);
export const errRemote = (msg, d) => new JsonLdError('remote-context-forbidden', msg, d);
export const errConflict = (msg, d) => new JsonLdError('revision-conflict', msg, d);
export const errSession = (msg, d) => new JsonLdError('session-stale', msg, d);
