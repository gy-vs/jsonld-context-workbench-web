// Parse service: run the expander against a pinned resource snapshot.

import { expandDocument } from './jsonld/expand.js';
import { createSnapshotLoader } from './jsonld/loader.js';
import { JsonLdError, ERR } from './jsonld/errors.js';

export function runParse({ document, snapshotMap, baseUrl = null, sessionId = null,
                          maxDepth = 64, maxContextDepth = 32 }) {
  if (document === null || typeof document !== 'object' && document !== undefined) {
    throw new JsonLdError(ERR.VALIDATION, 'Document must be a JSON object or array');
  }
  const loader = createSnapshotLoader(snapshotMap, { sessionId });
  const result = expandDocument(document ?? {}, {
    loader, baseUrl, maxDepth, maxContextDepth
  });

  // Report the pinned revisions next to include decisions so the UI can show
  // exactly which immutable revision produced each mapping.
  const pinned = {};
  for (const [name, { revision }] of snapshotMap.entries()) pinned[name] = revision;

  return {
    expanded: result.expanded,
    traces: result.traces,
    warnings: result.warnings,
    decisionChain: decorateChain(result.decisionChain, snapshotMap),
    finalContext: result.finalContext,
    pinnedResources: pinned
  };
}

function decorateChain(chain, snapshot) {
  return chain.map(entry => {
    if (entry.kind === 'include') {
      const name = entry.ref.slice('local:'.length);
      const pinned = snapshot.get(name);
      return { ...entry, revision: pinned ? pinned.revision : null };
    }
    return entry;
  });
}
