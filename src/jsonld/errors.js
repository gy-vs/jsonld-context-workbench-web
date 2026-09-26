// Structured error used across parser, store and HTTP layer.
export class JsonLdError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'JsonLdError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const ERR = {
  LOADING_REMOTE_CONTEXT_FAILED: 'loading remote context failed',
  CONTEXT_OVERFLOW: 'context overflow',
  CYCLIC_IRI_MAPPING: 'cyclic IRI mapping',
  INVALID_IRI_MAPPING: 'invalid IRI mapping',
  INVALID_KEYWORD_REDEFINITION: 'keyword redefinition',
  INVALID_TERM_DEFINITION: 'invalid term definition',
  INVALID_PROTECTED_TERM_REDEFINITION: 'protected term redefinition',
  INVALID_BASE_IRI: 'invalid base IRI',
  INVALID_VOCAB_MAPPING: 'invalid vocab mapping',
  INVALID_CONTAINER_MAPPING: 'invalid container mapping',
  INVALID_TYPE_MAPPING: 'invalid type mapping',
  INVALID_LANGUAGE_MAPPING: 'invalid language mapping',
  INVALID_CONTEXT_ENTRY: 'invalid context entry',
  INVALID_REMOTE_CONTEXT: 'invalid remote context',
  PROCESSING_DEPTH_EXCEEDED: 'processing depth exceeded',
  UNKNOWN_RESOURCE: 'unknown resource',
  REVISION_CONFLICT: 'revision conflict',
  VALIDATION: 'validation error',
  NOT_FOUND: 'not found'
};
