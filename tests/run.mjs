/* Hirelens test suite. Run with: npm test
   Uses a mocked Groq API, a temporary data folder and the built-in keyword embeddings,
   so it needs no internet connection and no API key. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hirelens-test-'));
process.env.DATA_DIR = tmp;
process.env.GROQ_API_KEY = 'test-key';
process.env.HIRELENS_FORCE_HASH = '1';
process.env.SMTP_HOST = '';

/* ---------- sample resumes ---------- */
const RESUMES = {
  priya: `PRIYA SHARMA
priya.sharma@example.com | +91 98765 43210 | linkedin.com/in/priya-sharma
Gender: Female
Summary
Backend engineer with five years of Python and machine learning experience.
Built a fraud detection pipeline in Python that cut chargebacks by 31 percent.
Led a team of four engineers and mentored two interns. She ships reliable services.
Education
B.Tech Computer Science, Anna University, 2018
Skills: Python, FastAPI, PostgreSQL, Docker, machine learning, AWS`,
  rahul: `Rahul Verma
rahul.verma@example.com | +91 91234 56789
Senior developer focused on Java and Spring Boot microservices for banking clients.
Designed a payments ledger in Java handling two million transactions per day.
Education
M.Tech Software Engineering, Indian Institute of Technology Madras, 2015
Skills: Java, Spring Boot, Kafka, Oracle, Jenkins`,
  meera: `Meera Nair
meera.nair@example.com | +91 99887 76655
Frontend developer who builds React applications with a strong design sense.
Created a component library in React used by six product teams at her company.
Education
B.Sc Computer Science, Christ College, 2020
Skills: React, TypeScript, CSS, Figma, accessibility testing`,
};

/* ---------- Groq mock ---------- */
const calls = [];
const mock = { classify: '{"intent":"qa","count":null}', answer: 'Candidate-1 has the strongest Python background [Candidate-1 L5-6].', failAll: 0 };
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const sys = body.messages[0].content;
  const user = body.messages[body.messages.length - 1].content;
  calls.push({ sys, user, model: body.model });
  const reply = (content) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }] }), text: async () => content });
  if (mock.failAll) return { ok: false, status: mock.failAll, headers: { get: () => null }, text: async () => '{"error":{"message":"bad key"}}', json: async () => ({}) };
  if (sys.startsWith('Classify a message')) return reply(mock.classify);
  if (sys.startsWith('You turn job descriptions')) {
    return reply(JSON.stringify({ title: 'Backend Engineer', must_have: ['Python experience', 'Machine learning', 'Team leadership', 'SQL databases'], nice_to_have: ['AWS'] }));
  }
  if (sys.includes('careful, fair resume screener')) {
    const text = user.split('RESUME (numbered lines):')[1] || '';
    const lines = text.split('\n').filter((l) => /^L\d+:/.test(l));
    const find = (kw) => lines.find((l) => l.includes(kw));
    const hit = find('Python') || find('Java') || find('React');
    const score = find('Python') ? 88 : find('Java') ? 62 : 40;
    const num = hit ? Number(hit.match(/^L(\d+):/)[1]) : 1;
    const quote = hit ? hit.replace(/^L\d+:\s*/, '').split(' ').slice(0, 12).join(' ') : '';
    return reply(
      JSON.stringify({
        score,
        summary: 'Solid fit for backend work.',
        coverage: [
          { requirement: 'Python experience', status: find('Python') ? 'met' : 'missing', lines: find('Python') ? [num] : [] },
          { requirement: 'Team leadership', status: 'partial', lines: [] },
        ],
        strengths: [
          { point: 'Relevant hands-on experience', lines: [num + 7 > lines.length ? 1 : num + 1], quote },
          { point: 'Won an industry award', lines: [1], quote: 'Won the global innovation award in twenty twenty one' },
        ],
        weaknesses: [{ point: 'No SQL database experience shown', lines: [], quote: '' }],
      }),
    );
  }
  if (sys.startsWith('You design structured interviews')) {
    return reply(
      JSON.stringify({
        focus: ['Database depth'],
        questions: Array.from({ length: 6 }, (_, i) => ({
          category: i < 2 ? 'Gap probe' : 'Experience deep-dive',
          question: `Question ${i + 1} about the candidate?`,
          why: 'Tests a stated requirement (L5).',
          listen_for: ['Concrete example'],
          follow_up: 'What would you change?',
        })),
        scorecard: [{ criterion: 'Python', look_for: 'Depth' }, { criterion: 'SQL', look_for: 'Schema design' }, { criterion: 'Communication', look_for: 'Clarity' }, { criterion: 'Problem solving', look_for: 'Trade-offs' }],
      }),
    );
  }
  if (sys.startsWith('You are an HR screening assistant')) return reply(mock.answer);
  return reply('{}');
};

