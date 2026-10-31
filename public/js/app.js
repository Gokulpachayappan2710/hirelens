import { api } from './api.js';
import { I } from './icons.js';
import { $, $$, esc, fmtDate, toast, renderTemplate } from './util.js';
import { renderMd } from './md.js';

/* ====================================================================
   State
   ==================================================================== */
const S = {
  health: null,
  settings: null,
  jobs: [],
  job: null,
  tab: 'role',
  drawer: null,
  modal: null,
  chat: [],
  chatBusy: false,
  uploading: false,
  filters: { q: '', min: 0, verdict: 'all', sort: 'score' },
  biasOpen: true,
  poller: null,
};

const mode = () => (S.job && S.job.blind ? 'blind' : 'standard');
const nm = (c) => (S.job.blind ? c.label : c.name);
const cand = (id) => S.job.candidates.find((c) => c.id === id);
const evalOf = (c) => (S.job.evals[c.id] && S.job.evals[c.id][mode()]) || null;
const jobUrl = (suffix = '') => `/api/jobs/${S.job.id}${suffix}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const run = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    toast((err && err.message) || 'Something went wrong.', 'error');
  }
};
const isRunning = () => Boolean(S.job && S.job.task && S.job.task.status === 'running');
const VERDICT = { strong: 'Strong match', good: 'Good match', partial: 'Partial match', weak: 'Weak match' };

/* ====================================================================
   Rail, header, tabs
   ==================================================================== */
function renderRail() {
  const h = S.health;
  const dot = (ok, warn) => `<i class="dot ${ok ? 'ok' : warn ? 'warn' : ''}"></i>`;
  $('#rail').innerHTML = `
    <div class="brand"><span class="brand-mark">${I.logo}</span><span>Hirelens</span></div>
    <button class="btn primary block" data-act="newRole">${I.plus}<span>New role</span></button>
    <div class="rail-title">Roles</div>
    <nav class="roles">
      ${
        S.jobs.length
          ? S.jobs
              .map(
                (j) => `<button class="role ${S.job && j.id === S.job.id ? 'on' : ''}" data-act="openJob" data-id="${j.id}">
                  <span class="role-name">${esc(j.title)}</span>
                  <span class="role-meta">${j.candidates}</span>
                </button>`,
              )
              .join('')
          : '<p class="rail-empty">No roles yet.</p>'
      }
    </nav>
    <div class="rail-foot">
      ${
        h
          ? `<div class="status">
              <span>${dot(h.llm.configured)}${h.llm.configured ? 'Groq connected' : 'Groq key missing'}</span>
              <span>${dot(h.smtp.configured, true)}${h.smtp.configured ? 'Email ready' : 'Email simulated'}</span>
            </div>`
          : ''
      }
      <button class="btn block" data-act="openSettings">${I.sliders}<span>Settings</span></button>
    </div>`;
}

function banners() {
  if (S.health && !S.health.llm.configured) {
    return `<div class="banner bad">${I.alert}<div><strong>Groq API key missing.</strong> Scoring and the assistant need a free key. Add <code>GROQ_API_KEY</code> to the <code>.env</code> file and restart the app.</div></div>`;
  }
  return '';
}

function renderHead() {
  const j = S.job;
  if (!j) return;
  $('#head').innerHTML = `
    <div>
      <h1>${esc(j.title)}</h1>
      <div class="head-meta"><span>${plural(j.candidates.length, 'candidate')}</span><span>${j.shortlist.length} shortlisted</span></div>
    </div>
    <div class="head-actions">
      <label class="switch" title="Hide names, schools, gender cues and contact details while you screen">
        <input type="checkbox" data-on="blind" ${j.blind ? 'checked' : ''}>
        <span class="track"></span>
        <span class="switch-label">${j.blind ? I.eyeOff : I.eye}Blind screening</span>
      </label>
      <button class="icon-btn" data-act="deleteRole" title="Delete this role" aria-label="Delete this role">${I.trash}</button>
    </div>`;
}

function renderTabs() {
  const j = S.job;
  if (!j) return;
  const tabs = [
    ['role', 'Role', ''],
    ['candidates', 'Candidates', j.candidates.length || ''],
    ['assistant', 'Assistant', ''],
    ['shortlist', 'Shortlist', j.shortlist.length || ''],
  ];
  $('#tabs').innerHTML = tabs
    .map(
      ([id, label, n]) =>
        `<button class="tab ${S.tab === id ? 'on' : ''}" role="tab" aria-selected="${S.tab === id}" data-act="tab" data-tab="${id}">${label}${n !== '' ? `<span class="count">${n}</span>` : ''}</button>`,
    )
    .join('');
}

function renderMain() {
  const el = $('#main');
  if (!S.job) {
    el.innerHTML = `${banners()}
      <div class="panel empty" style="max-width:560px;margin:12vh auto 0">
        <h3>Start with a role</h3>
        <p>Add a job description, drop in resumes, and get a ranked shortlist where every strength points back to the line of the resume it came from.</p>
        <p style="margin-top:16px"><button class="btn primary" data-act="newRole">${I.plus}<span>New role</span></button></p>
      </div>`;
    return;
  }
  el.innerHTML = `${banners()}<header class="head" id="head"></header><nav class="tabs" id="tabs" role="tablist"></nav><section id="content"></section>`;
  renderHead();
  renderTabs();
  renderTab();
}

function renderTab() {
  const el = $('#content');
  if (!el || !S.job) return;
  if (S.tab === 'role') el.innerHTML = roleTab();
  else if (S.tab === 'candidates') {
    el.innerHTML = candidatesTab();
    renderTask();
    renderCandTable();
  } else if (S.tab === 'assistant') {
    el.innerHTML = assistantTab();
    renderChat();
  } else el.innerHTML = shortlistTab();
}

/* ====================================================================
   Role tab
   ==================================================================== */
function roleTab() {
  const j = S.job;
  const r = j.requirements;
  const chips = (list, soft) => (list.length ? `<div class="chips">${list.map((x) => `<span class="chip ${soft ? 'soft' : ''}">${esc(x)}</span>`).join('')}</div>` : '<p class="muted">None listed.</p>');
  const side = r
    ? `<div><h3 class="sec-title">Must have</h3>${chips(r.must_have)}</div>
       <div><h3 class="sec-title">Nice to have</h3>${chips(r.nice_to_have, true)}</div>
       <p class="hint">Every resume is scored against these. Weaknesses are flagged where one is missing.</p>`
    : j.jd
      ? '<h3 class="sec-title">Requirements</h3><p class="muted">They could not be read yet. Save the description again to retry.</p>'
      : '<h3 class="sec-title">Requirements</h3><p class="muted">The must-have skills and experience show up here once you save the job description.</p>';
  return `<div class="split">
    <section class="panel panel-pad stack">
      <div class="field"><label for="f-title">Role title</label><input id="f-title" type="text" maxlength="120" value="${esc(j.title)}"></div>
      <div class="field">
        <label for="f-jd">Job description</label>
        <textarea id="f-jd" rows="15" placeholder="Paste the job description: responsibilities, must-have skills, nice-to-haves.">${esc(j.jd)}</textarea>
        <p class="hint">Changing the text clears existing scores, because they no longer match the role.</p>
      </div>
      <div class="row-actions"><button class="btn primary" data-act="analyse" id="analyse-btn">${I.check}<span>Save and read requirements</span></button></div>
    </section>
    <aside class="panel panel-pad reqs">${side}</aside>
  </div>`;
}

const analyse = async (el) => {
  const title = $('#f-title').value.trim();
  const jd = $('#f-jd').value.trim();
  const label = el.querySelector('span');
  el.disabled = true;
  label.textContent = 'Reading requirements...';
  try {
    const res = await api.post(jobUrl('/analyse'), { title, jd });
    S.job = res.job;
    S.jobs = await api.get('/api/jobs');
    renderRail();
    if (res.warning) {
      toast(res.warning, 'error');
      renderMain();
    } else {
      toast(res.reset ? 'Requirements ready. Earlier scores were cleared.' : 'Requirements ready.', 'ok');
      S.tab = 'candidates';
      renderMain();
    }
  } finally {
    el.disabled = false;
    if (label.isConnected) label.textContent = 'Save and read requirements';
  }
};

/* ====================================================================
   Candidates tab
   ==================================================================== */
function dropHtml(big) {
  return `<div class="drop ${big ? 'big' : ''} ${S.uploading ? 'busy' : ''}" id="drop" data-act="pickFiles" tabindex="0" role="button" aria-label="Add resumes">
    ${I.upload}
    <strong>${S.uploading ? 'Reading resumes...' : 'Drop resumes here, or browse'}</strong>
    <span>PDF, DOCX or TXT, up to 8 MB each</span>
  </div>`;
}

function candidatesTab() {
  const j = S.job;
  const has = j.candidates.length > 0;
  const unscored = j.candidates.filter((c) => !evalOf(c)).length;
  const scored = j.candidates.length - unscored;
  const blindNote = j.blind
    ? `<div class="banner" style="background:var(--lagoon-tint);border-color:#b9d6d8">${I.eyeOff}<div><strong>Blind screening is on.</strong> Names, schools, years of study, gender cues and contact details are hidden from the scoring model and from this screen. Identities are shown again on the Shortlist tab.</div></div>`
      : '';
  return `
    <input type="file" id="file-input" multiple accept=".pdf,.docx,.txt,.md" hidden>
    ${!j.jd ? `<div class="banner">${I.alert}<div>Add the job description first so resumes can be scored against it. <button class="btn quiet" data-act="tab" data-tab="role">Open the role</button></div></div>` : ''}
    ${blindNote}
    ${has ? '' : dropHtml(true)}
    ${
      has
        ? `<div class="bar-top">
            <h2 class="sec-title" style="margin:0">${plural(j.candidates.length, 'candidate')}</h2>
            <div class="row-actions">
              ${scored && unscored ? `<button class="btn quiet" data-act="rank" data-force="1">${I.refresh}<span>Re-score all</span></button>` : ''}
              <button class="btn" data-act="biasCheck" title="Score everyone twice, with identity details visible and hidden, and compare">${I.eyeOff}<span>Bias check</span></button>
              <button class="btn primary" data-act="rank" data-force="${unscored ? '' : '1'}">${I.check}<span>${unscored ? (scored ? `Score ${unscored} new` : 'Score candidates') : 'Re-score all'}</span></button>
            </div>
          </div>
          ${dropHtml(false)}`
        : ''
    }
    <div class="task" id="task" hidden></div>
    <div id="bias">${biasHtml()}</div>
    ${
      has
        ? `<div class="filters">
            <div class="search">${I.search}<input type="text" data-filter="q" aria-label="Search" placeholder="${j.blind ? 'Search by label' : 'Search name or file'}" value="${esc(S.filters.q)}"></div>
            <label class="min">Minimum score <input type="range" min="0" max="100" step="5" data-filter="min" value="${S.filters.min}"><b id="min-val">${S.filters.min}</b></label>
            <select data-filter="verdict" aria-label="Verdict">
              ${[['all', 'All matches'], ['strong', 'Strong'], ['good', 'Good'], ['partial', 'Partial'], ['weak', 'Weak']].map(([v, l]) => `<option value="${v}" ${S.filters.verdict === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <select data-filter="sort" aria-label="Sort">
              ${[['score', 'Best score first'], ['name', 'Name'], ['added', 'Newest first']].map(([v, l]) => `<option value="${v}" ${S.filters.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="panel table-wrap" id="cand-table"></div>`
        : ''
    }`;
}

function renderTask() {
  const el = $('#task');
  if (!el) return;
  const t = S.job.task;
  if (!t || t.status !== 'running') {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  el.hidden = false;
  el.innerHTML = `<div class="task-line"><span class="spin"></span><span>${esc(t.note || 'Working')}</span><span class="muted">${t.done} of ${t.total}</span></div><div class="progress"><i style="width:${pct}%"></i></div>`;
}

function candidateRows() {
  const j = S.job;
  const m = mode();
  const all = j.candidates.map((c) => ({ c, e: (j.evals[c.id] && j.evals[c.id][m]) || null }));
  const order = all.filter((x) => x.e).sort((a, b) => b.e.score - a.e.score);
  const rankOf = new Map(order.map((x, i) => [x.c.id, i + 1]));
  const f = S.filters;
  const rows = all.filter((x) => {
    if (f.q) {
      const hay = (j.blind ? x.c.label : `${x.c.name} ${x.c.fileName}`).toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    if (f.min > 0 && (!x.e || x.e.score < f.min)) return false;
    if (f.verdict !== 'all' && (!x.e || x.e.verdict !== f.verdict)) return false;
    return true;
  });
  rows.sort((a, b) => {
    if (f.sort === 'name') return nm(a.c).localeCompare(nm(b.c));
    if (f.sort === 'added') return b.c.n - a.c.n;
    return (b.e ? b.e.score : -1) - (a.e ? a.e.score : -1) || a.c.n - b.c.n;
  });
  return { rows, rankOf };
}

function renderCandTable() {
  const el = $('#cand-table');
  if (!el) return;
  const { rows, rankOf } = candidateRows();
  if (!rows.length) {
    el.innerHTML = '<div class="empty"><h3>No candidates match</h3><p>Lower the minimum score or clear the search.</p></div>';
    return;
  }
  el.innerHTML = `<table class="cands">
    <thead><tr><th>#</th><th>Candidate</th><th>Match</th><th>Verdict</th><th>Summary</th><th>Evidence</th><th><span class="sr" style="position:absolute;left:-9999px">Shortlist</span></th></tr></thead>
    <tbody>
    ${rows
      .map(({ c, e }) => {
        const on = S.job.shortlist.includes(c.id);
        const ev = e && e.evidence;
        const full = ev && ev.total > 0 && ev.verified === ev.total;
        return `<tr class="row" data-act="openCand" data-id="${c.id}">
          <td class="c-rank">${rankOf.get(c.id) || ''}</td>
          <td class="c-name"><strong>${esc(nm(c))}</strong>${S.job.blind ? '' : `<span class="sub">${esc(c.fileName)}</span>`}</td>
          <td>${e ? `<div class="meter"><span class="num">${e.score}</span><span class="bar"><i class="v-${e.verdict}" style="width:${e.score}%"></i></span></div>` : '<span class="muted">Not scored</span>'}</td>
          <td>${e ? `<span class="pill ${e.verdict}">${VERDICT[e.verdict]}</span>` : ''}</td>
          <td><div class="c-sum">${e ? esc(e.summary) : ''}</div></td>
          <td class="c-ev ${full ? 'full' : ''}">${ev ? `${full ? I.check : ''}${ev.verified} of ${ev.total} checked` : ''}</td>
          <td><button class="star ${on ? 'on' : ''}" data-act="star" data-id="${c.id}" title="${on ? 'Remove from shortlist' : 'Add to shortlist'}" aria-label="${on ? 'Remove from shortlist' : 'Add to shortlist'}" aria-pressed="${on}">${I.star}</button></td>
        </tr>`;
      })
      .join('')}
    </tbody></table>`;
}

function biasHtml() {
  const b = S.job.bias;
  if (!b) return '';
  const rows = b.rows
    .map((r) => ({ ...r, c: cand(r.id) }))
    .filter((r) => r.c)
    .sort((x, y) => x.rankStd - y.rankStd);
  const headline =
    b.status === 'stable'
      ? 'Rankings held steady when identity details were hidden.'
      : `Hiding identity details moved ${b.flagged} of ${b.compared} candidates by 10 or more points, or 2 or more places.`;
  const detail =
    b.status === 'stable'
      ? `Average score change was ${b.avgAbsDelta} points across ${b.compared} candidates.`
      : 'Read those resumes again before deciding. Flagged rows are marked on the left.';
  const partial = b.compared < b.total ? ` Only ${b.compared} of ${b.total} candidates have been scored both ways.` : '';
  const shift = (n) => (n === 0 ? 'No change' : n > 0 ? `Up ${n}` : `Down ${-n}`);
  return `<section class="panel bias ${b.status}">
    <div class="bias-head">
      <span class="bias-flag"></span>
      <div style="flex:1"><h3>${esc(headline)}</h3><p>${esc(detail + partial)} This compares two model runs, so treat it as a signal to look closer, not as proof either way.</p></div>
      <button class="btn quiet" data-act="toggleBias">${S.biasOpen ? 'Hide details' : 'Show details'}</button>
    </div>
    ${
      S.biasOpen
        ? `<div class="table-wrap"><table>
          <thead><tr><th>Candidate</th><th>Identity visible</th><th>Identity hidden</th><th>Score change</th><th>Rank change</th></tr></thead>
          <tbody>${rows
            .map(
              (r) => `<tr class="${r.flagged ? 'flag' : ''}">
              <td>${esc(nm(r.c))}</td>
              <td class="n"><div class="pair"><span>${r.std} <span class="muted">(#${r.rankStd})</span></span><span class="bar"><i style="width:${r.std}%"></i></span></div></td>
              <td class="n"><div class="pair"><span>${r.blind} <span class="muted">(#${r.rankBlind})</span></span><span class="bar b"><i style="width:${r.blind}%"></i></span></div></td>
              <td class="n delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}">${r.delta > 0 ? '+' : ''}${r.delta}</td>
              <td>${shift(r.shift)}</td>
            </tr>`,
            )
            .join('')}</tbody></table></div>`
        : ''
    }
  </section>`;
}

/* ---------- uploads ---------- */
async function uploadFiles(files) {
  const list = [...files];
  if (!list.length || S.uploading) return;
  const fd = new FormData();
  list.forEach((f) => fd.append('files', f, f.name));
  S.uploading = true;
  if ($('#drop')) $('#drop').outerHTML = dropHtml(!S.job.candidates.length);
  try {
    const res = await api.upload(jobUrl('/resumes'), fd);
    S.job = res.job;
    if (res.added.length) toast(`Added ${plural(res.added.length, 'resume')}.`, 'ok');
    res.errors.slice(0, 4).forEach((e) => toast(`${e.file}: ${e.error}`, 'error'));
    S.jobs = await api.get('/api/jobs');
    renderRail();
  } finally {
    S.uploading = false;
    renderHead();
    renderTabs();
    if (S.tab === 'candidates') renderTab();
  }
}

/* ---------- scoring ---------- */
async function startScoring(body) {
  if (isRunning()) return toast('Scoring is already running.');
  const r = await api.post(jobUrl('/rank'), body);
  S.job.task = r.task;
  if (r.task.status !== 'running') {
    S.job = await api.get(jobUrl());
    renderHead();
    if (S.tab === 'candidates') renderTab();
    toast('Everything is already scored.');
    return;
  }
  renderTask();
  watchTask();
}

function watchTask() {
  clearInterval(S.poller);
  const jid = S.job.id;
  if (!isRunning()) return;
  S.poller = setInterval(
    run(async () => {
      if (!S.job || S.job.id !== jid) return clearInterval(S.poller);
      const r = await api.get(`/api/jobs/${jid}/task`);
      S.job.task = r.task;
      if (!r.task || r.task.status !== 'running') {
        clearInterval(S.poller);
        await finishTask(jid, r.task);
      } else {
        renderTask();
      }
    }),
    1200,
  );
}

async function finishTask(jid, task) {
  const fresh = await api.get(`/api/jobs/${jid}`);
  if (!S.job || S.job.id !== jid) return;
  S.job = fresh;
  if (task && task.errors && task.errors.length) {
    toast(`${plural(task.errors.length, 'candidate')} could not be scored. ${task.errors[0].error}`, 'error');
  } else {
    toast('Scoring finished.', 'ok');
  }
  renderHead();
  renderTabs();
  if (S.tab === 'candidates') renderTab();
}

/* ====================================================================
   Candidate drawer (resume text with evidence highlighting)
   ==================================================================== */
async function openCand(id, hl) {
  S.drawer = { id, data: null, hl: hl || null };
  renderDrawer();
  const d = await api.get(jobUrl(`/candidates/${id}?blind=${S.job.blind ? 1 : 0}`));
  if (!S.drawer || S.drawer.id !== id) return;
  S.drawer.data = d;
  renderDrawer();
  if (hl) highlightLines(hl[0], hl[1]);
}

function highlightLines(a, b) {
  const box = $('#rtext');
  if (!box) return;
  $$('.rl.hl', box).forEach((n) => n.classList.remove('hl'));
  let first = null;
  for (let n = a; n <= b; n += 1) {
    const li = box.querySelector(`[data-n="${n}"]`);
    if (li) {
      li.classList.add('hl');
      first = first || li;
    }
  }
  if (first) box.scrollTop = Math.max(0, first.offsetTop - box.offsetTop - 60);
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderDrawer() {
  const root = $('#drawer-root');
  if (!S.drawer) {
    root.innerHTML = '';
    return;
  }
  const c = cand(S.drawer.id);
  const d = S.drawer.data;
  if (!c) {
    S.drawer = null;
    root.innerHTML = '';
    return;
  }
  const e = evalOf(c);
  const on = S.job.shortlist.includes(c.id);
  const lineAt = (ls) => {
    const t = ls.map((n) => (d ? d.lines[n - 1] : '') || '').join(' ');
    return t.length > 260 ? `${t.slice(0, 257)}...` : t;
  };
  const range = (ls) => [Math.min(...ls), Math.max(...ls)];
  const lbl = ([a, b]) => (a === b ? `L${a}` : `L${a}\u2013${b}`);
  const item = (it) => {
    const gap = it.kind === 'gap';
    const r = it.verified && it.lines.length ? range(it.lines) : null;
    return `<li class="${gap ? 'gap' : ''}">
      <div class="pt">${esc(it.point)}</div>
      ${r && d ? `<div class="src">${esc(lineAt(it.lines))}</div>` : ''}
      <div class="meta">
        ${gap ? '<span>Not found in the resume</span>' : r ? `<button class="lines" data-act="hl" data-from="${r[0]}" data-to="${r[1]}">${lbl(r)}</button>` : ''}
        ${gap ? '' : it.verified ? `<span class="ok-tag">${I.check}Matches the resume</span>` : `<span class="warn-tag">${I.alert}Could not be matched to the resume</span>`}
      </div></li>`;
  };
  const cited = new Set();
  if (e) {
    [...e.strengths, ...e.weaknesses].forEach((x) => x.verified && x.lines.forEach((n) => cited.add(n)));
    e.coverage.forEach((x) => x.lines.forEach((n) => cited.add(n)));
  }
  const body = !d
    ? '<p class="muted">Loading the resume...</p>'
    : `${
        e
          ? `<section>
              <div class="scoreline"><span class="big">${e.score}</span>
                <div><span class="pill ${e.verdict}">${VERDICT[e.verdict]}</span><div class="bar"><i class="v-${e.verdict}" style="width:${e.score}%"></i></div>
                <span class="hint">${e.evidence.verified} of ${e.evidence.total} cited sources matched the resume</span></div></div>
              <p style="margin-top:12px">${esc(e.summary)}</p>
            </section>
            ${
              e.coverage.length
                ? `<section><h3>Requirements</h3><ul class="cover">${e.coverage
                    .map(
                      (x) => `<li><span class="mark ${x.status}">${x.status === 'met' ? I.check : x.status === 'partial' ? '\u2013' : I.x}</span>
                      <span>${esc(x.requirement)}${x.lines.length ? ` <button class="lines" data-act="hl" data-from="${range(x.lines)[0]}" data-to="${range(x.lines)[1]}">${lbl(range(x.lines))}</button>` : ''}</span></li>`,
                    )
                    .join('')}</ul></section>`
                : ''
            }
            <section><h3>Strengths</h3><ul class="evid">${e.strengths.map(item).join('') || '<li class="gap">None found.</li>'}</ul></section>
            <section><h3>Gaps and concerns</h3><ul class="evid">${e.weaknesses.map(item).join('') || '<li class="gap">None found.</li>'}</ul></section>`
          : `<section class="panel panel-pad"><p><strong>Not scored yet.</strong></p><p class="muted">Use Score candidates on the Candidates tab. You can still read the resume below.</p></section>`
      }
      ${
        S.job.blind
          ? ''
          : `<section><h3>Contact details</h3><div class="contact">
              <div class="field"><label for="ed-name">Name</label><input id="ed-name" type="text" value="${esc(c.name)}"></div>
              <div class="field"><label for="ed-email">Email</label><input id="ed-email" type="email" value="${esc(c.email)}" placeholder="Needed to send invitations"></div>
              <button class="btn" data-act="saveCand" data-id="${c.id}">Save</button></div></section>`
      }
      <section><h3>Resume text${S.job.blind ? ' (identity hidden)' : ''}</h3>
        <ol class="rtext" id="rtext">${d.lines.map((t, i) => `<li class="rl ${cited.has(i + 1) ? 'cited' : ''}" data-n="${i + 1}"><span class="ln">${i + 1}</span><span class="lt">${esc(t)}</span></li>`).join('')}</ol>
        <p class="hint" style="margin-top:8px">Line numbers in blue are cited as evidence. Select a line reference above to highlight it here.</p>
      </section>`;

  root.innerHTML = `<div class="scrim" data-act="closeDrawer"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="Candidate details">
      <header class="drawer-head">
        <div><h2>${esc(nm(c))}</h2><p class="muted">${S.job.blind ? 'Identity hidden' : esc(c.email || 'No email on file')}</p></div>
        <button class="icon-btn" data-act="closeDrawer" aria-label="Close">${I.x}</button>
      </header>
      <div class="drawer-body">${body}</div>
      <footer class="drawer-foot">
        <button class="btn ${on ? '' : 'primary'}" data-act="star" data-id="${c.id}">${I.star}<span>${on ? 'Remove from shortlist' : 'Add to shortlist'}</span></button>
        <button class="btn" data-act="kit" data-id="${c.id}">${I.file}<span>Interview kit</span></button>
        ${S.job.blind ? '' : `<button class="btn quiet" data-act="removeCand" data-id="${c.id}" style="margin-left:auto">${I.trash}<span>Remove</span></button>`}
      </footer>
    </aside>`;
}

/* ====================================================================
   Assistant tab
   ==================================================================== */
function assistantTab() {
  return `<div class="chat">
    <div class="chat-log" id="chat-log" aria-live="polite"></div>
    <form class="composer" id="chat-form" autocomplete="off">
      <textarea id="chat-input" rows="1" aria-label="Message" placeholder="Ask about the candidates, or say what to do next"></textarea>
      <button class="btn primary" type="submit">${I.send}<span>Send</span></button>
    </form>
  </div>`;
}

const chipHtml = (id, a, b) => {
  const c = cand(id);
  if (!c) return '';
  return `<button class="cite" data-act="cite" data-id="${id}" data-from="${a}" data-to="${b}" title="Open the resume at these lines">${esc(nm(c))} L${a}${b !== a ? `\u2013${b}` : ''}</button>`;
};

function msgHtml(m, idx) {
  if (m.role === 'user') return `<div class="msg me"><div class="bubble">${esc(m.text)}</div></div>`;
  const last = idx === S.chat.length - 1 && !S.chatBusy;
  let extra = '';
  const ui = m.ui;
  if (ui && (ui.type === 'choices' || ui.type === 'actions') && last) {
    extra = `<div class="quick">${ui.options.map((o) => `<button class="chip-btn" data-act="chatQuick" data-send="${esc(o.send)}">${esc(o.label)}</button>`).join('')}</div>`;
  } else if (ui && ui.type === 'kit_links') {
    extra = `<div class="quick">${ui.ids
      .map((id) => cand(id))
      .filter(Boolean)
      .map((c) => `<button class="chip-btn" data-act="kit" data-id="${c.id}">${I.file} Open kit for ${esc(nm(c))}</button>`)
      .join('')}</div>`;
  } else if (ui && ui.type === 'email_preview') {
    if (ui.consumed) {
      extra = '<p class="hint">This draft has been sent or cancelled.</p>';
    } else {
      const names = ui.ids.map((id) => cand(id)).filter(Boolean).map((c) => c.name);
      extra = `<div class="panel mailcard" data-card="${m.id}">
        <div class="to">To ${plural(names.length, 'candidate')}: ${esc(names.join(', '))}</div>
        <input type="text" class="mc-subject" aria-label="Subject" value="${esc(ui.subject)}">
        <textarea class="mc-body" rows="10" aria-label="Message">${esc(ui.body)}</textarea>
        <p class="hint">Placeholders like {{first_name}} are filled in for each candidate.</p>
        <div class="row-actions" style="justify-content:flex-end">
          <button class="btn" data-act="emailCancel">Cancel</button>
          <button class="btn primary" data-act="emailSend" data-msg="${m.id}">${I.send}<span>Send ${plural(names.length, 'email')}</span></button>
        </div></div>`;
    }
  }
  return `<div class="msg ai"><div class="bubble md">${renderMd(m.text, chipHtml)}</div>${extra}</div>`;
}

function renderChat() {
  const el = $('#chat-log');
  if (!el) return;
  if (!S.chat.length && !S.chatBusy) {
    const has = S.job.candidates.length > 0;
    el.innerHTML = `<div class="suggest">
      <h3>${has ? 'Ask about your candidates' : 'Add resumes to get started'}</h3>
      <p class="muted">${has ? 'Answers cite the resume lines they come from. You approve every email before it goes out.' : 'Upload resumes on the Candidates tab, then come back to ask questions, compare people and shortlist.'}</p>
      ${
        has
          ? `<div class="quick" style="justify-content:center">${[
              'Who has the strongest hands-on experience for this role?',
              'Compare the top 3 candidates',
              'Which candidates are missing a must-have skill?',
              'Shortlist the top 3',
            ]
              .map((q) => `<button class="chip-btn" data-act="chatQuick" data-send="${esc(q)}">${esc(q)}</button>`)
              .join('')}</div>`
          : ''
      }
    </div>`;
    return;
  }
  el.innerHTML =
    S.chat.map(msgHtml).join('') +
    (S.chatBusy ? '<div class="msg ai"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>' : '');
  el.scrollTop = el.scrollHeight;
}

async function sendChat(text) {
  const msg = String(text || '').trim();
  if (!msg || S.chatBusy) return;
  S.chat.push({ id: `tmp${Date.now()}`, role: 'user', text: msg });
  S.chatBusy = true;
  renderChat();
  try {
    const res = await api.post(jobUrl('/chat'), { message: msg });
    S.chat.pop();
    S.chat.push(...res.messages);
    S.job = res.job;
    renderHead();
    renderTabs();
    api.get('/api/jobs').then((j) => {
      S.jobs = j;
      renderRail();
    }).catch(() => {});
  } catch (err) {
    S.chat.push({ id: `err${Date.now()}`, role: 'assistant', text: err.message || 'That did not work. Please try again.' });
  } finally {
    S.chatBusy = false;
    renderChat();
  }
}

/* ====================================================================
   Shortlist tab, email compose, outbox
   ==================================================================== */
const STATUS = {
  new: ['Not contacted', 'neutral'],
  shortlisted: ['Shortlisted', 'good'],
  invited: ['Invited', 'strong'],
  'invite-logged': ['Invite logged, not sent', 'partial'],
};

function shortlistTab() {
  const j = S.job;
  const list = j.shortlist.map((id) => cand(id)).filter(Boolean);
  const m = mode();
  const items = list
    .map((c) => {
      const e = j.evals[c.id] && (j.evals[c.id][m] || j.evals[c.id].standard || j.evals[c.id].blind);
      const st = STATUS[c.status] || STATUS.new;
      return `<div class="sl-item">
        <div>
          <strong>${esc(c.name)}</strong>
          <div class="meta"><span>${esc(c.email || 'No email on file')}</span>${e ? `<span class="pill ${e.verdict}">${e.score} \u2013 ${VERDICT[e.verdict]}</span>` : ''}<span class="pill ${st[1]}">${st[0]}</span></div>
        </div>
        <div class="row-actions">
          <button class="btn" data-act="openCand" data-id="${c.id}">View</button>
          <button class="btn" data-act="kit" data-id="${c.id}">${I.file}<span>Interview kit</span></button>
          <button class="icon-btn" data-act="star" data-id="${c.id}" title="Remove from shortlist" aria-label="Remove from shortlist">${I.x}</button>
        </div>
      </div>`;
    })
    .join('');
  const outbox = j.emails.length
    ? `<section class="panel" style="margin-top:20px"><div class="panel-pad" style="padding-bottom:6px"><h3 class="sec-title" style="margin:0">Sent and logged emails</h3></div>
        <div class="table-wrap"><table class="outbox"><thead><tr><th>When</th><th>Candidate</th><th>Subject</th><th>Result</th></tr></thead><tbody>
        ${j.emails
          .map(
            (x) => `<tr><td>${esc(fmtDate(x.at))}</td><td>${esc(x.name)}</td><td>${esc(x.subject || '')}</td>
            <td><span class="pill ${x.status === 'sent' ? 'strong' : x.status === 'simulated' ? 'partial' : 'weak'}">${x.status === 'simulated' ? 'Logged only' : esc(x.status)}</span>${x.error ? ` <span class="hint">${esc(x.error)}</span>` : ''}</td></tr>`,
          )
          .join('')}
        </tbody></table></div></section>`
    : '';
  return `${j.blind ? `<div class="banner" style="background:var(--lagoon-tint);border-color:#b9d6d8">${I.eye}<div>Identities are shown here because these candidates have been shortlisted.</div></div>` : ''}
    <div class="bar-top">
      <h2 class="sec-title" style="margin:0">${plural(list.length, 'candidate')} shortlisted</h2>
      <div class="row-actions">
        ${list.length ? `<a class="btn" href="${jobUrl('/shortlist.csv')}">${I.download}<span>Export CSV</span></a>` : ''}
        <button class="btn primary" data-act="openCompose" ${list.length ? '' : 'disabled'}>${I.mail}<span>Email candidates</span></button>
      </div>
    </div>
    <section class="panel">
      ${list.length ? `<div class="sl-list">${items}</div>` : '<div class="empty"><h3>Nobody shortlisted yet</h3><p>Select the star next to a candidate, or ask the assistant to shortlist the top few.</p></div>'}
    </section>${outbox}`;
}

function mailVars(c) {
  const s = S.settings || {};
  return {
    first_name: String(c.name || '').trim().split(/\s+/)[0] || 'there',
    full_name: c.name,
    role: (S.job.requirements && S.job.requirements.title) || S.job.title,
    company: s.company || '',
    sender: s.senderName || '',
  };
}

function composeHtml(m) {
  const list = S.job.shortlist.map((id) => cand(id)).filter(Boolean);
  const first = m.ids.map((id) => cand(id)).filter(Boolean)[0];
  return `<div class="modal wide" role="dialog" aria-modal="true" aria-label="Email candidates">
    <h2>Email shortlisted candidates</h2>
    <div class="field"><span class="label">Recipients</span>
      <div class="recips">${list
        .map(
          (c) => `<label><input type="checkbox" data-recip="${c.id}" ${m.ids.includes(c.id) ? 'checked' : ''}> <span>${esc(c.name)}</span> <span class="addr">${esc(c.email || 'no email on file')}</span></label>`,
        )
        .join('')}</div></div>
    <div class="seg" role="group" aria-label="Message type">
      <button data-act="mailMode" data-mode="standard" class="${m.mode === 'standard' ? 'on' : ''}">Standard invitation</button>
      <button data-act="mailMode" data-mode="custom" class="${m.mode === 'custom' ? 'on' : ''}">Custom text</button>
    </div>
    <div class="field"><label for="m-subject">Subject</label><input type="text" id="m-subject" value="${esc(m.subject)}"></div>
    <div class="field"><label for="m-body">Message</label><textarea id="m-body" rows="10" placeholder="Write your message. Use {{first_name}} to personalise it.">${esc(m.body)}</textarea>
      <p class="hint">Placeholders {{first_name}}, {{full_name}}, {{role}}, {{company}} and {{sender}} are filled in for each person.</p></div>
    <div class="preview" id="m-preview">${first ? previewText(m, first) : ''}</div>
    <div class="modal-actions">
      <button class="btn" data-act="closeModal">Cancel</button>
      <button class="btn primary" data-act="sendCompose" id="m-send">${I.send}<span>Send ${plural(m.ids.length, 'email')}</span></button>
    </div>
  </div>`;
}

const previewText = (m, c) =>
  `<b>Preview for ${esc(c.name)}: ${esc(renderTemplate(m.subject, mailVars(c)))}</b>${esc(renderTemplate(m.body, mailVars(c)))}`;

function updateCompose() {
  const m = S.modal;
  if (!m || m.type !== 'compose') return;
  const first = m.ids.map((id) => cand(id)).filter(Boolean)[0];
  const prev = $('#m-preview');
  if (prev) prev.innerHTML = first ? previewText(m, first) : '<span class="muted">Choose at least one recipient.</span>';
  const send = $('#m-send span');
  if (send) send.textContent = `Send ${plural(m.ids.length, 'email')}`;
  const btn = $('#m-send');
  if (btn) btn.disabled = !m.ids.length;
}

/* ====================================================================
   Modals: new role, settings, compose, interview kit
   ==================================================================== */
function renderModal() {
  const root = $('#modal-root');
  const m = S.modal;
  if (!m) {
    root.innerHTML = '';
    return;
  }
  let inner = '';
  if (m.type === 'newRole') {
    inner = `<form class="modal" id="role-form" style="width:min(460px,100%)">
      <h2>New role</h2>
      <div class="field"><label for="n-title">Role title</label><input id="n-title" type="text" maxlength="120" placeholder="For example, Senior backend engineer" required></div>
      <div class="modal-actions"><button type="button" class="btn" data-act="closeModal">Cancel</button><button type="submit" class="btn primary">Create role</button></div>
    </form>`;
  } else if (m.type === 'settings') {
    const s = S.settings;
    const h = S.health;
    inner = `<div class="modal wide" role="dialog" aria-modal="true" aria-label="Settings">
      <h2>Settings</h2>
      <div class="kv">
        <div class="field"><label for="s-company">Company name</label><input id="s-company" type="text" value="${esc(s.company)}"></div>
        <div class="field"><label for="s-sender">Sender name</label><input id="s-sender" type="text" value="${esc(s.senderName)}"></div>
        <div class="field"><label for="s-reply">Reply-to address</label><input id="s-reply" type="email" value="${esc(s.replyTo)}" placeholder="Optional"></div>
      </div>
      <div class="field"><label for="s-subject">Standard email subject</label><input id="s-subject" type="text" value="${esc(s.standardEmail.subject)}"></div>
      <div class="field"><label for="s-body">Standard email message</label><textarea id="s-body" rows="9">${esc(s.standardEmail.body)}</textarea></div>
      <div class="statusbox">
        <div><span>Groq API key</span><b>${h.llm.configured ? 'Found' : 'Missing'}</b></div>
        <div><span>Language model</span><b>${esc(h.llm.model)}</b></div>
        <div><span>Embeddings</span><b>${h.embeddings.mode === 'model' ? esc(h.embeddings.model) : 'Keyword fallback (model not loaded)'}</b></div>
        <div><span>Agent engine</span><b>${esc(h.agent.engine)}</b></div>
        <div><span>Email</span><b>${h.smtp.configured ? 'SMTP configured' : 'Simulated (nothing is delivered)'}</b></div>
      </div>
      <div class="modal-actions"><button class="btn" data-act="closeModal">Close</button><button class="btn primary" data-act="saveSettings">Save settings</button></div>
    </div>`;
  } else if (m.type === 'compose') {
    inner = composeHtml(m);
  } else if (m.type === 'kit') {
    const c = cand(m.id);
    const k = m.kit;
    inner = `<div class="modal wide kit" role="dialog" aria-modal="true" aria-label="Interview kit">
      <div class="no-print row-actions" style="justify-content:flex-end">
        <button class="btn" data-act="regenKit" data-id="${m.id}">${I.refresh}<span>Regenerate</span></button>
        <button class="btn" data-act="print">${I.printer}<span>Print or save as PDF</span></button>
        <button class="icon-btn" data-act="closeModal" aria-label="Close">${I.x}</button>
      </div>
      <header><h2>Interview kit: ${esc(c ? nm(c) : 'Candidate')}</h2><p class="muted">${esc(k.role)}</p></header>
      ${k.focus.length ? `<section><h3 class="sec-title">Areas to probe</h3><div class="focus">${k.focus.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div></section>` : ''}
      <section><h3 class="sec-title">Questions</h3>
        <ol class="qs">${k.questions
          .map(
            (q) => `<li><span class="pill neutral">${esc(q.category)}</span>
              <div class="q">${esc(q.question)}</div>
              ${q.why ? `<div class="why">Why ask: ${esc(q.why)}</div>` : ''}
              ${q.listen_for.length ? `<ul>${q.listen_for.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
              ${q.follow_up ? `<div class="fu">Follow up: ${esc(q.follow_up)}</div>` : ''}</li>`,
          )
          .join('')}</ol></section>
      <section><h3 class="sec-title">Scorecard</h3>
        <table class="score-tbl"><thead><tr><th>Criterion</th><th>What to look for</th>${[1, 2, 3, 4, 5].map((n) => `<th class="box">${n}</th>`).join('')}<th>Notes</th></tr></thead>
        <tbody>${k.scorecard.map((s) => `<tr><td><b>${esc(s.criterion)}</b></td><td>${esc(s.look_for)}</td>${[1, 2, 3, 4, 5].map(() => '<td class="box"></td>').join('')}<td class="notes"></td></tr>`).join('')}</tbody></table>
        <p class="hint" style="margin-top:6px">1 is well below the bar, 5 is well above it.</p>
        <div class="sign"><span>Interviewer</span><span>Date</span><span>Recommendation</span></div>
      </section>
    </div>`;
  }
  root.innerHTML = `<div class="modal-scrim">${inner}</div>`;
  const focusEl = root.querySelector('input[type="text"], textarea');
  if (focusEl && m.type !== 'kit') focusEl.focus();
}

function closeModal() {
  S.modal = null;
  renderModal();
}

/* ====================================================================
   Actions
   ==================================================================== */
async function reloadChat() {
  S.chat = (await api.get(jobUrl('/chat'))).messages;
  if (S.tab === 'assistant') renderChat();
}

async function openJob(id, tab) {
  clearInterval(S.poller);
  S.drawer = null;
  renderDrawer();
  S.job = await api.get(`/api/jobs/${id}`);
  S.tab = tab || (S.job.jd ? 'candidates' : 'role');
  S.chat = [];
  renderRail();
  renderMain();
  watchTask();
  reloadChat().catch(() => {});
}

const actions = {
  newRole() {
    S.modal = { type: 'newRole' };
    renderModal();
  },
  closeModal,
  async openJob(el) {
    await openJob(el.dataset.id);
  },
  async deleteRole() {
    if (!window.confirm(`Delete "${S.job.title}" with all its resumes and scores? This cannot be undone.`)) return;
    await api.del(jobUrl());
    S.job = null;
    S.jobs = await api.get('/api/jobs');
    if (S.jobs.length) await openJob(S.jobs[0].id);
    else {
      renderRail();
      renderMain();
    }
  },
  tab(el) {
    S.tab = el.dataset.tab;
    renderTabs();
    renderTab();
  },
  pickFiles() {
    const input = $('#file-input');
    if (input) input.click();
  },
  analyse,
  async rank(el) {
    await startScoring({ mode: 'current', force: el.dataset.force === '1' });
  },
  async biasCheck() {
    await startScoring({ mode: 'both', force: false });
  },
  toggleBias() {
    S.biasOpen = !S.biasOpen;
    const el = $('#bias');
    if (el) el.innerHTML = biasHtml();
  },
  async openCand(el) {
    await openCand(el.dataset.id);
  },
  closeDrawer() {
    S.drawer = null;
    renderDrawer();
  },
  hl(el) {
    highlightLines(Number(el.dataset.from), Number(el.dataset.to));
  },
  async cite(el) {
    const hl = [Number(el.dataset.from), Number(el.dataset.to)];
    if (S.drawer && S.drawer.id === el.dataset.id && S.drawer.data) highlightLines(hl[0], hl[1]);
    else await openCand(el.dataset.id, hl);
  },
  async saveCand(el) {
    const name = $('#ed-name').value.trim();
    const email = $('#ed-email').value.trim();
    if (!name) return toast('Name cannot be empty.', 'error');
    await api.patch(jobUrl(`/candidates/${el.dataset.id}`), { name, email });
    S.job = await api.get(jobUrl());
    toast('Details saved.', 'ok');
    renderHead();
    if (S.tab === 'candidates') renderCandTable();
    if (S.tab === 'shortlist') renderTab();
    renderDrawer();
    S.drawer && openCand(S.drawer.id);
  },
  async removeCand(el) {
    const c = cand(el.dataset.id);
    if (!window.confirm(`Remove ${c ? c.name : 'this candidate'} from the role?`)) return;
    S.job = await api.del(jobUrl(`/candidates/${el.dataset.id}`));
    S.drawer = null;
    renderDrawer();
    S.jobs = await api.get('/api/jobs');
    renderRail();
    renderMain();
  },
  async star(el) {
    const id = el.dataset.id;
    const on = !S.job.shortlist.includes(id);
    const res = await api.post(jobUrl('/shortlist'), { candidateId: id, on });
    S.job.shortlist = res.shortlist;
    S.job.candidates = res.candidates;
    renderHead();
    renderTabs();
    if (S.tab === 'candidates') renderCandTable();
    if (S.tab === 'shortlist') renderTab();
    if (S.drawer) renderDrawer();
    if (S.drawer && S.drawer.data && S.drawer.hl) highlightLines(S.drawer.hl[0], S.drawer.hl[1]);
    api.get('/api/jobs').then((j) => {
      S.jobs = j;
      renderRail();
    }).catch(() => {});
  },
  async kit(el) {
    const id = el.dataset.id;
    toast('Preparing the interview kit. This takes a few seconds.');
    const res = await api.post(jobUrl('/kit'), { candidateId: id });
    S.modal = { type: 'kit', id, kit: res.kit };
    renderModal();
  },
  async regenKit(el) {
    toast('Writing a fresh kit...');
    const res = await api.post(jobUrl('/kit'), { candidateId: el.dataset.id, force: true });
    S.modal = { type: 'kit', id: el.dataset.id, kit: res.kit };
    renderModal();
  },
  print() {
    window.print();
  },
  async chatQuick(el) {
    await sendChat(el.dataset.send);
  },
  async emailSend(el) {
    const card = el.closest('[data-card]');
    const msg = S.chat.find((m) => m.id === el.dataset.msg);
    if (!card || !msg) return;
    const subject = $('.mc-subject', card).value;
    const body = $('.mc-body', card).value;
    const ids = msg.ui.ids;
    const smtp = S.health.smtp.configured;
    if (smtp && !window.confirm(`Send ${plural(ids.length, 'email')} now?`)) return;
    el.disabled = true;
    try {
      const res = await api.post(jobUrl('/email/send'), { ids, subject, body });
      S.job = res.job;
      toast(summariseSend(res.results), res.results.some((r) => r.status === 'failed') ? 'error' : 'ok');
      renderHead();
      renderTabs();
      await reloadChat();
    } finally {
      el.disabled = false;
    }
  },
  async emailCancel() {
    const res = await api.post(jobUrl('/chat/cancel'));
    S.chat = res.messages;
    renderChat();
  },
  openCompose() {
    const ids = S.job.shortlist.filter((id) => cand(id));
    if (!ids.length) return toast('Shortlist someone first.');
    const std = S.settings.standardEmail;
    S.modal = { type: 'compose', ids, mode: 'standard', subject: std.subject, body: std.body, customBody: '' };
    renderModal();
  },
  mailMode(el) {
    const m = S.modal;
    if (!m || m.type !== 'compose') return;
    const next = el.dataset.mode;
    if (next === m.mode) return;
    if (m.mode === 'custom') m.customBody = $('#m-body').value;
    m.subject = $('#m-subject').value;
    m.mode = next;
    m.body = next === 'standard' ? S.settings.standardEmail.body : m.customBody || '';
    if (next === 'standard') m.subject = S.settings.standardEmail.subject;
    renderModal();
  },
  async sendCompose(el) {
    const m = S.modal;
    if (!m || !m.ids.length) return;
    const smtp = S.health.smtp.configured;
    if (smtp && !window.confirm(`Send ${plural(m.ids.length, 'email')} now?`)) return;
    el.disabled = true;
    try {
      const res = await api.post(jobUrl('/email/send'), { ids: m.ids, subject: m.subject, body: m.body });
      S.job = res.job;
      closeModal();
      toast(summariseSend(res.results), res.results.some((r) => r.status === 'failed') ? 'error' : 'ok');
      renderHead();
      renderTabs();
      renderTab();
      reloadChat().catch(() => {});
    } finally {
      el.disabled = false;
    }
  },
  openSettings() {
    S.modal = { type: 'settings' };
    renderModal();
  },
  async saveSettings() {
    const body = {
      company: $('#s-company').value,
      senderName: $('#s-sender').value,
      replyTo: $('#s-reply').value,
      standardEmail: { subject: $('#s-subject').value, body: $('#s-body').value },
    };
    S.settings = await api.put('/api/settings', body);
    toast('Settings saved.', 'ok');
    closeModal();
  },
};

function summariseSend(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const parts = [];
  if (n('sent')) parts.push(`Sent ${plural(n('sent'), 'email')}`);
  if (n('simulated')) parts.push(`Logged ${plural(n('simulated'), 'email')} (SMTP is not set up, so nothing was delivered)`);
  const bad = n('failed') + n('skipped');
  if (bad) parts.push(`${bad} could not be sent`);
  return parts.join('. ') || 'Nothing was sent.';
}

/* ====================================================================
   Event wiring
   ==================================================================== */
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal-scrim')) {
    closeModal();
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) run(fn)(el, e);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'file-input') {
    run(uploadFiles)(t.files).finally(() => {
      t.value = '';
    });
  } else if (t.dataset && t.dataset.on === 'blind') {
    run(async () => {
      const res = await api.patch(jobUrl(), { blind: t.checked });
      S.job = res;
      S.drawer = null;
      renderDrawer();
      renderHead();
      renderTabs();
      renderTab();
      reloadChat().catch(() => {});
      toast(res.blind ? 'Blind screening on. Score again to see blind results.' : 'Blind screening off.');
    })();
  } else if (t.dataset && t.dataset.recip && S.modal && S.modal.type === 'compose') {
    const ids = $$('[data-recip]').filter((x) => x.checked).map((x) => x.dataset.recip);
    S.modal.ids = ids;
    updateCompose();
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.filter) {
    const key = t.dataset.filter;
    S.filters[key] = key === 'min' ? Number(t.value) : t.value;
    if (key === 'min') $('#min-val').textContent = t.value;
    renderCandTable();
  } else if (t.id === 'm-subject' && S.modal) {
    S.modal.subject = t.value;
    updateCompose();
  } else if (t.id === 'm-body' && S.modal) {
    S.modal.body = t.value;
    updateCompose();
  } else if (t.id === 'chat-input') {
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form.id === 'chat-form') {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value;
    input.value = '';
    input.style.height = 'auto';
    run(sendChat)(text);
  } else if (form.id === 'role-form') {
    e.preventDefault();
    run(async () => {
      const title = $('#n-title').value.trim();
      if (!title) return;
      const job = await api.post('/api/jobs', { title });
      closeModal();
      S.jobs = await api.get('/api/jobs');
      await openJob(job.id, 'role');
    })();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (S.modal) closeModal();
    else if (S.drawer) actions.closeDrawer();
    return;
  }
  const t = e.target;
  if (t.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  } else if (t.id === 'drop' && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    actions.pickFiles();
  }
});

['dragenter', 'dragover'].forEach((type) =>
  document.addEventListener(type, (e) => {
    const drop = e.target.closest && e.target.closest('#drop');
    if (drop) {
      e.preventDefault();
      drop.classList.add('drag');
    }
  }),
);
document.addEventListener('dragleave', (e) => {
  const drop = e.target.closest && e.target.closest('#drop');
  if (drop) drop.classList.remove('drag');
});
document.addEventListener('drop', (e) => {
  const drop = e.target.closest && e.target.closest('#drop');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('drag');
  if (e.dataTransfer && e.dataTransfer.files.length) run(uploadFiles)(e.dataTransfer.files);
});
// Dropping a file outside the drop zone should not navigate away from the app.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* ====================================================================
   Boot
   ==================================================================== */
async function boot() {
  [S.health, S.settings] = await Promise.all([api.get('/api/health'), api.get('/api/settings')]);
  S.jobs = await api.get('/api/jobs');
  renderRail();
  if (S.jobs.length) await openJob(S.jobs[0].id);
  else renderMain();
}

boot().catch((err) => {
  $('#main').innerHTML = `<div class="banner bad">${I.alert}<div><strong>The app could not start.</strong> ${esc(err.message)}</div></div>`;
});
