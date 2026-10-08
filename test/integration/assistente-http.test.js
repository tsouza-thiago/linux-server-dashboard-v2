// Assistente pela rede (server/setup/web.js): código de uso único trocado por cookie,
// mesmas proteções do painel (Host, CSRF, CSP) e os 6 passos até o link de entrada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWizardApp, makeSetupCode, normalizeCode } from '../../server/setup/web.js';
import { listen, close, request } from '../../test-support/request.js';
import { makeInstalacao } from '../../test-support/instalacao-fake.js';

async function start(t, opts = {}) {
  const fake = makeInstalacao();
  const finished = [];
  const logs = [];
  const app = createWizardApp({ inst: fake.inst, code: 'ABC234', onFinish: (p) => finished.push(p), log: (m) => logs.push(m), ...opts });
  const { server, port } = await listen(app);
  t.after(async () => { await close(server); fake.cleanup(); });
  const page = await request(port, { path: '/configurar' });
  const csrf = [].concat(page.headers['set-cookie'] || []).find((c) => c.startsWith('dash_csrf=')).split(';')[0];
  let session = '';
  const post = (p, body, extra = {}) => request(port, {
    method: 'POST', path: `/api/configurar/${p}`, body: body ?? {},
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Cookie: [csrf, session].filter(Boolean).join('; '), ...extra },
  });
  const get = (p) => request(port, { path: `/api/configurar/${p}`, headers: { Cookie: [csrf, session].filter(Boolean).join('; ') } });
  const login = async (codigo = 'abc-234') => {
    const r = await post('entrar', { codigo });
    const c = [].concat(r.headers['set-cookie'] || []).find((x) => x.startsWith('dash_setup='));
    if (c) session = c.split(';')[0];
    return r;
  };
  return { ...fake, port, page, post, get, login, finished, logs };
}

test('código de uso único: 6 caracteres sem ambíguos, mostrado com hífen', () => {
  for (let i = 0; i < 50; i += 1) {
    const c = makeSetupCode();
    assert.match(c.raw, /^[ACDEFGHJKMNPQRTUVWXY34679]{6}$/);
    assert.equal(c.shown, `${c.raw.slice(0, 3)}-${c.raw.slice(3)}`);
  }
  assert.equal(normalizeCode(' 7kq-4mz '), '7KQ4MZ');
});

test('assistente: página com CSP e Host check; API só depois do código, que vale uma vez', async (t) => {
  const s = await start(t);
  assert.equal(s.page.status, 200);
  assert.match(s.page.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(s.page.headers['content-security-policy'], /unsafe-inline/);
  assert.match(s.page.text, /js\/configurar\/main\.js/);
  assert.equal((await request(s.port, { path: '/configurar', headers: { Host: 'evil.example' } })).status, 403, 'DNS rebinding');
  assert.equal((await request(s.port, { path: '/' })).headers.location, '/configurar');

  const before = await s.get('estado');
  assert.equal(before.status, 401);
  assert.equal(before.json.codigo, true);
  const wrong = await s.login('XXX-XXX');
  assert.equal(wrong.status, 401);
  assert.match(wrong.json.error, /Código incorreto/);
  assert.ok(s.logs.some((l) => /incorreto/.test(l)));
  const ok = await s.login();
  assert.equal(ok.status, 200);
  const cookie = [].concat(ok.headers['set-cookie']).find((x) => x.startsWith('dash_setup='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await s.login()).status, 410, 'o mesmo código não entra de novo');
  const st = await s.get('estado');
  assert.equal(st.status, 200);
  assert.deepEqual(st.json.passos.length, 6);
  assert.equal(st.json.computador.versao.texto, 'versão v2.0.0-alpha.8 assinada');

  const cross = await s.post('servidor', { host: '192.0.2.10', user: 'maria' }, { Origin: 'http://evil.example' });
  assert.equal(cross.status, 403, 'CSRF: outra origem');
});

test('assistente: código vence em 30 min e trava depois de muitas tentativas', async (t) => {
  let now = 0;
  const s = await start(t, { now: () => now });
  now = 31 * 60 * 1000;
  assert.equal((await s.login()).status, 410);
  const s2 = await start(t);
  for (let i = 0; i < 20; i += 1) await s2.post('entrar', { codigo: 'ZZZZZZ' }, { 'X-Forwarded-For': String(i) });
  const locked = await s2.login();
  assert.ok([410, 429].includes(locked.status), `travado (${locked.status})`);
});

test('assistente: os 6 passos pela rede até o link de entrada do painel', async (t) => {
  const s = await start(t);
  await s.login();
  const bad = await s.post('servidor', { host: 'a b', user: 'maria' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.field, 'host');
  assert.equal((await s.post('servidor', { host: '192.0.2.10', user: 'maria', port: '22' })).json.ms, 3);
  const id = await s.post('identidade', {});
  assert.equal(id.json.type, 'ssh-ed25519');
  assert.equal((await s.post('conectar', { senha: 'certa' })).json.field, 'confirmo');
  const det = await s.post('conectar', { senha: 'certa', confirmo: true });
  assert.equal(det.status, 200);
  assert.deepEqual(det.json.escolhas.smart, ['sda', 'sdb', 'sdc']);
  assert.equal((await s.get('deteccao')).json.usuario, 'maria');
  const ch = await s.post('escolhas', { mounts: ['/', '/mnt/dados'], smart: ['sda'], netIf: 'enp3s0', services: ['smbd'], limiares: { diskPct: 85 } });
  assert.deepEqual(ch.json.limiares, { diskPct: 85, ramPct: 90, tempC: 60 });
  const plan = await s.post('plano', { from: true });
  assert.equal(plan.json.from, true);
  assert.equal(plan.json.chave, '~/.ssh/dashboard_ed25519');
  assert.match(plan.json.linhaChave, /^restrict,from="192\.0\.2\.50",command="/);
  assert.equal(plan.json.temSmart, true);
  assert.equal((await s.post('concluir', {})).status, 400, 'não conclui antes de preparar');
  const prep = await s.post('preparar', {});
  assert.equal(prep.json.ok, true, prep.json.erro);
  assert.equal(s.inst.temSenha, false);
  const tok = await s.post('token', {});
  assert.ok(tok.json.token.length >= 40);
  assert.equal((await s.post('token', {})).status, 409, 'mostrado uma vez só');
  const done = await s.post('concluir', { iniciarComComputador: false, atalho: true });
  assert.match(done.json.url, /^\/entrar\?codigo=[\w-]{32}$/);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.finished, [{ iniciarComComputador: false, atalho: true }], 'o CLI só fecha depois da resposta');
});

test('assistente: erro inesperado vira mensagem genérica (sem detalhes internos)', async (t) => {
  const s = await start(t);
  await s.login();
  s.inst.definirServidor = async () => { throw new Error('/home/segredo/stack'); };
  const r = await s.post('servidor', { host: '192.0.2.10', user: 'maria' });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'Algo deu errado aqui. Veja o terminal.');
  assert.ok(!r.text.includes('segredo'));
  assert.ok(s.logs.some((l) => l.includes('segredo')), 'o detalhe vai só para o terminal');
});
