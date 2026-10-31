import { EMAIL_RE, PHONE_RE, LINK_RE, isPhone } from './parse.js';
import { escapeRegExp } from './util.js';

/* Names that are also everyday words: never redacted on their own. */
const COMMON = new Set(['will', 'mark', 'page', 'rose', 'hope', 'bill', 'grace', 'dawn', 'king', 'long', 'young', 'best', 'wells']);

export function nameTokens(name) {
  const toks = String(name || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}'’-]/gu, ''))
    .filter((t) => t.length >= 4 && !COMMON.has(t.toLowerCase()));
  return [...new Set(toks)];
}

const wordRe = (inner) => new RegExp(`(?<![\\p{L}\\d])${inner}(?![\\p{L}\\d])`, 'giu');

function nameRegexes(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  if (parts.length && parts.join(' ').length >= 3) out.push(wordRe(parts.map(escapeRegExp).join('\\s+')));
  for (const t of nameTokens(name)) out.push(wordRe(escapeRegExp(t)));
  return out;
}

/** Mask email addresses, links and phone numbers in one line of text. */
export function maskContact(line) {
  return String(line)
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(LINK_RE, '[LINK]')
    .replace(PHONE_RE, (m) => (isPhone(m) ? '[PHONE]' : m));
}

const PERSONAL_LINE =
  /^\s*(gender|sex|date of birth|d\.?o\.?b\.?|age|marital status|nationality|religion|caste|father'?s? name|mother'?s? name|spouse|photo|address|permanent address|current address|location)\b\s*[:\-–]/i;

const INSTITUTION = [
  /\b(?:[A-Z][\p{L}&.'’-]*\s+){0,6}(?:University|College|Institute|School|Academy|Polytechnic|Vidyalaya|Vidyapeeth)\b(?:\s+of\s+(?:[A-Z][\p{L}&.'’-]*\s*){1,4})?/gu,
  /\b(?:University|Institute|College|School)\s+of\s+(?:[A-Z][\p{L}&.'’-]*\s*){1,4}/gu,
  /\b(?:IIT|NIT|IIIT|IIM|IISc|BITS|VIT|SRM|MIT|NUS|NTU)\b(?:\s+[A-Z][a-z]+)?/g,
];

const EDU_LINE =
  /\b(B\.?Tech|B\.?E\.?|M\.?Tech|M\.?E\.?|MBA|B\.?Sc|M\.?Sc|B\.?A\.?|M\.?A\.?|BCA|MCA|Bachelor|Master|Ph\.?D|Diploma|degree|CGPA|GPA|percentage|graduat)|\[INSTITUTION\]/i;

/** Hide details that can trigger bias: institutions, graduation years, gender cues, titles. */
export function maskIdentity(line) {
  let l = String(line);
  for (const re of INSTITUTION) l = l.replace(re, '[INSTITUTION]');
  if (EDU_LINE.test(l)) l = l.replace(/\b(?:19|20)\d{2}\b/g, '[YEAR]');
  l = l
    .replace(/\b(?:Mr|Mrs|Ms|Miss|Mx)\.?\s+(?=[A-Z])/g, '')
    .replace(/\b(himself|herself)\b/gi, 'themselves')
    .replace(/\b(she|he)\b/gi, 'they')
    .replace(/\b(hers|his|her)\b/gi, 'their')
    .replace(/\bhim\b/gi, 'them');
  return l;
}

/**
 * Redact resume lines without changing the line count (so line numbers stay valid).
 * name: 'keep' (leave name), 'alias' (Candidate-N) or 'mask' ([CANDIDATE]).
 * identity: also hide institutions, years, personal fields and gender cues.
 */
export function redactLines(lines, cand, { name = 'keep', identity = false } = {}) {
  const res = name === 'keep' ? [] : nameRegexes(cand && cand.name);
  const rep = name === 'alias' ? `Candidate-${cand.n}` : '[CANDIDATE]';
  return lines.map((raw) => {
    let l = maskContact(raw);
    if (identity && PERSONAL_LINE.test(l)) return '[REDACTED]';
    for (const re of res) l = l.replace(re, rep);
    if (identity) l = maskIdentity(l);
    return l;
  });
}

/**
 * Pseudonymise candidate names in free text before it goes to the LLM, and map
 * the aliases back to display names afterwards.
 */
export function aliasMap(cands) {
  const byN = new Map(cands.map((c) => [c.n, c]));
  const tokCount = new Map();
  for (const c of cands) {
    for (const t of new Set(nameTokens(c.name).map((x) => x.toLowerCase()))) {
      tokCount.set(t, (tokCount.get(t) || 0) + 1);
    }
  }
  const pats = [];
  for (const c of cands) {
    const alias = `Candidate-${c.n}`;
    const parts = String(c.name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length && parts.join(' ').length >= 3) {
      pats.push({ re: wordRe(parts.map(escapeRegExp).join('\\s+')), alias, w: parts.join(' ').length });
    }
    for (const t of nameTokens(c.name)) {
      if (tokCount.get(t.toLowerCase()) === 1) pats.push({ re: wordRe(escapeRegExp(t)), alias, w: t.length });
    }
  }
  pats.sort((a, b) => b.w - a.w);

  return {
    toAlias(text) {
      let out = String(text || '')
        .split('\n')
        .map(maskContact)
        .join('\n');
      for (const p of pats) out = out.replace(p.re, p.alias);
      return out;
    },
    fromAlias(text, labelOf) {
      return String(text || '').replace(/Candidate-(\d+)/g, (m, n) => {
        const c = byN.get(Number(n));
        return c ? labelOf(c) : m;
      });
    },
    idsIn(text) {
      const ids = [];
      for (const m of String(text || '').matchAll(/Candidate-(\d+)/g)) {
        const c = byN.get(Number(m[1]));
        if (c && !ids.includes(c.id)) ids.push(c.id);
      }
      return ids;
    },
    byN,
  };
}
