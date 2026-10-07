// Chamadas à API local. A sessão vai no cookie (ADR 0007): nada de token no JavaScript.
// Qualquer 401 avisa quem se inscreveu em `onAuthRequired` (a tela mostra o login).
let authHandler = () => {};
export const onAuthRequired = (fn) => { authHandler = fn; };

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* resposta sem JSON */ }
  if (res.status === 401 && path !== '/api/login') authHandler();
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `erro ${res.status}`);
  return data;
}

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  session: () => request('/api/session'),
  login: (token) => request('/api/login', { method: 'POST', body: { token } }),
  logout: (all = false) => request(all ? '/api/logout-all' : '/api/logout', { method: 'POST', body: {} }),
  status: () => request('/api/status'),
  config: () => request('/api/config'),
  buckets: ({ from, to, limit = 600 }) => request(`/api/history${qs({ formato: 'baldes', from, to, limit })}`),
  samples: ({ from, to, limit = 720 }) => request(`/api/history${qs({ from, to, limit })}`),
  alerts: (limit = 200) => request(`/api/alerts${qs({ limit })}`),
  ack: (id) => request(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST', body: {} }),
  resolve: (id) => request(`/api/alerts/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: {} }),
  annotations: () => request('/api/annotations'),
  addAnnotation: ({ text, label, ts }) => request('/api/annotations', { method: 'POST', body: { text, label, ts } }),
  removeAnnotation: (id) => request(`/api/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  outages: (days = 90) => request(`/api/outages${qs({ days })}`),
  poll: () => request('/api/poll', { method: 'POST', body: {} }),
  exportUrl: ({ format, from, to }) => `/api/export${qs({ format, from, to })}`,
};