/* ---------- tiny runner ---------- */
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 4).join('\n       ')}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { parseResume, normalizeLines, detectContact } = await import('../server/parse.js');
const { redactLines, aliasMap, maskContact } = await import('../server/redact.js');
const { chunkLines, retrieve, ensureEmbeddings } = await import('../server/rag.js');
const { parseJsonLoose } = await import('../server/llm.js');
const { normalizeEval, compareModes, startRank, getTask, extractRequirements, verdictFor } = await import('../server/screening.js');
const { renderTemplate, templateVars, isEmail } = await import('../server/mailer.js');
const dbm = await import('../server/db.js');
const { handleChat, chatForClient, cancelPending } = await import('../server/agent.js');
const { generateKit } = await import('../server/kit.js');
const { sendInvites, setShortlist } = await import('../server/outreach.js');
const { renderMd } = await import('../public/js/md.js');

dbm.loadDb();
const job = dbm.newJob('Backend Engineer');
dbm.db().jobs.push(job);

console.log('\nParsing and redaction');
await test('parses name, email and phone from a resume', async () => {
  const p = await parseResume({ originalname: 'priya.txt', buffer: Buffer.from(RESUMES.priya) });
  assert.equal(p.name, 'Priya Sharma');
  assert.equal(p.email, 'priya.sharma@example.com');
  assert.match(p.phone, /98765/);
  assert.ok(p.lines.length >= 8);
});
await test('falls back to the file name when no name line exists', async () => {
  const p = await parseResume({ originalname: 'arun_kumar_resume_final.txt', buffer: Buffer.from('Software developer with years of experience.\nBuilt systems and shipped products across many teams.\nSkills: Go, Rust, Linux, networking and distributed systems design.') });
  assert.equal(p.name, 'Arun Kumar');
});
await test('rejects files without readable text', async () => {
  await assert.rejects(() => parseResume({ originalname: 'x.txt', buffer: Buffer.from('hi') }), /No readable text/);
  await assert.rejects(() => parseResume({ originalname: 'x.exe', buffer: Buffer.from('hi') }), /Unsupported/);
});
await test('phone detection ignores year ranges', () => {
  assert.equal(detectContact('Worked 2019-2021 and 2015 2017').phone, '');
  assert.equal(maskContact('Call +91 98765 43210 or mail a@b.co'), 'Call [PHONE] or mail [EMAIL]');
});
await test('long lines are wrapped and blank lines dropped', () => {
  const lines = normalizeLines(`a\n\n\n${'word. '.repeat(120)}`);
  assert.equal(lines[0], 'a');
  assert.ok(lines.length > 2 && lines.every((l) => l.length <= 400));
});

const cands = {};
for (const [key, text] of Object.entries(RESUMES)) {
  const parsed = await parseResume({ originalname: `${key}.txt`, buffer: Buffer.from(text) });
  const c = dbm.newCandidate(job, { ...parsed, fileName: `${key}.txt` });
  job.candidates.push(c);
  cands[key] = c;
}

