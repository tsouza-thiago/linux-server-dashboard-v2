// Guardas HTTP: Host (IPv6, porta, espaços), Origin, cabeçalhos de segurança, token, sanitizeHost, script de coleta
// saneado e cookie CSRF.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHost,
  isAllowedHost,
  originAllowed,
  makeRequireAuth,
  hostCheck,
  csrfCheck,
  securityHeaders,
  hasCsrfCookie,
  issueCsrfCookie,
  makeRateLimit,
} from '../../server/security.js';
import { fakeRes } from '../../test-support/falsos.js';
import { sanitizeHost } from '../../server/config.js';
import { buildCommand } from '../../server/poller.js';

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
  let chamadas = 0;
  const next = () => { chamadas += 1; };

  const off = makeRequireAuth('');
  off({ headers: {}, query: {} }, res, next);
  assert.equal(chamadas, 1, 'sem token configurado, deixa passar');

  const on = makeRequireAuth('segredo');
  on({ headers: {}, query: {} }, res, next);
  assert.equal(res.statusCode, 401);
  assert.equal(chamadas, 1, 'sem credencial, barra');
  on({ headers: { authorization: 'Bearer segredo' }, query: {} }, res, next);
  assert.equal(chamadas, 2, 'Bearer certo passa');
  // `?token=` na URL não vale (ADR 0007): barra de novo.
  res.statusCode = null;
  on({ headers: {}, query: { token: 'segredo' } }, res, next);
  assert.equal(res.statusCode, 401);
  assert.equal(chamadas, 2, 'token na URL não passa');
});

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

test('makeRequireAuth: Bearer correto passa; token na query é recusado (ADR 0007)', () => {
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
  assert.equal(called2, false);
  assert.equal(res2.statusCode, 401);
});

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
