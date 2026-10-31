import path from 'node:path';
import { config } from './config.js';
import { tokens } from './util.js';

const DIM = 512;

function hashVector(text) {
  const v = new Float32Array(DIM);
  const toks = tokens(text);
  const grams = toks.concat(toks.slice(1).map((t, i) => `${toks[i]}_${t}`));
  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i += 1) h = Math.imul(h ^ g.charCodeAt(i), 16777619) >>> 0;
    v[h % DIM] += h & 0x10000 ? 1 : -1;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  return Array.from(v, (x) => (norm ? x / norm : 0));
}

/** Keyword-style fallback used only when the neural model cannot be loaded. */
const hashEmbedder = {
  tag: `hash-${DIM}`,
  mode: 'fallback',
  embedDocs: async (texts) => texts.map(hashVector),
  embedQuery: async (q) => hashVector(q),
};

let pending = null;
export const embedderStatus = { ready: false, mode: 'loading', model: config.embed.model, error: '' };

async function init() {
  if (process.env.HIRELENS_FORCE_HASH === '1') {
    Object.assign(embedderStatus, { ready: true, mode: 'fallback', error: 'forced by HIRELENS_FORCE_HASH' });
    return hashEmbedder;
  }
  try {
    const tf = await import('@huggingface/transformers');
    if (tf.env) tf.env.cacheDir = path.join(config.dataDir, 'models');
    const opts = {};
    if (config.embed.dtype) opts.dtype = config.embed.dtype;
    const extractor = await tf.pipeline('feature-extraction', config.embed.model, opts);
    const run = async (texts) => {
      const out = [];
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16);
        const tensor = await extractor(batch, { pooling: config.embed.pooling, normalize: true });
        out.push(...tensor.tolist());
      }
      return out;
    };
    // Smoke test so a broken model falls back now instead of mid-request.
    const probe = await run(['hello world']);
    if (!Array.isArray(probe[0]) || !probe[0].length) throw new Error('model returned no vector');
    Object.assign(embedderStatus, { ready: true, mode: 'model', error: '' });
    return {
      tag: config.embed.model,
      mode: 'model',
      embedDocs: run,
      embedQuery: async (q) => (await run([config.embed.queryPrefix + q]))[0],
    };
  } catch (err) {
    console.warn(
      `[embeddings] Could not load "${config.embed.model}" (${err.message}). Using the built-in keyword fallback. ` +
        'Check your internet connection for the first-run download, then restart.',
    );
    Object.assign(embedderStatus, { ready: true, mode: 'fallback', error: String(err.message || err) });
    return hashEmbedder;
  }
}

export function getEmbedder() {
  if (!pending) pending = init();
  return pending;
}