await test('standard redaction keeps the name but hides contact details', () => {
  const red = redactLines(cands.priya.lines, cands.priya, { name: 'keep', identity: false }).join('\n');
  assert.ok(red.includes('Priya') || red.includes('PRIYA'.slice(0, 1)));
  assert.ok(!red.includes('@example.com') && !red.includes('98765') && !red.includes('linkedin.com'));
  assert.ok(red.includes('Anna University'));
});
await test('blind redaction hides name, school, years, gender cues; keeps line count', () => {
  const red = redactLines(cands.priya.lines, cands.priya, { name: 'mask', identity: true });
  const text = red.join('\n');
  assert.equal(red.length, cands.priya.lines.length);
  assert.ok(!/priya|sharma/i.test(text), 'name still visible');
  assert.ok(!text.includes('Anna University'), 'school still visible');
  assert.ok(!text.includes('2018'), 'graduation year still visible');
  assert.ok(!/\bshe\b/i.test(text) && !text.includes('Gender: Female'));
  assert.ok(text.includes('Python'), 'skills must survive');
});
await test('alias map hides names (full and first) and restores them', () => {
  const am = aliasMap(job.candidates);
  const aliased = am.toAlias('Compare Priya Sharma with Rahul. Mail meera.nair@example.com');
  assert.equal(aliased, 'Compare Candidate-1 with Candidate-2. Mail [EMAIL]');
  assert.deepEqual(am.idsIn(aliased), [cands.priya.id, cands.rahul.id]);
  assert.equal(am.fromAlias('Candidate-3 is strong', (c) => c.name), 'Meera Nair is strong');
  assert.equal(am.fromAlias('Candidate-3 is strong', (c) => c.label), 'Candidate C is strong');
});

console.log('\nRetrieval');
await test('chunks cover every line', () => {
  const chunks = chunkLines(cands.priya.lines, 120);
  const seen = new Set();
  chunks.forEach((c) => { for (let i = c.from; i <= c.to; i += 1) seen.add(i); });
  assert.equal(seen.size, cands.priya.lines.length);
});
await test('retrieval finds the relevant resume first', async () => {
  const hits = await retrieve(job.candidates, 'python machine learning fraud detection', { total: 3 });
  assert.equal(hits[0].cand.id, cands.priya.id);
  const react = await retrieve(job.candidates, 'react component library', { total: 1 });
  assert.equal(react[0].cand.id, cands.meera.id);
});
await test('embeddings are rebuilt when the model tag changes', async () => {
  cands.rahul.embedTag = 'old-model';
  await ensureEmbeddings(cands.rahul);
  assert.equal(cands.rahul.embedTag, 'hash-512');
});

console.log('\nScoring');
await test('JSON parsing tolerates fences and chatter', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! {"a": 2} hope that helps'), { a: 2 });
  assert.throws(() => parseJsonLoose('nope'), /unreadable/);
});
await test('verdict thresholds', () => {
  assert.deepEqual([90, 80, 79, 65, 64, 45, 44].map(verdictFor), ['strong', 'strong', 'good', 'good', 'partial', 'partial', 'weak']);
});
await test('evidence is verified, repaired or flagged', () => {
  const red = ['Header line', 'Built a fraud detection pipeline in Python that cut chargebacks', 'Led a team of four engineers', 'Skills: Python, Docker'];
  const ev = normalizeEval(
    {
      score: 140,
      summary: 'ok',
      strengths: [
        { point: 'good quote, good line', lines: [2], quote: 'Built a fraud detection pipeline in Python' },
        { point: 'good quote, wrong line', lines: [4], quote: 'Led a team of four engineers' },
        { point: 'invented', lines: [1], quote: 'Won the global innovation award in twenty twenty one' },
        { point: 'no quote', lines: [2], quote: '' },
      ],
      weaknesses: [{ point: 'missing sql', lines: [], quote: '' }],
      coverage: [{ requirement: 'Python', status: 'bogus', lines: ['L2', '3-4'] }],
    },
    {},
    red,
    'standard',
  );
  assert.equal(ev.score, 100);
  assert.equal(ev.verdict, 'strong');
  assert.deepEqual([ev.strengths[0].verified, ev.strengths[1].verified, ev.strengths[2].verified, ev.strengths[3].verified], [true, true, false, false]);
  assert.deepEqual(ev.strengths[1].lines, [3], 'wrong line numbers should be repaired');
  assert.equal(ev.weaknesses[0].kind, 'gap');
  assert.deepEqual(ev.evidence, { verified: 2, total: 4 });
  assert.equal(ev.coverage[0].status, 'partial');
  assert.deepEqual(ev.coverage[0].lines, [2, 3, 4]);
  assert.throws(() => normalizeEval({ summary: 'no score' }, {}, red, 'standard'), /did not return a score/);
});
await test('requirements are extracted from the job description', async () => {
  job.jd = 'We need a backend engineer with Python, machine learning, SQL and team leadership skills. AWS is a plus.';
  job.requirements = await extractRequirements(job);
  assert.equal(job.requirements.must_have.length, 4);
});

