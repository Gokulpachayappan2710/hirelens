import nodemailer from 'nodemailer';
import { config } from './config.js';

export const smtpConfigured = () => Boolean(config.smtp.host);

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

export function renderTemplate(template, vars) {
  return String(template || '').replace(/{{\s*([a-z_]+)\s*}}/gi, (m, key) => {
    const v = vars[key.toLowerCase()];
    return v == null ? '' : String(v);
  });
}

export function templateVars(cand, job, settings) {
  const full = String(cand.name || '').trim();
  return {
    first_name: full.split(/\s+/)[0] || 'there',
    full_name: full,
    role: (job.requirements && job.requirements.title) || job.title,
    company: settings.company || '',
    sender: settings.senderName || '',
  };
}

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());

/** Send one email, or log it when SMTP is not configured. */
export async function sendMail({ to, subject, text, replyTo }) {
  const cleanSubject = String(subject).replace(/[\r\n]+/g, ' ').trim();
  if (!smtpConfigured()) return { status: 'simulated' };
  const from = config.smtp.from || config.smtp.user;
  await getTransport().sendMail({ from, to, subject: cleanSubject, text, replyTo: replyTo || undefined });
  return { status: 'sent' };
}
