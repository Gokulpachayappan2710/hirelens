import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const env = process.env;
const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const smtpPort = num(env.SMTP_PORT, 465);

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  publicDir: path.join(ROOT, 'public'),
  groq: {
    apiKey: (env.GROQ_API_KEY || '').trim(),
    model: (env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim(),
    fastModel: (env.GROQ_FAST_MODEL || 'llama-3.1-8b-instant').trim(),
    baseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').trim().replace(/\/$/, ''),
  },
  embed: {
    model: (env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2').trim(),
    pooling: (env.EMBEDDING_POOLING || 'mean').trim(),
    dtype: (env.EMBEDDING_DTYPE || '').trim(),
    queryPrefix: env.EMBEDDING_QUERY_PREFIX || '',
  },
  smtp: {
    host: (env.SMTP_HOST || '').trim(),
    port: smtpPort,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : smtpPort === 465,
    user: (env.SMTP_USER || '').trim(),
    pass: env.SMTP_PASS || '',
    from: (env.SMTP_FROM || '').trim(),
  },
  auth: { user: env.APP_USER || '', pass: env.APP_PASS || '' },
  company: env.COMPANY_NAME || 'Your Company',
  hrName: env.HR_NAME || 'HR Team',
};
