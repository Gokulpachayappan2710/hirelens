import { db, save } from './db.js';
import { sendMail, renderTemplate, templateVars, isEmail, smtpConfigured } from './mailer.js';
import { uid, sleep, HttpError } from './util.js';

export function setShortlist(job, cid, on) {
  const cand = job.candidates.find((c) => c.id === cid);
  if (!cand) throw new HttpError(404, 'Candidate not found.');
  const has = job.shortlist.includes(cid);
  if (on && !has) job.shortlist.push(cid);
  if (!on && has) job.shortlist = job.shortlist.filter((x) => x !== cid);
  if (on && cand.status === 'new') cand.status = 'shortlisted';
  if (!on && cand.status === 'shortlisted') cand.status = 'new';
  save();
  return job.shortlist;
}

export function defaultDraft() {
  const { standardEmail } = db().settings;
  return { subject: standardEmail.subject, body: standardEmail.body };
}

/** Mark any open email preview cards in the chat as finished. */
export function consumePreviews(job) {
  for (const m of job.chat) {
    if (m.ui && m.ui.type === 'email_preview') m.ui.consumed = true;
  }
}

export async function sendInvites(job, ids, subject, body) {
  const settings = db().settings;
  if (!String(subject || '').trim() || !String(body || '').trim()) {
    throw new HttpError(400, 'Add a subject and a message before sending.');
  }
  const targets = [...new Set(ids)].map((id) => job.candidates.find((c) => c.id === id)).filter(Boolean);
  if (!targets.length) throw new HttpError(400, 'Choose at least one candidate.');
  if (targets.length > 50) throw new HttpError(400, 'Send to 50 candidates or fewer at a time.');

  const results = [];
  for (const cand of targets) {
    const entry = { id: uid(), candidateId: cand.id, name: cand.name, email: cand.email, subject: '', status: '', at: Date.now() };
    if (!isEmail(cand.email)) {
      entry.status = 'skipped';
      entry.error = 'No valid email address on file.';
    } else {
      const vars = templateVars(cand, job, settings);
      entry.subject = renderTemplate(subject, vars);
      const text = renderTemplate(body, vars);
      try {
        const r = await sendMail({ to: cand.email.trim(), subject: entry.subject, text, replyTo: settings.replyTo });
        entry.status = r.status;
        cand.status = r.status === 'sent' ? 'invited' : 'invite-logged';
        cand.invitedAt = Date.now();
      } catch (err) {
        entry.status = 'failed';
        entry.error = String(err.message || 'Could not send').slice(0, 200);
      }
      if (targets.length > 1 && smtpConfigured()) await sleep(400);
    }
    results.push(entry);
    job.emails.push(entry);
  }
  if (job.emails.length > 500) job.emails.splice(0, job.emails.length - 500);
  consumePreviews(job);
  job.chatState = null;
  save();
  return results;
}
