// Servidor HTTP mínimo sobre node:http (ADR 0003): middlewares (req, res, next), rotas com
// parâmetros (`/api/alerts/:id/ack`), tratador de erro central e respostas JSON. Substitui
// o Express sem nenhuma dependência de runtime.
import http from 'node:http';

// Como no Express: middleware com 4 parâmetros `(err, req, res, next)` é tratador de erro.
const isErrorHandler = (fn) => fn.length === 4;

/**
 * Transforma o padrão da rota (`/api/alerts/:id/ack`) numa regex ancorada e na lista dos
 * nomes dos parâmetros. O texto fixo é escapado (nada do padrão vira regex por acidente);
 * cada `:nome` casa um trecho sem `/`. A barra final é opcional.
 */
function compile(pattern) {
  const names = [];
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:([A-Za-z_]\w*)/g, (_, name) => {
    names.push(name);
    return '/([^/]+)';
  });
  return { re: new RegExp(`^${re}/?$`), names };
}

// Nomes que nunca viram parâmetro: o objeto já não tem protótipo, mas recusar estes nomes
// fecha de vez a porta para prototype pollution (CWE-1321) se o objeto for copiado adiante.
const CHAVES_PROIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);

/** Primeira ocorrência de cada parâmetro da query (`?a=1&a=2` → `a: '1'`). */
function parseQuery(params) {
  const vistos = new Map();
  for (const [k, v] of params) if (!CHAVES_PROIBIDAS.has(k) && !vistos.has(k)) vistos.set(k, v);
  // Nenhuma propriedade é gravada com nome vindo de fora (CodeQL js/remote-property-injection):
  // Object.fromEntries cria as chaves como dados próprios e o objeto final fica sem protótipo.
  return Object.setPrototypeOf(Object.fromEntries(vistos), null);
}

/**
 * Acrescenta res.status/json/send (mesma forma usada pelas rotas e pelos testes) e prepara
 * req.path, req.query, req.params e req.ip. URL que nem o `URL` consegue ler vira "/".
 */
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
  }
  req.path = url.pathname;
  req.query = parseQuery(url.searchParams);
  req.params = {};
  req.ip = req.socket?.remoteAddress || '?';
}

/**
 * Cria o roteador: uma função `(req, res)` para o http.Server, com `use`, `get`, `post`,
 * `put`, `patch`, `delete` e `listen`. As camadas rodam na ordem em que foram registradas;
 * `next()` passa para a seguinte e `next(err)` pula direto para os tratadores de erro.
 * `onError` trata o erro que nenhum tratador registrado respondeu.
 */
export function createRouter({ onError } = {}) {
  // Camadas na ordem de registro: { método (null = qualquer), regex do caminho, nomes, fn }.
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
        // Com erro, só tratadores de erro rodam; sem erro, só middlewares e rotas comuns.
        if (err && !isErrorHandler(layer.fn)) continue;
        if (!err && isErrorHandler(layer.fn)) continue;
        // Rota assíncrona que rejeita também vira next(err) (a resposta não fica pendurada).
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

  /**
   * Middleware para todos os caminhos, ou só para um prefixo (`use('/api', fn)` vale para
   * `/api` e `/api/...`, mas não para `/apis`).
   */
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
  // Rotas por método: `handle.get('/x', ...fns)` e assim por diante.
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
    // Corpo que não é JSON é ignorado (as rotas só leem JSON).
    const type = String(req.headers['content-type'] || '');
    if (!type.includes('application/json')) { req.body = {}; return next(); }
    // 1ª barreira: o tamanho declarado; 2ª: o tamanho que realmente chega (sem
    // Content-Length, ou mentindo nele, o corte acontece no meio da leitura).
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
