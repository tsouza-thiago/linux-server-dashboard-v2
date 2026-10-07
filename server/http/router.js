// Servidor HTTP mínimo sobre node:http (ADR 0003): middlewares (req, res, next), rotas com
// parâmetros (`/api/alerts/:id/ack`), tratador de erro central e respostas JSON. Substitui
// o Express sem nenhuma dependência de runtime.
import http from 'node:http';

const isErrorHandler = (fn) => fn.length === 4;

function compile(pattern) {
  const names = [];
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:([A-Za-z_]\w*)/g, (_, name) => {
    names.push(name);
    return '/([^/]+)';
  });
  return { re: new RegExp(`^${re}/?$`), names };
}

/** Primeira ocorrência de cada parâmetro da query (`?a=1&a=2` → `a: '1'`). */
function parseQuery(params) {
  const out = Object.create(null);
  for (const [k, v] of params) if (!(k in out)) out[k] = v;
  return out;
}

/** Acrescenta res.status/json/send (mesma forma usada pelas rotas e pelos testes). */
function decorate(req, res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    const body = JSON.stringify(obj);
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
    return res;
  };
  res.send = (body) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
    return res;
  };
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    url = new URL('/', 'http://localhost');
    req.badUrl = true;
  }
  req.path = url.pathname;
  req.query = parseQuery(url.searchParams);
  req.params = {};
  req.ip = req.socket?.remoteAddress || '?';
}

export function createRouter({ onError } = {}) {
  const stack = [];
  const add = (method, pattern, handlers) => {
    const { re, names } = compile(pattern);
    for (const fn of handlers) stack.push({ method, re, names, fn });
  };

  function handle(req, res) {
    decorate(req, res);
    // HEAD segue as rotas GET; o node:http descarta o corpo sozinho.
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let i = 0;
    const next = (err) => {
      while (i < stack.length) {
        const layer = stack[i++];
        if (layer.method && layer.method !== method) continue;
        let match = null;
        if (layer.re) {
          match = layer.re.exec(req.path);
          if (!match) continue;
          req.params = Object.fromEntries(layer.names.map((n, k) => {
            try { return [n, decodeURIComponent(match[k + 1])]; } catch { return [n, match[k + 1]]; }
          }));
        }
        if (err && !isErrorHandler(layer.fn)) continue;
        if (!err && isErrorHandler(layer.fn)) continue;
        try {
          const ret = err ? layer.fn(err, req, res, next) : layer.fn(req, res, next);
          if (ret && typeof ret.catch === 'function') ret.catch(next);
        } catch (e) {
          next(e);
        }
        return;
      }
      // Fim da pilha sem resposta: erro sem tratador ou rota inexistente.
      if (res.headersSent) return;
      if (err) {
        if (onError) return onError(err, req, res);
        return res.status(500).json({ error: 'erro interno do servidor' });
      }
      res.status(404).json({ error: 'não encontrado' });
    };
    next();
  }

  handle.use = (pathOrFn, ...fns) => {
    if (typeof pathOrFn === 'string') {
      const prefix = pathOrFn.replace(/\/$/, '');
      const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`);
      for (const fn of fns) stack.push({ method: null, re, names: [], fn });
    } else {
      for (const fn of [pathOrFn, ...fns]) stack.push({ method: null, re: null, names: [], fn });
    }
    return handle;
  };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    handle[m] = (pattern, ...fns) => { add(m.toUpperCase(), pattern, fns); return handle; };
  }
  /** Atalho para os testes e para o startServer: cria o http.Server e escuta. */
  handle.listen = (...args) => http.createServer(handle).listen(...args);
  return handle;
}

/**
 * Lê o corpo JSON com limite de tamanho. Corpo inválido → erro 400; acima do limite → 413.
 * Chaves `__proto__`, `constructor` e `prototype` são descartadas.
 */
export function jsonBody({ limit = 50 * 1024 } = {}) {
  return function readJson(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('application/json')) { req.body = {}; return next(); }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return next(Object.assign(new Error('corpo grande demais'), { status: 413 }));
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        next(Object.assign(new Error('corpo grande demais'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { req.body = {}; return next(); }
      try {
        req.body = JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
      } catch {
        return next(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
      next();
    });
    req.on('error', (e) => { if (!failed) { failed = true; next(Object.assign(e, { status: 400 })); } });
  };
}
