async function request(method, url, body, isForm = false) {
  const opts = { method, headers: {} };
  if (isForm) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('Cannot reach the app server. Is it still running?');
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
  upload: (u, form) => request('POST', u, form, true),
};
