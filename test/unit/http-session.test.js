import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, sessionCookie, clearSessionCookie, safeEqual, SESSION_TTL_MS } from '../../server/http/session.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-sess-')), 'sessions.json');
const HOUR = 3600000;

test('sessão: cria, valida, renova com o uso e expira em 30 dias sem uso', async () => {
  let t = Date.UTC(2026, 9, 7);
  const file = tmp();
  const s = new SessionStore({ file, now: () => t });
  const id = s.create();
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(s.touch(id));
  t += 29 * 24 * HOUR;
  assert.ok(s.touch(id), 'usada no dia 29: renova');
  t += 29 * 24 * HOUR;
  assert.ok(s.touch(id), 'continua válida 58 dias depois por ter sido usada');
  t += SESSION_TTL_MS + 1;
  assert.equal(s.touch(id), null, '30 dias sem uso: expira');
  assert.equal(s.count, 0);
  await s.flush();
});

test('sessão: em disco só o hash (sessions.json vazado não permite entrar), 0600', async () => {
  const file = tmp();
  const s = new SessionStore({ file });
  const id = s.create();
  await s.flush();
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(id), 'identificador não fica no arquivo');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const [rec] = JSON.parse(raw);
  assert.equal(s.touch(rec.idHash), null, 'o hash não serve como sessão');
  const again = new SessionStore({ file });
  assert.ok(again.touch(id), 'sobrevive a reinício');
});

test('sessão: identificador curto, errado ou de outro tipo é recusado; revogar uma e todas', async () => {
  const s = new SessionStore({ file: tmp() });
  const a = s.create();
  const b = s.create();
  for (const bad of [undefined, null, 123, '', 'curto', `${a}x`, a.slice(1)]) assert.equal(s.touch(bad), null, String(bad));
  assert.equal(s.revoke(a), true);
  assert.equal(s.revoke(a), false);
  assert.equal(s.revoke(42), false);
  assert.equal(s.touch(a), null);
  assert.ok(s.touch(b));
  assert.equal(s.revokeAll(), 1);
  assert.equal(s.touch(b), null);
  await s.flush();
});

test('sessão: no máximo 50 guardadas (as mais antigas saem) e arquivo ilegível recomeça vazio', () => {
  const s = new SessionStore({ file: tmp() });
  const first = s.create();
  for (let i = 0; i < 50; i++) s.create();
  assert.equal(s.count, 50);
  assert.equal(s.touch(first), null);
  const file = tmp();
  fs.writeFileSync(file, '{{{');
  const logs = [];
  assert.equal(new SessionStore({ file, log: (m) => logs.push(m) }).count, 0);
  assert.match(logs[0], /ilegível/);
});

test('cookie da sessão: HttpOnly, SameSite=Strict, 30 dias; limpar zera', () => {
  assert.equal(sessionCookie('abc'), 'dash_session=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000');
  assert.equal(clearSessionCookie(), 'dash_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'ab'), false);
});
