// Seed the store with demo resources the first time the workbench runs.

export function seedIfEmpty(store) {
  if (store.listResources().length > 0) return;

  // Core vocabulary — note @base, @vocab, prefixes, a keyword alias,
  // language/index containers and a protected term.
  const schema = {
    '@version': 1.1,
    '@base': 'https://example.com/things/',
    '@vocab': 'https://schema.org/',
    'xsd': { '@id': 'http://www.w3.org/2001/XMLSchema#', '@prefix': true },
    'name': { '@id': 'name', '@container': ['@language'] },
    'identifier': '@id',
    'kind': '@type',
    'created': { '@id': 'dateCreated', '@type': 'xsd:date' },
    'homepage': { '@id': 'url', '@type': '@id' },
    'label': {
      '@id': 'http://www.w3.org/2000/01/rdf-schema#label',
      '@container': '@language'
    },
    'thingsById': { '@id': 'thing', '@container': '@id' },
    'byCode': { '@id': 'coded', '@container': '@index' },
    'id': '@id' // keyword alias: "id" => @id
  };

  // Extension context that includes schema via its local reference (nested),
  // then overrides a term. Demonstrates nested context + term override chain.
  const ext = {
    '@context': 'local:schema',
    'name': { '@id': 'https://example.net/fullName' },
    'priority': { '@id': 'https://example.net/priority' }
  };

  // Secure context: protected terms survive a null-context reset and block
  // incompatible redefinitions.
  const secure = {
    '@vocab': 'https://secure.example.org/',
    'owner': {
      '@id': 'https://security.example.org/owner',
      '@protected': true
    },
    'classification': {
      '@id': 'https://security.example.org/classification',
      '@protected': true,
      '@type': 'xsd:string'
    }
  };

  for (const [name, body] of Object.entries({ schema, ext, secure })) {
    store.putResource(name, body, null);
  }
}
