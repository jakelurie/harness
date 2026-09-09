/**
 * Model registry. Adding a model is a config edit, never a code edit.
 *
 * Lives at <userData>/models.json and is seeded on first run. The app exposes a
 * "Edit models.json" action so you never have to hunt for the file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadSecrets } from './secrets.js';

export const DEFAULT_MODELS = {
  default: 'opus',
  models: {
    opus: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      label: 'Claude Opus 5',
      priceIn: 5,
      priceOut: 25,
      effort: 'high',
      maxTokens: 32000,
    },
    sonnet: {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      priceIn: 2,
      priceOut: 10,
      maxTokens: 32000,
    },
    astra: {
      provider: 'openai',
      model: 'astra-1',
      label: 'Astra',
      _comment: 'PLACEHOLDER - set baseUrl and model to the real Astra endpoint.',
      baseUrl: 'https://api.astra.example.com/v1',
      apiKeyEnv: 'ASTRA_API_KEY',
      maxTokens: 8192,
    },
    gpt: {
      provider: 'openai',
      model: 'gpt-5',
      label: 'GPT-5',
      apiKeyEnv: 'OPENAI_API_KEY',
    },
    local: {
      provider: 'openai',
      model: 'qwen3:32b',
      label: 'Qwen3 32B (local)',
      baseUrl: 'http://localhost:11434/v1',
    },
  },
};

/** Where each provider looks for a key when models.json does not say. */
const DEFAULT_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function configPath(userDataDir) {
  return path.join(userDataDir, 'models.json');
}

export async function ensureConfig(userDataDir) {
  const file = configPath(userDataDir);
  try {
    await fs.access(file);
  } catch {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(DEFAULT_MODELS, null, 2)}\n`, 'utf8');
  }
  return file;
}

/**
 * Returns { models, default, error }. A broken config is reported rather than
 * thrown, so the window still opens and can tell you what to fix.
 */
export async function loadConfig(userDataDir) {
  const file = await ensureConfig(userDataDir);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    return { models: {}, default: null, path: file, error: `models.json is not valid JSON: ${e.message}` };
  }

  const secrets = await loadSecrets(userDataDir);

  const models = {};
  for (const [alias, block] of Object.entries(raw.models ?? {})) {
    // A key set through the UI wins; the env var named by the config is the
    // fallback; failing both, the provider's own conventional variable.
    const envName = block.apiKeyEnv || DEFAULT_KEY_ENV[block.provider] || '';
    const apiKey = secrets[alias] || (envName ? process.env[envName] || '' : '');

    // A local OpenAI-compatible server (Ollama, vLLM, LM Studio) needs no key,
    // so don't flag it as unconfigured.
    const isLocal = block.provider === 'openai' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(block.baseUrl ?? '');

    // The `claude` CLI carries its own credentials; the harness never holds one.
    const selfAuth = block.provider === 'claude-cli' || block.provider === 'codex-cli';

    models[alias] = {
      alias,
      ...block,
      apiKey,
      keyEnv: envName,
      keySource: selfAuth ? 'subscription' : secrets[alias] ? 'stored' : apiKey ? 'env' : null,
      hasKey: Boolean(apiKey) || isLocal || selfAuth,
    };
  }

  const aliases = Object.keys(models);
  if (!aliases.length) {
    return { models, default: null, path: file, error: 'models.json defines no models' };
  }

  const def = models[raw.default] ? raw.default : aliases[0];
  return { models, default: def, path: file, error: null };
}

/**
 * Merge fields into one model's block in models.json and write it back.
 * Used by the web UI, where there is no text editor to hand.
 */
export async function patchModel(userDataDir, alias, patch) {
  const file = await ensureConfig(userDataDir);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.models ??= {};
  if (!raw.models[alias]) throw new Error(`no model "${alias}" in models.json`);

  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') delete raw.models[alias][k];
    else raw.models[alias][k] = v;
  }

  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return raw.models[alias];
}
