import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHost, isAllowedHost, originAllowed, makeRequireAuth,
} from '../../server/security.js';

test('parseHost extrai o hostname ignorando porta', () => {
  assert.equal(parseHost('localhost:3000'), 'localhost');
  assert.equal(parseHost('127.0.0.1:3000'), '127.0.0.1');
  assert.equal(parseHost('[::1]:3000'), '[::1]');
  assert.equal(parseHost(null), null);
  assert.equal(parseHost(''), null);
});

test('isAllowedHost só aceita origens locais', () => {
  assert.equal(isAllowedHost('localhost'), true);
  assert.equal(isAllowedHost('127.0.0.1'), true);
  assert.equal(isAllowedHost('[::1]'), true);
  assert.equal(isAllowedHost('evil.com'), false);
  assert.equal(isAllowedHost('192.0.2.10'), false);
});

test('originAllowed bloqueia origem cruzada e aceita local/sem origin', () => {
  assert.equal(originAllowed({ headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' } }), true);
  assert.equal(originAllowed({ headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } }), true);
  assert.equal(originAllowed({ headers: { origin: 'https://evil.com', host: '127.0.0.1:3000' } }), false);
  assert.equal(originAllowed({ headers: { host: '127.0.0.1:3000' } }), true);
});

test('makeRequireAuth exige token apenas quando configurado', () => {
  const res = {
    statusCode: null,
    json() {},
    status(code) { this.statusCode = code; return this; },
  };
  let called = false;
  const next = () => { called = true; };

  const off = makeRequireAuth('');
  off({ headers: {}, query: {} }, res, next);
  assert.equal(called, true);

  const on = makeRequireAuth('segredo');
  on({ headers: {}, query: {} }, res, next);
  assert.equal(res.statusCode, 401);
  on({ headers: { authorization: 'Bearer segredo' }, query: {} }, res, next);
  assert.equal(called, true);
  const on2 = makeRequireAuth('segredo');
  on2({ headers: {}, query: { token: 'segredo' } }, res, next);
  assert.equal(called, true);
});