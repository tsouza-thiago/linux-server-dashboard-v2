import crypto from 'node:crypto';
import { SESSION_COOKIE, safeEqual } from './http/session.js';

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CSRF_COOKIE = 'dash_csrf';

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

export function isAllowedHost(h) {
  return h !== null && h !== undefined && ALLOWED_HOSTS.has(h);
}

export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = parseHost(req.headers.host);
  if (!host) return false;
  const stripped = String(origin).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return parseHost(stripped) === host;
}

export function hostCheck(req, res, next) {
  if (isAllowedHost(parseHost(req.headers.host))) return next();
  return res.status(403).json({ error: 'Host não permitido' });
}

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

export function hasCsrfCookie(req) {
  const cookies = parseCookies(req.headers?.cookie);
  return typeof cookies[CSRF_COOKIE] === 'string' && cookies[CSRF_COOKIE].length >= 16;
}

export function issueCsrfCookie(req, res, next) {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  if (hasCsrfCookie(req)) return next();
  const value = crypto.randomBytes(24).toString('base64url');
  res.setHeader('Set-Cookie', `${CSRF_COOKIE}=${value}; Path=/; SameSite=Lax; HttpOnly`);
  next();
}

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

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
}

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
 */
export function makeRequireAuth(token, sessions = null) {
  return function requireAuth(req, res, next) {
    if (!token) return next();
    const sid = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
    if (sessions && sid && sessions.touch(sid)) {
      req.sessionId = sid;
      return next();
    }
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (bearer && safeEqual(bearer, token)) return next();
    return res.status(401).json({ error: 'Não autorizado', login: true });
  };
}
