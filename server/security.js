// Proteções HTTP do painel e do assistente de instalação (AGENTS, "Regras de segurança").
//
// Cada função é um middleware `(req, res, next)` do roteador próprio (server/http/router.js).
// A ordem em que server/index.js e server/setup/web.js os registram importa, e
// test/seguranca/superficie-ataque.test.js confere:
//   securityHeaders → hostCheck → csrfCheck → issueCsrfCookie → corpo JSON → login.
// Assim os cabeçalhos de segurança saem até nas respostas 401/403 das próprias checagens.
import crypto from 'node:crypto';
import { SESSION_COOKIE, safeEqual } from './http/session.js';

// Nomes pelos quais o painel aceita ser chamado. Qualquer outro Host é DNS rebinding
// (um site que faz o navegador falar com 127.0.0.1 usando o nome dele) e recebe 403.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Cookie da proteção CSRF: emitido nos GETs e exigido nas mutações que trazem Origin.
const CSRF_COOKIE = 'dash_csrf';

/**
 * Nome do host de um cabeçalho Host/Origin, sem a porta e em minúsculas. IPv6 vem entre
 * colchetes (`[::1]:3000` → `[::1]`); sem colchetes, o texto antes do 1º `:` (por isso um
 * `::1` cru vira `''` e é recusado). Sem cabeçalho ou com colchete aberto: `null`.
 */
export function parseHost(hostHeader) {
  if (!hostHeader) return null;
  const h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return null;
    return h.slice(0, end + 1);
  }
  return h.split(':')[0];
}

/** O host está na lista dos nomes locais aceitos? */
export function isAllowedHost(h) {
  return h !== null && h !== undefined && ALLOWED_HOSTS.has(h);
}

/**
 * A origem do pedido é o próprio painel? Sem Origin (curl, scripts, navegação comum) vale;
 * com Origin, o host dele precisa ser igual ao do cabeçalho Host.
 */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = parseHost(req.headers.host);
  if (!host) return false;
  // Tira o esquema ("http://") e compara só o host, do mesmo jeito que o Host é lido.
  const stripped = String(origin).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return parseHost(stripped) === host;
}

/** Middleware: Host fora da lista recebe 403 (anti-DNS rebinding, ameaça 8 do SECURITY). */
export function hostCheck(req, res, next) {
  if (isAllowedHost(parseHost(req.headers.host))) return next();
  return res.status(403).json({ error: 'Host não permitido' });
}

/**
 * Cookies do cabeçalho `Cookie` como `{ nome: valor }`. Valor com `%` inválido fica como
 * veio, em vez de derrubar o pedido.
 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    let value;
    try {
      value = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      value = part.slice(i + 1).trim();
    }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

/** O pedido traz um cookie CSRF com tamanho plausível (gerado por issueCsrfCookie)? */
export function hasCsrfCookie(req) {
  const cookies = parseCookies(req.headers?.cookie);
  return typeof cookies[CSRF_COOKIE] === 'string' && cookies[CSRF_COOKIE].length >= 16;
}

/**
 * Middleware: nos GETs, entrega o cookie CSRF (aleatório, 24 bytes) a quem ainda não tem.
 * HttpOnly (o JavaScript não lê) e SameSite=Lax (outro site não o envia num POST).
 */
export function issueCsrfCookie(req, res, next) {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  if (hasCsrfCookie(req)) return next();
  const value = crypto.randomBytes(24).toString('base64url');
  res.setHeader('Set-Cookie', `${CSRF_COOKIE}=${value}; Path=/; SameSite=Lax; HttpOnly`);
  next();
}

/**
 * Middleware CSRF em 2 camadas (ameaça 9 do SECURITY), só nas mutações:
 *   1. `Sec-Fetch-Site: cross-site` ou Origin de outro host → 403;
 *   2. com Origin (navegador), o cookie CSRF também é obrigatório → senão 403.
 * Scripts sem Origin (curl com Bearer) passam; a autenticação vem depois.
 */
export function csrfCheck(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const sfs = req.headers['sec-fetch-site'];
  if (sfs === 'cross-site') {
    return res.status(403).json({ error: 'Origem não permitida' });
  }
  if (!originAllowed(req)) {
    return res.status(403).json({ error: 'Origem não permitida' });
  }
  if (req.headers.origin && !hasCsrfCookie(req)) {
    return res.status(403).json({ error: 'Origem não permitida' });
  }
  next();
}

/**
 * Middleware: cabeçalhos de segurança em TODA resposta (inclusive erros). A CSP só aceita
 * recursos da própria origem, sem script/estilo inline e sem eval; a tela monta HTML pelo
 * template `html` e aplica medidas pelo CSSOM (ADR 0010).
 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Com o COOP acima, isola a página de outras origens; o painel só carrega recursos dele.
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  // API, link de entrada e assistente nunca vão para o cache do navegador (OWASP ASVS V8):
  // sessão, telemetria e o token do fim da instalação não ficam gravados em disco. Rotas
  // como o SSE e o export trocam por um valor próprio, também sem cache.
  if (/^\/(?:api|entrar)(?:\/|$)/.test(req.path || '')) res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    // data: só para imagens (o ícone embutido no index.html).
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
}

/**
 * Limite de pedidos por IP numa janela de tempo (`max` por `windowMs`); acima disso, 429.
 * Os contadores vencidos são varridos quando o mapa passa de 10 mil IPs, para a memória
 * não crescer sem limite.
 */
export function makeRateLimit({ windowMs = 60000, max = 60 } = {}) {
  const hits = new Map();
  const SWEEP_THRESHOLD = 10000;
  return function rateLimit(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || '?';
    const now = Date.now();
    if (hits.size >= SWEEP_THRESHOLD) {
      for (const [k, entry] of hits) {
        if (entry.reset < now) hits.delete(k);
      }
    }
    const entry = hits.get(key);
    // Primeiro pedido do IP, ou janela anterior vencida: começa uma janela nova.
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'muitas requisições — aguarde' });
    }
    next();
  };
}

/**
 * Autenticação da API (ADR 0007): sessão por cookie (navegador) ou `Authorization: Bearer`
 * (scripts). O token na URL (`?token=`) da V1 não é mais aceito: vazava em histórico e logs.
 * Sem DASH_TOKEN configurado, a API fica aberta (só em 127.0.0.1).
 */
export function makeRequireAuth(token, sessions = null) {
  return function requireAuth(req, res, next) {
    if (!token) return next();
    // 1) Sessão do navegador: o cookie precisa existir no SessionStore (e é renovado).
    const sid = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
    if (sessions && sid && sessions.touch(sid)) return next();
    // 2) Bearer: comparado em tempo constante com o DASH_TOKEN (CWE-208).
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (bearer && safeEqual(bearer, token)) return next();
    // `login: true` diz à tela para mostrar o formulário de login.
    return res.status(401).json({ error: 'Não autorizado', login: true });
  };
}
