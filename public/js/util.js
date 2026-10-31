const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ENT[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  if ([...host.children].some((n) => n.textContent === message)) return;
  while (host.children.length >= 3) host.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, kind === 'error' ? 6500 : 3500);
}

export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/{{\s*([a-z_]+)\s*}}/gi, (m, k) => {
    const v = vars[k.toLowerCase()];
    return v == null ? '' : String(v);
  });
}
