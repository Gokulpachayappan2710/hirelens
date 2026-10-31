import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { db, save, newJob, newCandidate, getJob, getCandidate, modeOf, ranked } from './db.js';
import { parseResume } from './parse.js';
import { redactLines } from './redact.js';
import { ensureEmbeddings } from './rag.js';
import { embedderStatus } from './embeddings.js';
import { llmConfigured } from './llm.js';
import { extractRequirements, startRank, getTask, compareModes, redactionFor } from './screening.js';
import { generateKit } from './kit.js';
import { handleChat, chatForClient, cancelPending, addAssistantNote, agentInfo } from './agent.js';
import { setShortlist, defaultDraft, sendInvites } from './outreach.js';
import { smtpConfigured } from './mailer.js';
import { HttpError, str } from './util.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const candMeta = (c) => ({
  id: c.id,
  n: c.n,
  label: c.label,
  name: c.name,
  email: c.email,
  phone: c.phone,
  fileName: c.fileName,
  status: c.status,
  addedAt: c.addedAt,
  lineCount: c.lines.length,
  invitedAt: c.invitedAt || null,
});

function jobView(job) {
  return {
    id: job.id,
    title: job.title,
    jd: job.jd,
    requirements: job.requirements,
    blind: job.blind,
    createdAt: job.createdAt,
    candidates: job.candidates.map(candMeta),
    evals: job.evals,
    shortlist: job.shortlist,
    kits: Object.fromEntries(Object.keys(job.kits).map((k) => [k, true])),
    emails: job.emails.slice(-100).reverse(),
    bias: compareModes(job),
    task: getTask(job.id),
    pendingEmail: Boolean(job.chatState && job.chatState.pending),
  };
}

const jobSummary = (j) => ({
  id: j.id,
  title: j.title,
  candidates: j.candidates.length,
  shortlisted: j.shortlist.length,
  createdAt: j.createdAt,
});

