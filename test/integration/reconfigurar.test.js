// Botão Reconfigurar (F8, ADR 0036): POST /api/reconfigurar/iniciar com o executor falso. A rota
// só diz se o executor foi chamado e o que ficou no disco; o comando de verdade está em
// reconfigurar-ponta-a-ponta.test.js. Sem `executarReconfiguracao`, nada sai daqui.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { Atualizacao, RECONFIGURAR_MS } from '../../server/atualizacao/index.js';
import { bloqueioDaReconfiguracao } from '../../server/atualizacao/procurar.js';
import { pegarTrava } from '../../server/atualizacao/registro.js';
import { retirarCodigoPelaTela } from '../../server/setup/pela-tela.js';
import { listen, close, request } from '../../test-support/request.js';
import { aoFim } from '../../test-support/limpeza.js';

const TOKEN = 't'.repeat(43);
const NOVA = { nova: 'v9.9.9', novidades: null, bloqueio: null, erro: null };
const BEARER = { authorization: `Bearer ${TOKEN}` };

async function painel(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-reconf-'));
  aoFim(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  const chamadas = [];
  const app = createApp({
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'), dashToken: TOKEN,
    collect: async () => ({ ok: false, error: 'sem runner' }), log: () => {},
    pastaAtualizacao: dir, modoAtualizacao: 'systemd', procurarVersao: async () => NOVA,
    executarAtualizacao: async () => ({ ok: true }),
    executarReconfiguracao: async (...args) => { chamadas.push(args); return { ok: true }; },
    ...extra,
  });
  const { server, port } = await listen(app.app);
  // `aoFim` roda do último para o 1º (#148): o painel termina de gravar (a sessão do login) e fecha
  // antes de a pasta sair. Com `t.after`, a pasta saía antes, o rmSync falhava com ENOTEMPTY e o
  // servidor ficava escutando, prendendo o processo do teste.
  aoFim(t, async () => { await app.shutdown(); await close(server); });
  return { app, port, dir, chamadas, arquivo: path.join(dir, 'data', 'reconfigurar.json') };
}
const pedir = (port, headers = BEARER, body = {}) => request(port, { method: 'POST', path: '/api/reconfigurar/iniciar', headers: { 'Content-Type': 'application/json', ...headers }, body });

test('rota: sem sessão, 401, e nada roda nem fica no disco', async (t) => {
  const { port, chamadas, arquivo } = await painel(t);
  assert.equal((await pedir(port, {})).status, 401);
  assert.equal((await pedir(port, { authorization: 'Bearer errado' })).status, 401);
  assert.deepEqual(chamadas, []);
  assert.equal(fs.existsSync(arquivo), false);
});

test('rota: com sessão de navegador, entrega o código; em disco fica só o hash, 0600', async (t) => {
  const { port, chamadas, arquivo } = await painel(t);
  const login = await request(port, { method: 'POST', path: '/api/login', headers: { 'Content-Type': 'application/json' }, body: { token: TOKEN } });
  const sessao = [].concat(login.headers['set-cookie']).find((c) => c.startsWith('dash_session=')).split(';')[0];
  const get = await request(port, { path: '/api/session', headers: { Cookie: sessao } });
  const csrf = [].concat(get.headers['set-cookie']).find((c) => c.startsWith('dash_csrf=')).split(';')[0];

  const r = await pedir(port, { Origin: 'http://localhost', Cookie: `${sessao}; ${csrf}` });
  assert.equal(r.status, 202);
  assert.match(r.json.codigo, /^[0-9A-F]{32}$/);
  assert.deepEqual(Object.keys(r.json), ['codigo']);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(chamadas, [[]], 'o executor não recebe argumento');

  const salvo = fs.readFileSync(arquivo, 'utf8');
  assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);
  assert.ok(!salvo.includes(r.json.codigo), 'o código puro não vai para o disco');
  assert.equal(JSON.parse(salvo).hash, crypto.createHash('sha256').update(r.json.codigo).digest('hex'));
});

