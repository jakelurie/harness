/**
 * Provider registry.
 *
 * Adding a backend that is neither Anthropic- nor OpenAI-shaped: write a module
 * exporting `kind`, `makeClient(spec)` and `complete(...)`, then add it here.
 * Everything else in the app is provider-agnostic.
 */

import * as anthropic from './anthropic.js';
import * as claudeCli from './claude-cli.js';
import * as openaiResponses from './openai-responses.js';
import * as openai from './openai.js';

const REGISTRY = {
  [anthropic.kind]: anthropic,
  [claudeCli.kind]: claudeCli,
  [openai.kind]: openai,
  [openaiResponses.kind]: openaiResponses,
};

const clients = new Map();

export function providerFor(spec) {
  const mod = REGISTRY[spec.provider];
  if (!mod) {
    throw new Error(
      `unknown provider "${spec.provider}" for model "${spec.alias}". ` +
        `Known: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return mod;
}

/**
 * Clients are built once per model and reused. The key has to name every field
 * that goes into building one, or two models differing only in an omitted field
 * would silently share a client.
 */
export function clientFor(spec) {
  const key = [spec.alias, spec.provider, spec.baseUrl ?? '', spec.bin ?? '', spec.apiKey ? 'k' : ''].join(':');
  if (!clients.has(key)) clients.set(key, providerFor(spec).makeClient(spec));
  return clients.get(key);
}

export function resetClients() {
  clients.clear();
}