await test('ranking scores everyone in both modes and the prompts respect privacy', async () => {
  calls.length = 0;
  const task = startRank(job, ['standard', 'blind']);
  assert.equal(task.total, 6);
  for (let i = 0; i < 100 && getTask(job.id).status === 'running'; i += 1) await sleep(50);
  const t = getTask(job.id);
  assert.equal(t.status, 'done');
  assert.equal(t.errors.length, 0, JSON.stringify(t.errors));
  for (const c of job.candidates) assert.ok(job.evals[c.id].standard && job.evals[c.id].blind);
  assert.equal(job.evals[cands.priya.id].standard.score, 88);
  assert.equal(job.evals[cands.priya.id].standard.evidence.total, 2);
  assert.equal(job.evals[cands.priya.id].standard.evidence.verified, 1, 'the invented award must be flagged');

  const scoring = calls.filter((c) => c.sys.includes('careful, fair resume screener'));
  assert.equal(scoring.length, 6);
  for (const c of scoring) assert.ok(!/@example\.com|98765|91234|99887|linkedin/.test(c.user), 'contact details leaked');
  const blind = scoring.filter((c) => c.user.includes('[CANDIDATE]') || !/Priya|Rahul|Meera/i.test(c.user));
  for (const c of blind.slice(-3)) assert.ok(!/Priya|Sharma|Rahul|Verma|Meera|Nair|Anna University|Christ College|Madras/.test(c.user), 'identity leaked in blind prompt');
  assert.ok(scoring.slice(0, 3).some((c) => /Priya/i.test(c.user)), 'standard prompts keep names for the bias comparison');
});
await test('starting a second run while one is active is refused', async () => {
  startRank(job, ['standard'], { force: true });
  assert.throws(() => startRank(job, ['standard'], { force: true }), /already running/);
  for (let i = 0; i < 100 && getTask(job.id).status === 'running'; i += 1) await sleep(50);
});
await test('bias comparison flags big shifts', () => {
  const b = compareModes(job);
  assert.equal(b.compared, 3);
  assert.equal(b.status, 'stable');
  job.evals[cands.meera.id].blind.score = 70;
  const b2 = compareModes(job);
  assert.equal(b2.status, 'review');
  assert.ok(b2.rows.find((r) => r.id === cands.meera.id).flagged);
  job.evals[cands.meera.id].blind.score = 40;
});