const csvCell = (v) => {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'",
    );
    next();
  });

  if (config.auth.user && config.auth.pass) {
    app.use((req, res, next) => {
      const m = String(req.headers.authorization || '').match(/^Basic (.+)$/i);
      if (m) {
        const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
        if (safeEqual(user, config.auth.user) && safeEqual(rest.join(':'), config.auth.pass)) return next();
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="Hirelens"');
      return res.status(401).send('Sign in required.');
    });
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(config.publicDir));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 30 } });

  /* ----- status and settings ----- */

  app.get('/api/health', (req, res) => {
    res.json({
      llm: { configured: llmConfigured(), model: config.groq.model, fastModel: config.groq.fastModel },
      embeddings: { mode: embedderStatus.mode, model: config.embed.model, error: embedderStatus.error },
      agent: { engine: agentInfo.engine },
      smtp: { configured: smtpConfigured() },
    });
  });

  app.get('/api/settings', (req, res) => res.json(db().settings));

  app.put('/api/settings', (req, res) => {
    const b = req.body || {};
    const s = db().settings;
    if (typeof b.company === 'string') s.company = str(b.company, 120);
    if (typeof b.senderName === 'string') s.senderName = str(b.senderName, 120);
    if (typeof b.replyTo === 'string') s.replyTo = str(b.replyTo, 200);
    if (b.standardEmail && typeof b.standardEmail === 'object') {
      if (typeof b.standardEmail.subject === 'string' && b.standardEmail.subject.trim()) {
        s.standardEmail.subject = b.standardEmail.subject.replace(/[\r\n]+/g, ' ').slice(0, 200);
      }
      if (typeof b.standardEmail.body === 'string' && b.standardEmail.body.trim()) {
        s.standardEmail.body = b.standardEmail.body.slice(0, 5000);
      }
    }
    save();
    res.json(s);
  });

  /* ----- roles ----- */

  app.get('/api/jobs', (req, res) => res.json(db().jobs.map(jobSummary).sort((a, b) => b.createdAt - a.createdAt)));

  app.post('/api/jobs', (req, res) => {
    const job = newJob(req.body && req.body.title);
    db().jobs.push(job);
    save();
    res.status(201).json(jobView(job));
  });

  app.get('/api/jobs/:id', wrap((req, res) => res.json(jobView(getJob(req.params.id)))));

  app.patch('/api/jobs/:id', wrap((req, res) => {
    const job = getJob(req.params.id);
    const b = req.body || {};
    if (typeof b.title === 'string' && b.title.trim()) job.title = b.title.trim().slice(0, 120);
    if (typeof b.blind === 'boolean') job.blind = b.blind;
    save();
    res.json(jobView(job));
  }));

  app.delete('/api/jobs/:id', wrap((req, res) => {
    const job = getJob(req.params.id);
    db().jobs = db().jobs.filter((j) => j !== job);
    save();
    res.json({ ok: true });
  }));

  app.post('/api/jobs/:id/analyse', wrap(async (req, res) => {
    const job = getJob(req.params.id);
    const b = req.body || {};
    const jd = String(b.jd || '').trim().slice(0, 12000);
    if (jd.length < 30) throw new HttpError(400, 'Paste the full job description (at least a few lines).');
    if (typeof b.title === 'string' && b.title.trim()) job.title = b.title.trim().slice(0, 120);
    const changed = jd !== job.jd;
    const hadScores = Object.keys(job.evals).length > 0;
    job.jd = jd;
    if (changed) {
      job.evals = {};
      job.kits = {};
      job.requirements = null;
    }
    save();
    let warning = '';
    try {
      job.requirements = await extractRequirements(job);
    } catch (err) {
      warning = err.message || 'Could not read requirements from the job description.';
    }
    save();
    res.json({ job: jobView(job), warning, reset: changed && hadScores });
  }));

  /* ----- candidates ----- */

  app.post('/api/jobs/:id/resumes', upload.array('files', 30), wrap(async (req, res) => {
    const job = getJob(req.params.id);
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, 'Choose at least one resume (PDF, DOCX or TXT).');
    const added = [];
    const errors = [];
    for (const f of files) {
      try {
        const parsed = await parseResume(f);
        const dup = parsed.email && job.candidates.some((c) => c.email && c.email.toLowerCase() === parsed.email.toLowerCase());
        if (dup) throw new Error('A candidate with this email address is already in this role.');
        const cand = newCandidate(job, { ...parsed, fileName: f.originalname });
        job.candidates.push(cand);
        try {
          await ensureEmbeddings(cand);
        } catch (err) {
          console.warn('[rag] indexing postponed:', err.message);
        }
        added.push(cand.id);
      } catch (err) {
        errors.push({ file: f.originalname, error: err.message || 'Could not read this file.' });
      }
    }
    save();
    res.json({ added, errors, job: jobView(job) });
  }));

  app.get('/api/jobs/:id/candidates/:cid', wrap((req, res) => {
    const job = getJob(req.params.id);
    const cand = getCandidate(job, req.params.cid);
    const blind = req.query.blind === '1';
    res.json({
      ...candMeta(cand),
      name: blind ? null : cand.name,
      email: blind ? null : cand.email,
      phone: blind ? null : cand.phone,
      fileName: blind ? null : cand.fileName,
      lines: blind ? redactLines(cand.lines, cand, redactionFor('blind')) : cand.lines,
    });
  }));

  app.patch('/api/jobs/:id/candidates/:cid', wrap((req, res) => {
    const job = getJob(req.params.id);
    const cand = getCandidate(job, req.params.cid);
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) cand.name = b.name.trim().slice(0, 80);
    if (typeof b.email === 'string') cand.email = b.email.trim().slice(0, 200);
    save();
    res.json(candMeta(cand));
  }));

  app.delete('/api/jobs/:id/candidates/:cid', wrap((req, res) => {
    const job = getJob(req.params.id);
    const cand = getCandidate(job, req.params.cid);
    job.candidates = job.candidates.filter((c) => c !== cand);
    delete job.evals[cand.id];
    delete job.kits[cand.id];
    job.shortlist = job.shortlist.filter((id) => id !== cand.id);
    save();
    res.json(jobView(job));
  }));

  /* ----- scoring ----- */

  app.post('/api/jobs/:id/rank', wrap((req, res) => {
    const job = getJob(req.params.id);
    const b = req.body || {};
    const modes = b.mode === 'both' ? ['standard', 'blind'] : [b.mode === 'blind' || b.mode === 'standard' ? b.mode : modeOf(job)];
    const task = startRank(job, modes, { force: Boolean(b.force) });
    res.status(202).json({ task });
  }));

  app.get('/api/jobs/:id/task', wrap((req, res) => {
    getJob(req.params.id);
    res.json({ task: getTask(req.params.id) });
  }));

  /* ----- shortlist, kits, email ----- */

  app.post('/api/jobs/:id/shortlist', wrap((req, res) => {
    const job = getJob(req.params.id);
    const b = req.body || {};
    setShortlist(job, String(b.candidateId || ''), Boolean(b.on));
    res.json({ shortlist: job.shortlist, candidates: job.candidates.map(candMeta) });
  }));

  app.get('/api/jobs/:id/shortlist.csv', wrap((req, res) => {
    const job = getJob(req.params.id);
    const mode = modeOf(job);
    const rows = [['Rank', 'Name', 'Email', 'Score', 'Verdict', 'Status', 'Summary']];
    const board = ranked(job, mode);
    for (const id of job.shortlist) {
      const c = job.candidates.find((x) => x.id === id);
      if (!c) continue;
      const idx = board.findIndex((x) => x.c.id === id);
      const e = idx >= 0 ? board[idx].e : null;
      rows.push([idx >= 0 ? idx + 1 : '', c.name, c.email, e ? e.score : '', e ? e.verdict : '', c.status, e ? e.summary : '']);
    }
    const file = `${job.title.replace(/[^\w-]+/g, '_').slice(0, 40) || 'shortlist'}_shortlist.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.send(`\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}`);
  }));

  app.post('/api/jobs/:id/kit', wrap(async (req, res) => {
    const job = getJob(req.params.id);
    const b = req.body || {};
    const cand = getCandidate(job, String(b.candidateId || ''));
    const kit = !b.force && job.kits[cand.id] ? job.kits[cand.id] : await generateKit(job, cand);
    res.json({ kit });
  }));

  app.get('/api/jobs/:id/kit/:cid', wrap((req, res) => {
    const job = getJob(req.params.id);
    const kit = job.kits[req.params.cid];
    if (!kit) throw new HttpError(404, 'No interview kit yet for this candidate.');
    res.json({ kit });
  }));

  app.post('/api/jobs/:id/email/draft', wrap((req, res) => {
    getJob(req.params.id);
    res.json(defaultDraft());
  }));

  app.post('/api/jobs/:id/email/send', wrap(async (req, res) => {
    const job = getJob(req.params.id);
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    const results = await sendInvites(job, ids, b.subject, b.body);
    const sent = results.filter((r) => r.status === 'sent').length;
    const logged = results.filter((r) => r.status === 'simulated').length;
    const bad = results.filter((r) => r.status === 'failed' || r.status === 'skipped').length;
    const parts = [];
    if (sent) parts.push(`sent ${sent} email${sent > 1 ? 's' : ''}`);
    if (logged) parts.push(`logged ${logged} email${logged > 1 ? 's' : ''} (SMTP is not set up, so nothing was delivered)`);
    if (bad) parts.push(`${bad} could not be sent`);
    addAssistantNote(job, `Done: ${parts.join(', ')}.`);
    res.json({ results, job: jobView(job) });
  }));

  /* ----- assistant ----- */

  app.get('/api/jobs/:id/chat', wrap((req, res) => res.json({ messages: chatForClient(getJob(req.params.id)) })));

  app.post('/api/jobs/:id/chat', wrap(async (req, res) => {
    const messages = await handleChat(req.params.id, req.body && req.body.message);
    const job = getJob(req.params.id);
    res.json({ messages, job: jobView(job) });
  }));

  app.post('/api/jobs/:id/chat/cancel', wrap((req, res) => {
    const job = getJob(req.params.id);
    cancelPending(job);
    res.json({ messages: chatForClient(job) });
  }));

  app.post('/api/jobs/:id/chat/clear', wrap((req, res) => {
    const job = getJob(req.params.id);
    job.chat = [];
    job.chatState = null;
    save();
    res.json({ messages: [] });
  }));

  /* ----- errors ----- */

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.code && String(err.code).startsWith('LIMIT_') ? 400 : 500);
    if (status >= 500) console.error('[server]', err);
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'A file is too large (limit 8 MB each).'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Too many files at once (limit 30).'
          : status >= 500 && !(err instanceof HttpError)
            ? 'Something went wrong on the server. Check the terminal for details.'
            : err.message || 'Request failed.';
    res.status(status).json({ error: message });
  });

  return app;
}
