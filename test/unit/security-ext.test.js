import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHost, isAllowedHost, originAllowed,
  hostCheck, csrfCheck, securityHeaders, makeRequireAuth,
} from '../../server/security.js';

function fakeRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    json: (obj) => { res.body = obj; return res; },
    status(code) { res.statusCode = code; return res; },
    headers,
  };
  return res;
}

test('parseHost: IPv6 sem colchetes vira vazio (rejeitado)', () => {
  assert.equal(parseHost('::1'), '');
  assert.equal(parseHost('[::1]:3000'), '[::1]');
});

test('parseHost ignora porta e espaços', () => {
  assert.equal(parseHost('  localhost:80  '), 'localhost');
  assert.equal(parseHost('127.0.0.1'), '127.0.0.1');
});

test('isAllowedHost rejeita hostname com porta', () => {
  assert.equal(isAllowedHost('localhost:3000'), false);
  assert.equal(isAllowedHost('127.0.0.1:3000'), false);
});

test('originAllowed aceita esquema maiúsculo local', () => {
  assert.equal(originAllowed({ headers: { origin: 'HTTP://LOCALHOST:3000', host: 'localhost:3000' } }), true);
});

test('originAllowed com porta diferente mas mesmo host', () => {
  assert.equal(originAllowed({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3000' } }), true);
});

test('hostCheck: host válido chama next, inválido responde 403', () => {
  const res = fakeRes();
  let called = false;
  hostCheck({ headers: { host: '127.0.0.1:3000' } }, res, () => { called = true; });
  assert.equal(called, true);

  const res2 = fakeRes();
  hostCheck({ headers: { host: 'evil.com' } }, res2, () => { throw new Error('não deveria chamar'); });
  assert.equal(res2.statusCode, 403);
  assert.equal(res2.body.error, 'Host não permitido');
});

test('csrfCheck: GET passa direto', () => {
  const res = fakeRes();
  let called = false;
  csrfCheck({ method: 'GET', headers: { host: 'localhost' } }, res, () => { called = true; });
  assert.equal(called, true);
});

test('csrfCheck: POST sem origin passa', () => {
  const res = fakeRes();
  let called = false;
  csrfCheck({ method: 'POST', headers: { host: 'localhost' } }, res, () => { called = true; });
  assert.equal(called, true);
});

test('csrfCheck: POST cross-origin é bloqueado', () => {
  const res = fakeRes();
  csrfCheck({
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'https://evil.com' },
  }, res, () => { throw new Error('não deveria chamar'); });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Origem não permitida');
});

test('csrfCheck: POST com Sec-Fetch-Site cross-site é bloqueado', () => {
  const res = fakeRes();
  csrfCheck({
    method: 'POST',
    headers: { host: 'localhost', 'sec-fetch-site': 'cross-site' },
  }, res, () => { throw new Error('não deveria chamar'); });
  assert.equal(res.statusCode, 403);
});

test('csrfCheck: POST same-origin passa', () => {
  const res = fakeRes();
  let called = false;
  csrfCheck({
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      cookie: 'dash_csrf=0123456789abcdef0123456789abcdef',
    },
  }, res, () => { called = true; });
  assert.equal(called, true);
});

test('csrfCheck: POST same-origin sem cookie CSRF é bloqueado', () => {
  const res = fakeRes();
  csrfCheck({
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
  }, res, () => { throw new Error('não deveria chamar'); });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'Origem não permitida');
});

test('securityHeaders define todos os headers de proteção', () => {
  const res = fakeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.ok(res.headers['content-security-policy'].includes("default-src 'self'"));
  assert.ok(res.headers['content-security-policy'].includes('object-src'));
});

test('makeRequireAuth: token errado ou ausente vira 401', () => {
  const res = fakeRes();
  const req = { headers: { authorization: 'Bearer errado' }, query: {} };
  makeRequireAuth('segredo')(req, res, () => { throw new Error('não deveria chamar'); });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Não autorizado');
});

test('makeRequireAuth: Bearer e query corretos passam', () => {
  const res = fakeRes();
  let called = false;
  makeRequireAuth('segredo')(
    { headers: { authorization: 'Bearer segredo' }, query: {} },
    res, () => { called = true; },
  );
  assert.equal(called, true);

  const res2 = fakeRes();
  let called2 = false;
  makeRequireAuth('segredo')(
    { headers: {}, query: { token: 'segredo' } },
    res2, () => { called2 = true; },
  );
  assert.equal(called2, true);
});