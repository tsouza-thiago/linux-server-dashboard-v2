// Link de entrada de uso único (Q4 + passo 6 do assistente): `dashboard abrir` e o fim da
// instalação abrem o painel já logado, sem mostrar o DASH_TOKEN. Quem cria o link precisa
// poder gravar em data/ (ou seja, já é o dono da instalação); em disco fica só o SHA-256 do
// código, que vale uma vez e por pouco tempo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeEqual } from './session.js';

export const LOGIN_LINK_TTL_MS = 2 * 60 * 1000;
const MAX_CODES = 5;
const FILE = 'entrar.json';

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

function read(file, nowMs) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (Array.isArray(list) ? list : []).filter((c) => c && typeof c.hash === 'string' && c.exp > nowMs);
  } catch {
    return [];
  }
}

function write(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Cria um código de entrada (devolve o código; só o hash fica em data/entrar.json). */
export function createLoginCode(dataDir, { ttlMs = LOGIN_LINK_TTL_MS, now = Date.now() } = {}) {
  const file = path.join(dataDir, FILE);
  const code = crypto.randomBytes(24).toString('base64url');
  const list = read(file, now);
  list.push({ hash: hash(code), exp: now + ttlMs });
  write(file, list.slice(-MAX_CODES));
  return code;
}

/** Confere e consome um código: true só na primeira vez e dentro do prazo. */
export function consumeLoginCode(dataDir, code, { now = Date.now() } = {}) {
  if (typeof code !== 'string' || code.length < 32 || code.length > 64) return false;
  const file = path.join(dataDir, FILE);
  const list = read(file, now);
  const h = hash(code);
  const found = list.find((c) => safeEqual(c.hash, h));
  if (!found) return false;
  write(file, list.filter((c) => c !== found));
  return true;
}
