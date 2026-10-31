import { config } from './config.js';
import { sleep } from './util.js';

export class LlmError extends Error {
  constructor(message, status = 0, body = '') {
    super(message);
    this.status = status;
    this.body = body;
    /* Retrying will not help for these. */
    this.fatal = status === 0 || status === 401 || status === 403 || status === 404;
  }
}

export const llmConfigured = () => Boolean(config.groq.apiKey);

function describeError(status, text) {
  let msg = '';
  try {
    msg = JSON.parse(text).error.message || '';
  } catch {
    msg = String(text || '').slice(0, 200);
  }
  if (status === 401) return 'Groq rejected the API key. Check GROQ_API_KEY in your .env file.';
  if (status === 404 || /decommission|does not exist|not found/i.test(msg)) {
    return `Groq could not use the model. Update GROQ_MODEL in .env. (${msg})`;
  }
  if (status === 413) return 'The request was too large for the model. Try a shorter resume or job description.';
  return `Groq error ${status}: ${msg || 'request failed'}`;
}

async function callGroq(body, { attempts = 5, onWait } = {}) {
  if (!llmConfigured()) {
    throw new LlmError('Add your Groq API key to the .env file (GROQ_API_KEY) and restart the app.', 0);
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res;
    try {
      res = await fetch(`${config.groq.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.groq.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      if (attempt === attempts) throw new LlmError(`Could not reach Groq: ${err.message}`, 599);
      await sleep(1500 * attempt);
      continue;
    }
    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < attempts) {
      const ra = parseFloat(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) ? Math.min(ra, 60) * 1000 + 250 : 2000 * attempt;
      if (onWait) onWait(wait);
      await sleep(wait);
      continue;
    }
    throw new LlmError(describeError(res.status, text), res.status, text);
  }
  throw new LlmError('Groq did not respond.', 599);
}

export function parseJsonLoose(s) {
  const text = String(s || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const unfenced = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    /* fall through */
  }
  const a = unfenced.indexOf('{');
  const b = unfenced.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(unfenced.slice(a, b + 1));
    } catch {
      /* fall through */
    }
  }
  throw new LlmError('The model returned an unreadable answer. Please try again.', 422);
}

export async function chatJSON({ system, user, model, temperature = 0, maxTokens = 1400, onWait }) {
  const base = {
    model: model || config.groq.model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  let lastErr;
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      let data;
      try {
        data = await callGroq({ ...base, response_format: { type: 'json_object' } }, { onWait });
      } catch (err) {
        if (err.status === 400 && /json/i.test(err.body || '')) data = await callGroq(base, { onWait });
        else throw err;
      }
      return parseJsonLoose(data.choices?.[0]?.message?.content);
    } catch (err) {
      lastErr = err;
      if (err.status !== 422) throw err;
    }
  }
  throw lastErr;
}

export async function chatText({ system, user, history = [], model, temperature = 0.2, maxTokens = 900, onWait }) {
  const data = await callGroq(
    {
      model: model || config.groq.model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }],
    },
    { onWait },
  );
  return String(data.choices?.[0]?.message?.content || '').trim();
}
