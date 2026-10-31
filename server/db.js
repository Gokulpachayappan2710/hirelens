import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { uid, letters, HttpError } from './util.js';

const FILE = path.join(config.dataDir, 'db.json');

export const DEFAULT_EMAIL = {
  subject: 'Interview invitation: {{role}} at {{company}}',
  body: `Hi {{first_name}},

Thank you for applying for the {{role}} position at {{company}}. We enjoyed reading about your background and would like to invite you to an interview.

Please reply with two or three time slots that suit you over the next week and we will confirm one.

Best regards,
{{sender}}
{{company}}`,
};

function defaults() {
  return {
    version: 1,
    settings: {
      company: config.company,
      senderName: config.hrName,
      replyTo: '',
      standardEmail: { ...DEFAULT_EMAIL },
    },
    jobs: [],
  };
}

let state = defaults();
let timer = null;

export function loadDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(FILE)) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const base = defaults();
    state = {
      ...base,
      ...raw,
      settings: {
        ...base.settings,
        ...(raw.settings || {}),
        standardEmail: { ...DEFAULT_EMAIL, ...((raw.settings || {}).standardEmail || {}) },
      },
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    };
  } catch (err) {
    const backup = `${FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(FILE, backup);
    } catch {
      /* ignore */
    }
    console.error(`Could not read ${FILE} (${err.message}). A backup was saved to ${backup}. Starting fresh.`);
    state = defaults();
  }
  return state;
}

export const db = () => state;

export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
}

export function flush() {
  clearTimeout(timer);
  timer = null;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('Could not save data:', err.message);
  }
}

export function newJob(title) {
  return {
    id: uid(),
    title: String(title || '').trim().slice(0, 120) || 'Untitled role',
    createdAt: Date.now(),
    jd: '',
    requirements: null,
    blind: false,
    candidates: [],
    nextN: 1,
    evals: {},
    shortlist: [],
    kits: {},
    chat: [],
    chatState: null,
    emails: [],
  };
}

export function newCandidate(job, data) {
  const n = job.nextN++;
  return {
    id: uid(),
    n,
    label: `Candidate ${letters(n)}`,
    name: data.name,
    email: data.email || '',
    phone: data.phone || '',
    fileName: data.fileName || '',
    lines: data.lines,
    status: 'new',
    addedAt: Date.now(),
    chunks: [],
    embedTag: null,
  };
}

export function getJob(id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, 'Role not found.');
  return job;
}

export function getCandidate(job, cid) {
  const cand = job.candidates.find((c) => c.id === cid);
  if (!cand) throw new HttpError(404, 'Candidate not found.');
  return cand;
}

export const modeOf = (job) => (job.blind ? 'blind' : 'standard');

/** Evaluation for a candidate in the preferred mode, falling back to the other one. */
export function evalFor(job, cand, mode) {
  const e = job.evals[cand.id] || {};
  return e[mode] || e[mode === 'blind' ? 'standard' : 'blind'] || null;
}

/** Scored candidates, best first. */
export function ranked(job, mode) {
  return job.candidates
    .map((c) => ({ c, e: evalFor(job, c, mode) }))
    .filter((x) => x.e)
    .sort((a, b) => b.e.score - a.e.score);
}
