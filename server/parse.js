import path from 'node:path';
import { createRequire } from 'node:module';
import { titleCase } from './util.js';

const require = createRequire(import.meta.url);

export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const PHONE_RE = /(?<!\d)\+?\d[\d\s().-]{8,}\d(?!\d)/g;
export const LINK_RE =
  /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin|github|gitlab|behance|medium|twitter)\.com\/\S+/gi;

/** True when a matched digit run looks like a phone number (not a date range or id). */
export function isPhone(s) {
  const digits = String(s).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

export function detectContact(text) {
  const email = (String(text).match(EMAIL_RE) || [])[0] || '';
  const phone = ((String(text).match(PHONE_RE) || []).find(isPhone) || '').trim();
  return { email, phone };
}

function wrapLong(line) {
  const parts = line.split(/(?<=[.;!?])\s+/);
  const segs = [];
  let cur = '';
  for (const p of parts) {
    if (cur && `${cur} ${p}`.length > 300) {
      segs.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur} ${p}` : p;
    }
  }
  if (cur) segs.push(cur);
  return segs.flatMap((s) => (s.length > 400 ? s.match(/.{1,400}/g) : [s]));
}

/** Clean text into dense, numbered-friendly lines (no blanks, long lines wrapped). */
export function normalizeLines(text) {
  const raw = String(text || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const original of raw) {
    const line = original.replace(/[\t\u00a0]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!line) continue;
    if (line.length > 300) out.push(...wrapLong(line));
    else out.push(line);
    if (out.length >= 700) break;
  }
  return out;
}

const NOT_A_NAME =
  /\b(resume|curriculum|vitae|cv|profile|summary|objective|contact|email|phone|address|experience|education|skills|projects|engineer|developer|manager|analyst|designer|consultant|intern|student|linkedin|github|www|http|page)\b/i;

export function detectName(lines, fileName = '') {
  for (const raw of lines.slice(0, 8)) {
    const l = raw.replace(/^name\s*[:\-]\s*/i, '').trim();
    if (l.length < 4 || l.length > 40) continue;
    if (/[\d@:/\\|]/.test(l) || NOT_A_NAME.test(l)) continue;
    if (!/^[\p{L}][\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){1,3}$/u.test(l)) continue;
    return l === l.toUpperCase() ? titleCase(l) : l;
  }
  const base = path
    .basename(String(fileName), path.extname(String(fileName)))
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(resume|cv|curriculum|vitae|final|updated|new|copy)\b/gi, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base ? titleCase(base) : 'Unnamed candidate';
}

export async function extractText({ originalname, buffer }) {
  const ext = path.extname(originalname || '').toLowerCase();
  if (ext === '.pdf') {
    const pdf = require('pdf-parse/lib/pdf-parse.js');
    const result = await pdf(buffer);
    return result.text || '';
  }
  if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  if (ext === '.txt' || ext === '.md') return buffer.toString('utf8');
  throw new Error('Unsupported file type. Use PDF, DOCX or TXT.');
}

export async function parseResume(file) {
  const text = await extractText(file);
  const lines = normalizeLines(text);
  const chars = lines.join('').length;
  if (lines.length < 3 || chars < 150) {
    throw new Error('No readable text found. Scanned or image-only files are not supported.');
  }
  const { email, phone } = detectContact(lines.join('\n'));
  return { name: detectName(lines, file.originalname), email, phone, lines };
}
