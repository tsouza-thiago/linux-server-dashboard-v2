// Sessão por cookie (ADR 0007): o DASH_TOKEN é trocado uma vez por um cookie HttpOnly +
// SameSite=Strict, válido por 30 dias e renovado com o uso. Em disco fica só o SHA-256 do
// identificador: um sessions.json vazado não permite entrar. Nada de token na URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const SESSION_COOKIE = 'dash_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const RENEW_EVERY_MS = 3600 * 1000; // grava a renovação no máximo 1x por hora por sessão
const MAX_SESSIONS = 50;

const hash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');

/** Comparação em tempo constante (tamanhos diferentes já são recusados). */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Cookie da sessão. Com `maxAgeMs = null` vira cookie de sessão do navegador (sem Max-Age:
 * some ao fechar o navegador — "Manter conectado" desmarcado); a sessão no servidor continua
 * com o mesmo prazo de 30 dias.
 */
export function sessionCookie(id, maxAgeMs = SESSION_TTL_MS) {
  const base = `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict`;
  return maxAgeMs === null ? base : `${base}; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export class SessionStore {
  constructor({ file, ttlMs = SESSION_TTL_MS, now = () => Date.now(), log = (m) => console.warn(m) } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.now = now;
    this.log = log;
    this.sessions = [];
    this._queue = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const t = this.now();
      this.sessions = (Array.isArray(list) ? list : [])
        .filter((s) => s && typeof s.idHash === 'string' && s.expiresAt > t);
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`[sessão] arquivo de sessões ilegível, recomeçando: ${err.message}`);
      this.sessions = [];
    }
  }

  _save() {
    const data = JSON.stringify(this.sessions);
    this._queue = this._queue
      .then(async () => {
        await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        await fsp.writeFile(tmp, data, { mode: 0o600 });
        await fsp.rename(tmp, this.file);
      })
      .catch((err) => this.log(`[sessão] falha ao gravar: ${err.message}`));
    return this._queue;
  }

  /** Cria uma sessão e devolve o identificador (só existe no cookie do navegador). */
  create() {
    const id = crypto.randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.push({ idHash: hash(id), createdAt: t, lastUsedAt: t, expiresAt: t + this.ttlMs });
    if (this.sessions.length > MAX_SESSIONS) this.sessions.splice(0, this.sessions.length - MAX_SESSIONS);
    this._save();
    return id;
  }

  /** Sessão válida (renovada) ou null. */
  touch(id) {
    if (typeof id !== 'string' || id.length < 32) return null;
    const h = hash(id);
    const t = this.now();
    const s = this.sessions.find((x) => safeEqual(x.idHash, h));
    if (!s) return null;
    if (s.expiresAt <= t) {
      this.sessions = this.sessions.filter((x) => x !== s);
      this._save();
      return null;
    }
    if (t - s.lastUsedAt >= RENEW_EVERY_MS) {
      s.lastUsedAt = t;
      s.expiresAt = t + this.ttlMs;
      this._save();
    }
    return s;
  }

  revoke(id) {
    if (typeof id !== 'string') return false;
    const h = hash(id);
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((x) => !safeEqual(x.idHash, h));
    if (this.sessions.length !== before) this._save();
    return this.sessions.length !== before;
  }

  revokeAll() {
    const n = this.sessions.length;
    this.sessions = [];
    this._save();
    return n;
  }

  get count() {
    return this.sessions.length;
  }

  async flush() {
    await this._queue;
  }
}