console.log('\nAssistant');
const lastText = async (msg) => {
  const out = await handleChat(job.id, msg);
  return out[1];
};
await test('answers questions with citations, without leaking names or emails to the model', async () => {
  calls.length = 0;
  mock.classify = '{"intent":"qa","count":null}';
  const reply = await lastText('Does Priya Sharma (priya.sharma@example.com) have Python experience?');
  const qa = calls.find((c) => c.sys.startsWith('You are an HR screening assistant'));
  assert.ok(qa, 'answer prompt was sent');
  assert.ok(!/Priya|Sharma|priya\.sharma/.test(qa.user + qa.sys), 'real identity reached the model');
  assert.ok(/Candidate-1/.test(qa.user));
  assert.match(reply.text, /^Priya Sharma has the strongest Python background \[\[c:[\w-]+:5-6\]\]\./);
});
await test('blind mode shows labels instead of names in the chat history', () => {
  job.blind = true;
  const msgs = chatForClient(job);
  const joined = msgs.map((m) => m.text).join('\n');
  assert.ok(!/Priya|Sharma|priya\.sharma/.test(joined));
  assert.match(joined, /Candidate A has the strongest Python background/);
  job.blind = false;
});
await test('shortlists the top N by score', async () => {
  mock.classify = '{"intent":"shortlist","count":2}';
  const reply = await lastText('shortlist the top 2');
  assert.deepEqual(new Set(job.shortlist), new Set([cands.priya.id, cands.rahul.id]));
  assert.match(reply.text, /Shortlisted Priya Sharma, Rahul Verma/);
  assert.equal(cands.priya.status, 'shortlisted');
});
await test('email flow asks, previews, waits for approval, then logs when SMTP is off', async () => {
  mock.classify = '{"intent":"email","count":null}';
  let r = await lastText('email the shortlisted candidates');
  assert.equal(r.ui.type, 'choices');
  mock.classify = '{"intent":"qa","count":null}';
  r = await lastText('standard');
  assert.equal(r.ui.type, 'email_preview');
  assert.equal(r.ui.ids.length, 2);
  assert.match(r.ui.body, /{{first_name}}/);
  assert.equal(cands.priya.status, 'shortlisted', 'nothing may be sent before approval');
  const results = await sendInvites(job, r.ui.ids, r.ui.subject, r.ui.body);
  assert.deepEqual(results.map((x) => x.status), ['simulated', 'simulated']);
  assert.equal(cands.priya.status, 'invite-logged');
  assert.equal(job.chatState, null);
  assert.ok(chatForClient(job).filter((m) => m.ui && m.ui.type === 'email_preview').every((m) => m.ui.consumed));
  assert.match(job.emails.at(-1).subject, /Interview invitation: Backend Engineer/);
});
await test('custom email text and cancelling', async () => {
  mock.classify = '{"intent":"email","count":null}';
  await lastText('email Priya');
  let r = await lastText('custom');
  assert.match(r.text, /Send me the email text/);
  r = await lastText('Hello {{first_name}}, please call us.');
  assert.equal(r.ui.type, 'email_preview');
  assert.equal(r.ui.body, 'Hello {{first_name}}, please call us.');
  cancelPending(job);
  assert.equal(job.chatState, null);
});
await test('rendering fills in each person\'s details', () => {
  const vars = templateVars(cands.priya, job, { company: 'Acme', senderName: 'Dana' });
  assert.equal(renderTemplate('Hi {{first_name}} from {{ company }} / {{role}} / {{sender}} {{unknown}}', vars), 'Hi Priya from Acme / Backend Engineer / Dana ');
  assert.ok(isEmail('a@b.co') && !isEmail('nope') && !isEmail('a b@c.de'));
});
await test('removing candidates from the shortlist by chat', async () => {
  mock.classify = '{"intent":"unshortlist","count":null}';
  await lastText('remove Rahul from the shortlist');
  assert.deepEqual(job.shortlist, [cands.priya.id]);
});
await test('interview kit is generated from alias-only text and stored', async () => {
  calls.length = 0;
  const kit = await generateKit(job, cands.priya);
  assert.ok(kit.questions.length >= 5 && kit.scorecard.length >= 4);
  const prompt = calls.find((c) => c.sys.startsWith('You design structured interviews'));
  assert.ok(!/Priya|Sharma|priya\.sharma|98765/.test(prompt.user), 'kit prompt leaked identity');
  assert.ok(job.kits[cands.priya.id]);
});
await test('model failures become readable chat messages', async () => {
  mock.failAll = 401;
  mock.classify = '{"intent":"qa","count":null}';
  const r = await lastText('Who knows Java?');
  mock.failAll = 0;
  assert.match(r.text, /rejected the API key/);
});
await test('shortlist helper adds and removes', () => {
  setShortlist(job, cands.meera.id, true);
  assert.ok(job.shortlist.includes(cands.meera.id));
  setShortlist(job, cands.meera.id, false);
  assert.ok(!job.shortlist.includes(cands.meera.id));
});

console.log('\nInterface helpers');
await test('markdown renders lists, tables, bold and citation chips safely', () => {
  const html = renderMd('**Top pick**\n- one <b>x</b>\n- two [[c:abc-1:5-6]]\n\n| A | B |\n|---|---|\n| 1 | 2 |', (id, a, b) => `<i>${id}:${a}-${b}</i>`);
  assert.match(html, /<strong>Top pick<\/strong>/);
  assert.match(html, /<ul><li>one &lt;b&gt;x&lt;\/b&gt;<\/li><li>two <i>abc-1:5-6<\/i><\/li><\/ul>/);
  assert.match(html, /<table>.*<th>A<\/th>.*<td>2<\/td>/);
});

dbm.flush();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`Failed: ${failures.join('; ')}`);
  process.exit(1);
}
process.exit(0);
