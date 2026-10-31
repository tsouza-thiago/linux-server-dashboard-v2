// Versão nova (ADR 0030): as rotas com e sem sessão, e a procura com git e chave SSH de verdade
// num clone temporário: só tag assinada conta, e a lista de chaves é a da versão instalada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { procurar } from '../../server/atualizacao/procurar.js';
import { newestSignedTag } from '../../server/setup/assinatura.js';
import { listen, close, request, readSSE } from '../../test-support/request.js';

const TOKEN = 't'.repeat(43);
const hasTools = !spawnSync('git', ['--version']).error && !spawnSync('ssh-keygen', ['-?']).error;
const NOVA = { nova: 'v9.9.9', novidades: { secoes: [{ versao: '9.9.9', data: null, texto: '- item' }], cortado: false }, bloqueio: null, erro: null };

async function painel(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-atu-http-'));
  const app = createApp({
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'), dashToken: TOKEN,
    collect: async () => ({ ok: false, error: 'sem runner' }), log: () => {}, ...extra,
  });
  const { server, port } = await listen(app.app);
  t.after(async () => { await app.shutdown(); await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  const bearer = { authorization: `Bearer ${TOKEN}` };
  return { app, port, bearer, dir };
}

test('rotas: sem sessão, 401; com sessão, o estado sem segredo', async (t) => {
  const { port, bearer, dir } = await painel(t);
  assert.equal((await request(port, { path: '/api/atualizacao' })).status, 401);
  assert.equal((await request(port, { method: 'POST', path: '/api/atualizacao/verificar', body: {} })).status, 401);
  const r = await request(port, { path: '/api/atualizacao', headers: bearer });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['bloqueio', 'erro', 'instalada', 'nova', 'novidades', 'verificadoEm']);
  assert.ok(!JSON.stringify(r.json).includes(TOKEN));
  assert.equal(fs.existsSync(path.join(dir, 'atualizacao.json')), false, 'ler não grava nada');
});

test('rotas: procurar agora devolve a versão, avisa pelo SSE e limita a 1 por minuto', async (t) => {
  const { port, bearer } = await painel(t, { procurarVersao: async () => NOVA });
  // Ao conectar: retry, hello, annotations e atualizacao; depois, o aviso da procura.
  const sse = readSSE(port, { headers: bearer, until: 5 });
  await new Promise((r) => { setTimeout(r, 100); });
  const r = await request(port, { method: 'POST', path: '/api/atualizacao/verificar', body: {}, headers: bearer });
  assert.equal(r.status, 200);
  assert.equal(r.json.nova, 'v9.9.9');
  assert.match((await sse).data, /event: atualizacao\ndata: .*v9\.9\.9/);
  const de = await request(port, { method: 'POST', path: '/api/atualizacao/verificar', body: {}, headers: bearer });
  assert.equal(de.status, 429);
});

test('rotas: procurar agora de outra origem é recusado antes de sair para a internet', async (t) => {
  let chamadas = 0;
  const { port, bearer } = await painel(t, { procurarVersao: async () => { chamadas += 1; return NOVA; } });
  const r = await request(port, { method: 'POST', path: '/api/atualizacao/verificar', body: {}, headers: { ...bearer, origin: 'https://atacante.example', 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.equal(chamadas, 0);
});

test('o painel de teste e os testes nunca procuram de verdade sem `procurarVersao`', async (t) => {
  const { app } = await painel(t);
  assert.equal((await app.atualizacao.verificar()).nova, null);
});

// Origem com as tags, um clone instalado na v2.4.0, e tag nova empurrada pela origem.
function clone(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-atu-git-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const origem = path.join(base, 'origem');
  const pasta = path.join(base, 'instalada');
  fs.mkdirSync(origem);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'M', GIT_AUTHOR_EMAIL: 'm@example.com', GIT_COMMITTER_NAME: 'M', GIT_COMMITTER_EMAIL: 'm@example.com' };
  const git = (dir, ...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
  };
  git(origem, 'init', '-q');
  for (const k of ['chave', 'outra']) spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', k, '-f', path.join(base, k)]);
  const pub = fs.readFileSync(path.join(base, 'chave.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  fs.mkdirSync(path.join(origem, 'docs'));
  fs.writeFileSync(path.join(origem, 'docs', 'allowed_signers'), `m@example.com namespaces="git" ${pub}\n`);
  const versao = (v, texto) => {
    fs.writeFileSync(path.join(origem, 'package.json'), JSON.stringify({ version: v }));
    fs.writeFileSync(path.join(origem, 'CHANGELOG.md'), `# Changelog\n\n## [${v}] — 2026-11-02\n\n- ${texto}\n\n## [2.4.0] — 2026-10-01\n\n- velho\n`);
    git(origem, 'add', '.');
    git(origem, 'commit', '-q', '-m', v);
  };
  const assina = (tag, chave = 'chave') => git(origem, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${path.join(base, chave)}`, 'tag', '-s', tag, '-m', tag);
  versao('2.4.0', 'inicial');
  assina('v2.4.0');
  spawnSync('git', ['clone', '-q', origem, pasta], { env });
  git(pasta, 'checkout', '-q', '--detach', 'v2.4.0');
  fs.writeFileSync(path.join(pasta, '.env'), 'PORT=3000\n');
  const home = path.join(base, 'home');
  return { origem, pasta, home, git, versao, assina };
}

test('procura: acha a tag assinada nova, traz as novidades e não troca de versão', { skip: !hasTools }, (t) => {
  const { pasta, home, versao, assina, git } = clone(t);
  assert.deepEqual(procurar(pasta, { home }), { nova: null, novidades: null, bloqueio: null, erro: null });
  versao('2.5.0', 'Item novo <b>.');
  assina('v2.5.0');
  const r = procurar(pasta, { home });
  assert.equal(r.nova, 'v2.5.0');
  assert.equal(r.novidades.secoes.length, 1);
  assert.match(r.novidades.secoes[0].texto, /Item novo <b>\./);
  assert.equal(r.bloqueio, null);
  git(pasta, 'describe', '--exact-match', '--tags', 'v2.4.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pasta, 'package.json'), 'utf8')).version, '2.4.0', 'a pasta continua na versão instalada');
});

test('procura: tag sem assinatura ou de outra chave não vira versão nova', { skip: !hasTools }, (t) => {
  const { pasta, home, origem, versao, assina, git } = clone(t);
  versao('2.5.0', 'leve');
  git(origem, 'tag', 'v2.5.0');
  versao('2.6.0', 'chave de fora');
  assina('v2.6.0', 'outra');
  assert.equal(procurar(pasta, { home }).nova, null);
  assert.equal(newestSignedTag(pasta, { current: 'v2.4.0' }), null);
});

test('procura: uma versão nova não se autoaprova com a lista de chaves dela', { skip: !hasTools }, (t) => {
  const { pasta, home, origem, versao, assina, git } = clone(t);
  // A tag nova, assinada pela outra chave, traz a própria chave na lista dela.
  const pub = fs.readFileSync(path.join(path.dirname(origem), 'outra.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  fs.appendFileSync(path.join(origem, 'docs', 'allowed_signers'), `m@example.com namespaces="git" ${pub}\n`);
  git(origem, 'add', '.');
  versao('2.5.0', 'autoaprovada');
  assina('v2.5.0', 'outra');
  assert.equal(procurar(pasta, { home }).nova, null);
});

test('procura: pré-versão só para quem já está numa', { skip: !hasTools }, (t) => {
  const { pasta, home, versao, assina } = clone(t);
  versao('2.5.0-rc.1', 'pré');
  assina('v2.5.0-rc.1');
  assert.equal(procurar(pasta, { home }).nova, null);
  assert.equal(newestSignedTag(pasta, { current: 'v2.4.0', includePre: true }), 'v2.5.0-rc.1');
});

test('procura: sem origem acessível, avisa e continua com as tags que já estão aqui', { skip: !hasTools }, (t) => {
  const { pasta, home, origem, versao, assina } = clone(t);
  versao('2.5.0', 'novo');
  assina('v2.5.0');
  assert.equal(procurar(pasta, { home }).nova, 'v2.5.0');
  fs.rmSync(origem, { recursive: true, force: true });
  const r = procurar(pasta, { home });
  assert.equal(r.erro, 'sem-acesso');
  assert.equal(r.nova, 'v2.5.0');
});

test('procura: diz o que impediria a troca de versão', { skip: !hasTools }, (t) => {
  const { pasta, home } = clone(t);
  fs.appendFileSync(path.join(pasta, 'CHANGELOG.md'), 'alterado à mão\n');
  assert.equal(procurar(pasta, { home }).bloqueio, 'arquivos-alterados');
  fs.rmSync(path.join(pasta, '.env'));
  assert.equal(procurar(pasta, { home }).bloqueio, 'outra-pasta');
  const semGit = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sem-git-'));
  t.after(() => fs.rmSync(semGit, { recursive: true, force: true }));
  assert.equal(procurar(semGit, { home }).bloqueio, 'sem-git');
});

test('procura: não há pergunta de senha nem o git espera o terminal', { skip: !hasTools }, () => {
  const vistos = [];
  const run = (cmd, args, opts) => { vistos.push(opts); return { status: 128, stdout: '' }; };
  procurar('/nao/existe', { run });
  assert.equal(vistos[0].env.GIT_TERMINAL_PROMPT, '0');
  assert.match(vistos[0].env.GIT_SSH_COMMAND, /BatchMode=yes/);
  assert.equal(vistos[0].stdio[0], 'ignore');
});
