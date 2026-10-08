import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeHost,
} from '../../server/config.js';
import { buildCommand } from '../../server/poller.js';
import {
  hasCsrfCookie, issueCsrfCookie, securityHeaders, makeRateLimit,
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

test('sanitizeHost rejeita vazio e host iniciado com hífen (injeção de opção ssh)', () => {
  assert.equal(sanitizeHost('-oProxyCommand=echo pwned'), 'seu-host');
  assert.equal(sanitizeHost('  '), 'seu-host');
  assert.equal(sanitizeHost(''), 'seu-host');
  assert.equal(sanitizeHost('meu-host'), 'meu-host');
  assert.equal(sanitizeHost('user@192.0.2.5'), 'user@192.0.2.5');
});

test('buildCommand sanea NET_IF mesmo em override perigoso (anti injeção)', () => {
  const cmd = buildCommand({ netIf: 'enp0s7; rm -rf /' });
  assert.ok(!cmd.includes('rm -rf'), 'não deve conter o payload');
  assert.ok(!cmd.includes('; rm'), 'não deve conter separador de comando');
  assert.ok(!cmd.includes("i='enp0s7;"), 'não deve filtrar pelo payload');

  const opt = buildCommand({ netIf: '-o ProxyCommand=echo;pwned' });
  assert.ok(!opt.includes('ProxyCommand'));
  assert.ok(!opt.includes('pwned'));
  assert.ok(!opt.includes('===NET==='), 'interface perigosa deve ficar vazia (seção Rede omitida)');

  const safe = buildCommand({ netIf: 'enp0s7:1' });
  assert.ok(safe.includes("i='enp0s7:1'"), 'interface segura é usada normalmente');
});

test('issueCsrfCookie emite cookie no GET e não re-emite quando presente', () => {
  const res = fakeRes();
  let called = false;
  issueCsrfCookie({ method: 'GET', headers: {} }, res, () => { called = true; });
  assert.equal(called, true);
  const sc = res.headers['set-cookie'];
  assert.ok(sc && sc.includes('dash_csrf='), 'Set-Cookie com dash_csrf');
  assert.ok(sc.includes('SameSite=Lax'));
  assert.ok(sc.includes('HttpOnly'));

  const res2 = fakeRes();
  let called2 = false;
  issueCsrfCookie(
    { method: 'GET', headers: { cookie: 'dash_csrf=0123456789abcdef0123456789abcdef' } },
    res2, () => { called2 = true; },
  );
  assert.equal(called2, true);
  assert.equal(res2.headers['set-cookie'], undefined, 'não re-emite se já existe');
});

test('issueCsrfCookie não emite cookie em POST', () => {
  const res = fakeRes();
  let called = false;
  issueCsrfCookie({ method: 'POST', headers: {} }, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('hasCsrfCookie exige valor com tamanho mínimo e parseia header', () => {
  assert.equal(hasCsrfCookie({ headers: { cookie: 'a=1; dash_csrf=0123456789abcdef0123456789abcdef' } }), true);
  assert.equal(hasCsrfCookie({ headers: { cookie: 'dash_csrf=xpto' } }), false, 'valor curto não aceito');
  assert.equal(hasCsrfCookie({ headers: {} }), false);
});

test('makeRateLimit bloqueia acima do máximo dentro da janela', () => {
  const limiter = makeRateLimit({ windowMs: 60000, max: 3 });
  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    let called = false;
    limiter({ socket: { remoteAddress: '127.0.0.1' } }, res, () => { called = true; });
    assert.equal(called, true, `requisição ${i + 1} deve passar`);
  }
  const res = fakeRes();
  limiter({ socket: { remoteAddress: '127.0.0.1' } }, res, () => { throw new Error('não deveria chamar'); });
  assert.equal(res.statusCode, 429);
});

test('makeRateLimit tem janelas independentes por chave', () => {
  const limiter = makeRateLimit({ windowMs: 60000, max: 1 });
  const r1 = fakeRes();
  let called1 = false;
  limiter({ socket: { remoteAddress: '1.1.1.1' } }, r1, () => { called1 = true; });
  assert.equal(called1, true);

  const r2 = fakeRes();
  let called2 = false;
  limiter({ socket: { remoteAddress: '2.2.2.2' } }, r2, () => { called2 = true; });
  assert.equal(called2, true, 'IPs diferentes não compartilham contador');
});

test('securityHeaders inclui proteções extras e frame-ancestors', () => {
  const res = fakeRes();
  securityHeaders({}, res, () => {});
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(res.headers['x-dns-prefetch-control'], 'off');
  assert.ok(res.headers['permissions-policy'].includes('geolocation=()'));
  assert.ok(res.headers['content-security-policy'].includes("frame-ancestors 'none'"));
});
test('log do painel nasce com permissão 0600 (não depende do chmod depois de abrir)', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createLogFile } = await import('../../server/logfile.js');
  const src = fs.readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /createLogFile\(LOG_FILE\)/, 'o painel usa o log com permissão restrita');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-logperm-'));
  const old = process.umask(0);
  t.after(() => { process.umask(old); fs.rmSync(dir, { recursive: true, force: true }); });
  const log = createLogFile(path.join(dir, 'sub', 'dashboard.log'));
  log.write('linha');
  log.close();
  assert.equal(fs.statSync(path.join(dir, 'sub', 'dashboard.log')).mode & 0o777, 0o600, 'mesmo com umask 000');
  assert.equal(fs.statSync(path.join(dir, 'sub')).mode & 0o777, 0o700);
});
