import { getEmbedder } from './embeddings.js';
import { save } from './db.js';
import { round4 } from './util.js';

/** Group consecutive resume lines into overlapping chunks (1-based, inclusive). */
export function chunkLines(lines, target = 520) {
  const chunks = [];
  let start = 0;
  let len = 0;
  for (let i = 0; i < lines.length; i += 1) {
    len += lines[i].length + 1;
    const last = i === lines.length - 1;
    if (len >= target || last) {
      chunks.push({ from: start + 1, to: i + 1 });
      start = last ? i + 1 : i;
      len = last ? 0 : lines[i].length + 1;
    }
  }
  return chunks;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/** Make sure a candidate has embeddings from the currently active model. */
export async function ensureEmbeddings(cand) {
  const emb = await getEmbedder();
  if (cand.embedTag === emb.tag && cand.chunks && cand.chunks.length) return;
  const chunks = chunkLines(cand.lines);
  const texts = chunks.map((c) => cand.lines.slice(c.from - 1, c.to).join('\n'));
  const vecs = await emb.embedDocs(texts);
  chunks.forEach((c, i) => {
    c.vec = vecs[i].map(round4);
  });
  cand.chunks = chunks;
  cand.embedTag = emb.tag;
  save();
}

/**
 * Find the most relevant resume chunks.
 * perCandidate > 0: best N chunks of each candidate. Otherwise best `total` overall.
 */
export async function retrieve(cands, query, { total = 8, perCandidate = 0 } = {}) {
  const emb = await getEmbedder();
  const qv = await emb.embedQuery(String(query).slice(0, 2000));
  const all = [];
  for (const cand of cands) {
    await ensureEmbeddings(cand);
    const mine = cand.chunks
      .map((chunk) => ({ cand, chunk, score: cosine(qv, chunk.vec) }))
      .sort((a, b) => b.score - a.score);
    all.push(...(perCandidate ? mine.slice(0, perCandidate) : mine));
  }
  all.sort((a, b) => b.score - a.score);
  return perCandidate ? all : all.slice(0, total);
}

export const numbered = (lines, from, to) =>
  lines.slice(from - 1, to).map((t, i) => `L${from + i}: ${t}`);

/**
 * Resume text with line numbers for the LLM. Short resumes go in whole; long ones
 * are cut down to the chunks most relevant to the job.
 */
export async function resumeContext(cand, redacted, query, maxChars = 6500) {
  const all = redacted.map((t, i) => `L${i + 1}: ${t}`);
  const total = all.reduce((n, s) => n + s.length + 1, 0);
  if (total <= maxChars) return all.join('\n');

  const hits = await retrieve([cand], query, { total: 1000 });
  const keep = new Set();
  let used = 0;
  for (const h of hits) {
    let cost = 0;
    for (let i = h.chunk.from; i <= h.chunk.to; i += 1) if (!keep.has(i)) cost += all[i - 1].length + 1;
    if (used + cost > maxChars) continue;
    for (let i = h.chunk.from; i <= h.chunk.to; i += 1) keep.add(i);
    used += cost;
  }
  if (!keep.size) {
    let n = 0;
    for (let i = 1; i <= all.length && n + all[i - 1].length < maxChars; i += 1) {
      keep.add(i);
      n += all[i - 1].length + 1;
    }
  }
  const idx = [...keep].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const i of idx) {
    if (prev && i > prev + 1) out.push('[...]');
    out.push(all[i - 1]);
    prev = i;
  }
  return out.join('\n');
}
