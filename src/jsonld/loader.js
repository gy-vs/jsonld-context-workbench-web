// Builds a local-only context loader bound to an immutable resource snapshot.
// A "local:<name>" reference resolves to the revision pinned in the snapshot —
// never the latest revision, so a parsing session is fully reproducible.

import { JsonLdError, ERR } from './errors.js';

/**
 * @param {Map<string, {revision: string, body: object}>} snapshot
 *        name -> pinned resource revision + parsed body
 * @param {object} [meta] extra metadata for error messages
 */
export function createSnapshotLoader(snapshot, meta = {}) {
  return function load(ref, chain) {
    const name = ref.slice('local:'.length);
    const pinned = snapshot.get(name);
    if (!pinned) {
      const known = [...snapshot.keys()];
      throw new JsonLdError(ERR.UNKNOWN_RESOURCE,
        `Unknown local context resource "local:${name}". ` +
        (known.length ? `Known resources: ${known.map(n => `"${n}"`).join(', ')}. ` : 'No resources are bound to this session. ') +
        `Public network access is disabled — import the resource into the session snapshot first.`,
        { ref, name, knownResources: known, sessionId: meta.sessionId });
    }
    if (!pinned.body || typeof pinned.body !== 'object') {
      throw new JsonLdError(ERR.INVALID_REMOTE_CONTEXT,
        `Resource "local:${name}" (revision ${pinned.revision}) is not a JSON object context`,
        { ref, revision: pinned.revision });
    }
    // Stamp the pinned revision onto the include decision just recorded by
    // the context processor, so the provenance chain is self-contained.
    const last = chain?.[chain.length - 1];
    if (last && last.kind === 'include' && last.ref === ref) {
      last.revision = pinned.revision;
    }
    // A context file may itself be { "@context": ... } or a bare context object.
    if ('@context' in pinned.body) {
      // Only accept wrapping when it is actually a document-shaped context.
      const keys = Object.keys(pinned.body);
      if (keys.length === 1) return pinned.body['@context'];
    }
    return pinned.body;
  };
}
