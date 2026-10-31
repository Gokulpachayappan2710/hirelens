import { randomUUID } from 'node:crypto';

export const uid = () => randomUUID();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const round4 = (x) => Math.round(x * 1e4) / 1e4;
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const STOP = new Set(
  'the and for with from that this you your are was were has have had not but all any can will our their they them its into over more most than then also about such per via using use used etc'.split(
    ' ',
  ),
);

/** Lower-case word tokens (keeps things like c++, node.js, c#). */
export function tokens(text) {
  const found = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.]*/g) || [];
  return found.map((t) => t.replace(/\.+$/, '')).filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Share of the quote's distinct tokens that also appear in the haystack (0..1). */
export function overlap(quote, haystack) {
  const q = [...new Set(tokens(quote))];
  if (!q.length) return 0;
  const h = new Set(tokens(haystack));
  let hit = 0;
  for (const t of q) if (h.has(t)) hit += 1;
  return hit / q.length;
}

/** 1 -> A, 26 -> Z, 27 -> AA */
export function letters(n) {
  let s = '';
  let k = Math.max(1, Math.floor(n));
  while (k > 0) {
    k -= 1;
    s = String.fromCharCode(65 + (k % 26)) + s;
    k = Math.floor(k / 26);
  }
  return s;
}

export function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

export const str = (v, max = 300) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