test('rota: outra origem é 403, mesmo com o token, e nada roda', async (t) => {
  const { port, chamadas, arquivo } = await painel(t);
  assert.equal((await pedir(port, { ...BEARER, Origin: 'http://evil.example' })).status, 403);
  assert.equal((await pedir(port, { ...BEARER, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await pedir(port, { ...BEARER, Origin: 'http://localhost' })).status, 403, 'sem o cookie do CSRF');
  assert.deepEqual(chamadas, []);
  assert.equal(fs.existsSync(arquivo), false);
});

test('rota: respeita o limite de mutações', async (t) => {
  const { port, chamadas } = await painel(t, { rateLimitMax: 1, conferirReconfiguracao: () => 'sem-assinatura' });
  assert.equal((await pedir(port)).status, 409);
  assert.equal((await pedir(port)).status, 429);
  assert.deepEqual(chamadas, []);
});

test('I11: nada do corpo chega ao executor nem ao disco', async (t) => {
  const { port, chamadas, arquivo } = await painel(t);
  const veneno = '--sem-assinatura; rm -rf /';
  assert.equal((await pedir(port, BEARER, { codigo: veneno, comando: veneno, pasta: veneno })).status, 202);
  assert.deepEqual(chamadas, [[]]);
  assert.ok(!fs.readFileSync(arquivo, 'utf8').includes('rm -rf'));
});

test('bloqueios: sem login, 409, e nada roda nem fica no disco', async (t) => {
  const { port, chamadas, arquivo } = await painel(t, { dashToken: '' });
  const r = await pedir(port, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.bloqueio, 'sem-login');
  assert.equal(r.json.codigo, undefined);
  assert.deepEqual(chamadas, []);
  assert.equal(fs.existsSync(arquivo), false);
});

test('bloqueios: com uma atualização em andamento, 409', async (t) => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-reconf-trava-'));
  aoFim(t, () => fs.rmSync(pasta, { recursive: true, force: true }));
  const procDir = path.join(pasta, 'proc');
  fs.mkdirSync(path.join(procDir, '700'), { recursive: true });
  fs.writeFileSync(path.join(procDir, '700', 'cmdline'), 'node\0/p/server/cli/index.js\0atualizar\0');
  pegarTrava(pasta, { pid: 700, procDir });
  const { port, chamadas } = await painel(t, { pastaAtualizacao: pasta, procDirAtualizacao: procDir });
  const r = await pedir(port);
  assert.equal(r.status, 409);
  assert.equal(r.json.bloqueio, 'rodando');
  assert.deepEqual(chamadas, []);
  assert.equal(fs.existsSync(path.join(pasta, 'data', 'reconfigurar.json')), false);
});

test('bloqueios: a pasta é conferida a cada pedido e barra antes de criar o código', async (t) => {
  for (const bloqueio of ['sem-assinatura', 'outra-pasta']) {
    let vezes = 0;
    const { port, chamadas, arquivo } = await painel(t, { conferirReconfiguracao: () => { vezes += 1; return bloqueio; } });
    for (const n of [1, 2]) {
      const r = await pedir(port);
      assert.equal(r.status, 409);
      assert.equal(r.json.bloqueio, bloqueio);
      assert.equal(vezes, n);
    }
    assert.deepEqual(chamadas, []);
    assert.equal(fs.existsSync(arquivo), false);
  }
});

test('bloqueios: a conferência olha a instalação, a assinatura e não os arquivos alterados', (t) => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-reconf-pasta-'));
  aoFim(t, () => fs.rmSync(pasta, { recursive: true, force: true }));
  const home = path.join(pasta, 'home');
  // `git` falso: repositório num commit sem tag, ou numa tag cuja assinatura confere.
  const git = (tags) => (cmd, args) => {
    if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n', stderr: '' };
    if (args.includes('--points-at')) return { status: 0, stdout: tags, stderr: '' };
    // O objeto tag guarda o próprio nome (#155): o falso devolve o nome da ref pedida.
    if (args.includes('cat-file')) return { status: 0, stdout: `type commit\ntag ${args.at(-1).replace('refs/tags/', '')}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(bloqueioDaReconfiguracao(pasta, home, git('')), 'outra-pasta', 'sem .env');
  fs.writeFileSync(path.join(pasta, '.env'), '');
  fs.mkdirSync(path.join(pasta, 'docs'));
  fs.writeFileSync(path.join(pasta, 'docs', 'allowed_signers'), 'teste@example.com ssh-ed25519 AAAA\n');
  assert.equal(bloqueioDaReconfiguracao(pasta, home, git('')), 'sem-assinatura');
  assert.equal(bloqueioDaReconfiguracao(pasta, home, git('v2.0.0\n')), null);
  // O serviço instalado é de outra pasta (#118): assinatura boa não libera.
  const unidade = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(unidade, { recursive: true });
  fs.writeFileSync(path.join(unidade, 'server-dashboard.service'), `[Service]\nWorkingDirectory=${home}\n`);
  assert.equal(bloqueioDaReconfiguracao(pasta, home, git('v2.0.0\n')), 'outra-pasta');
});

test('painel sem executor (testes, painel de teste): 409, sem código', async (t) => {
  const { port, arquivo } = await painel(t, { executarReconfiguracao: null });
  const r = await pedir(port);
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, undefined);
  assert.equal(fs.existsSync(arquivo), false);
});

test('executor que não sobe ou lança: 503, sem código no disco, e dá para tentar de novo', async (t) => {
  const respostas = [async () => ({ ok: false }), async () => { throw new Error('sem systemd-run'); }, async () => null];
  for (const falha of respostas) {
    let tentativa = 0;
    const { port, arquivo, dir } = await painel(t, { executarReconfiguracao: async () => { tentativa += 1; return tentativa === 1 ? falha() : { ok: true }; } });
    const r = await pedir(port);
    assert.equal(r.status, 503);
    assert.equal(r.json.codigo, undefined);
    assert.equal(fs.existsSync(arquivo), false, 'o código não fica valendo');
    assert.equal(retirarCodigoPelaTela(path.join(dir, 'data')), null);
    const denovo = await pedir(port);
    assert.equal(denovo.status, 202, 'a falha solta a trava');
    assert.equal(tentativa, 2);
  }
});

test('o código já está no disco quando o executor sobe: o comando lê o arquivo logo de início', async (t) => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-reconf-ordem-'));
  aoFim(t, () => fs.rmSync(pasta, { recursive: true, force: true }));
  let achou = false;
  const { port } = await painel(t, { pastaAtualizacao: pasta, executarReconfiguracao: async () => { achou = fs.existsSync(path.join(pasta, 'data', 'reconfigurar.json')); return { ok: true }; } });
  assert.equal((await pedir(port)).status, 202);
  assert.equal(achou, true);
});

test('disco que recusa o código: 503, e o executor nem sobe', async (t) => {
  const { port, dir, chamadas } = await painel(t);
  fs.writeFileSync(path.join(dir, 'data'), 'um arquivo no lugar da pasta');
  assert.equal((await pedir(port)).status, 503);
  assert.deepEqual(chamadas, []);
});

test('2 pedidos ao mesmo tempo disparam 1 só, e o código que vale é o de quem recebeu', async (t) => {
  const { port, chamadas, arquivo } = await painel(t);
  const r = await Promise.all([pedir(port), pedir(port), pedir(port)]);
  assert.deepEqual(r.map((x) => x.status).sort(), [202, 409, 409]);
  assert.equal(chamadas.length, 1);
  const { json } = r.find((x) => x.status === 202);
  assert.equal(JSON.parse(fs.readFileSync(arquivo, 'utf8')).hash, crypto.createHash('sha256').update(json.codigo).digest('hex'));
  for (const x of r.filter((y) => y.status === 409)) assert.equal(x.json.bloqueio, 'rodando');
});

test('depois de disparar, a atualização espera: ela pararia o assistente', async (t) => {
  const { port, app } = await painel(t);
  await app.atualizacao.verificar();
  assert.equal((await pedir(port)).status, 202);
  const r = await request(port, { method: 'POST', path: '/api/atualizacao/iniciar', headers: { 'Content-Type': 'application/json', ...BEARER }, body: { versao: 'v9.9.9' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.bloqueio, 'rodando');
});

test('comando que recusou deixa o painel no ar: passado 1 min, o botão volta a valer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-reconf-prazo-'));
  aoFim(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  let agora = 1000;
  const chamadas = [];
  const a = new Atualizacao({
    file: path.join(dir, 'atualizacao.json'), instalada: 'v2.0.0', loginExigido: true, procurar: async () => ({}),
    root: dir, executarReconfiguracao: async () => { chamadas.push(1); return { ok: true }; }, agora: () => agora,
  });
  assert.equal((await a.reconfigurar()).status, 202);
  agora += RECONFIGURAR_MS - 1;
  assert.equal((await a.reconfigurar()).corpo.bloqueio, 'rodando');
  agora += 1;
  assert.equal((await a.reconfigurar()).status, 202);
  assert.equal(chamadas.length, 2);
});

test('o código não vai para o log do painel nem para o estado da tela', async (t) => {
  const linhas = [];
  const { port, app } = await painel(t, { log: (m) => linhas.push(m) });
  const { json } = await pedir(port);
  assert.ok(linhas.length > 0);
  assert.ok(!linhas.join('\n').includes(json.codigo));
  assert.ok(!JSON.stringify(app.atualizacao.estado()).includes(json.codigo));
});

// Etapa 5 da F8: o motivo de uma recusa ou de uma volta chega à tela pelo estado, só as falhas.
test('estado: as falhas do log do --pela-tela, sem o resto do log', async (t) => {
  const { port, dir } = await painel(t);
  const ler = async () => (await request(port, { path: '/api/atualizacao', headers: BEARER })).json.reconfiguracao;
  assert.equal(await ler(), null, 'sem log, nada');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'reconfigurar.log'), '→ assistente no ar, esperando o navegador\n✓ painel em http://127.0.0.1:3000\n✗ há uma atualização em andamento (o painel continua no ar)\n');
  const r = await ler();
  assert.deepEqual(r.motivos, ['há uma atualização em andamento (o painel continua no ar)']);
  assert.ok(Number.isFinite(Date.parse(r.em)));
  const sem = await request(port, { path: '/api/atualizacao' });
  assert.equal(sem.status, 401, 'o motivo só sai com sessão');
});

// A tela espera o assistente pelo `/`: o assistente redireciona, e o painel nunca pode.
test('o painel responde / sem redirecionar, com e sem sessão', async (t) => {
  const { port } = await painel(t);
  for (const headers of [BEARER, {}]) assert.equal((await request(port, { path: '/', headers })).status, 200);
});
