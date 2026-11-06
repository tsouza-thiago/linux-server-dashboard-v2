// Lançador do pacote (bin/dashboard, F9 etapa 3, ADR 0042 e 0043): montado numa pasta
// temporária com o layout do pacote (<base>/bin/dashboard, <base>/atual, <base>/node), ele liga
// o modo sistema, usa o Node do pacote e o código do link `atual`, e a CLI lê e grava só nas
// pastas XDG da pessoa. Nada do pacote é instalado de verdade e nada sai da máquina.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../server/config.js';

const LANCADOR = path.join(ROOT, 'bin', 'dashboard');

// Pacote falso: o link `atual` aponta para este projeto, e o Node do pacote é o que roda o teste.
function montarPacote(t, { comNode = true, comAtual = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lancador-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base');
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true });
  fs.copyFileSync(LANCADOR, path.join(base, 'bin', 'dashboard'));
  fs.chmodSync(path.join(base, 'bin', 'dashboard'), 0o755);
  if (comAtual) fs.symlinkSync(ROOT, path.join(base, 'atual'));
  if (comNode) {
    fs.mkdirSync(path.join(base, 'node', 'bin'), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(base, 'node', 'bin', 'node'));
  }
  // PATH só com o necessário (readlink, dirname e o ssh que a instalação confere) e um `node`
  // antigo: o Node do sistema nunca vale aqui.
  const bin = path.join(dir, 'bin-sistema');
  fs.mkdirSync(bin);
  for (const prog of ['readlink', 'dirname', 'ssh', 'ssh-keygen']) {
    const real = spawnSync('sh', ['-c', `command -v ${prog}`], { encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, path.join(bin, prog));
  }
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho 22\n', { mode: 0o755 });
  const home = path.join(dir, 'casa');
  fs.mkdirSync(home, { mode: 0o700 });
  // O link /usr/bin/dashboard do pacote: o lançador acha a pasta pelo caminho real.
  const link = path.join(dir, 'usr-bin-dashboard');
  fs.symlinkSync(path.join(base, 'bin', 'dashboard'), link);
  return { dir, base, home, link, path: bin };
}

// Roda o comando pelo link, com um ambiente limpo (sem XDG_* nem o sinal herdado do teste).
function rodar(p, args) {
  const env = { PATH: p.path, HOME: p.home, LANG: 'C.UTF-8' };
  return spawnSync(p.link, args, { env, encoding: 'utf8', timeout: 60000 });
}

const portaLivre = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('lançador: mostra a versão do código do link atual', (t) => {
  const p = montarPacote(t);
  const r = rodar(p, ['versao']);
  const versao = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `Server Dashboard ${versao}`);
});

test('lançador: liga o modo sistema e lê o .env da pasta XDG da pessoa', (t) => {
  const p = montarPacote(t);
  const dados = path.join(p.home, '.local', 'share', 'server-dashboard');
  let r = rodar(p, ['status']);
  assert.match(r.stdout, new RegExp(`dados: ${dados.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.stdout, /ainda não instalado \(rode dashboard instalar\)/);
  // Com um .env de verdade na pasta da configuração, a instalação aparece como feita.
  const config = path.join(p.home, '.config', 'server-dashboard');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, '.env'), 'SSH_HOST=usuario@192.0.2.10\nPORT=1\n', { mode: 0o600 });
  r = rodar(p, ['status']);
  assert.doesNotMatch(r.stdout, /ainda não instalado/);
  assert.match(r.stdout, /painel parado/);
  assert.equal(r.status, 3);
});

test('lançador: atualizar sem instalação para antes de tudo', (t) => {
  const p = montarPacote(t);
  // O atualizar funciona no pacote (etapa 8, ADR 0048), mas só com o .env da pessoa.
  const r = rodar(p, ['atualizar', '--terminal']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /esta pasta não é uma instalação do painel/);
  assert.deepEqual(fs.readdirSync(p.home), [], 'nenhuma pasta criada');
});

test('lançador: desinstalar no pacote apaga só a configuração e os dados da pessoa (ADR 0050)', (t) => {
  const p = montarPacote(t);
  const config = path.join(p.home, '.config', 'server-dashboard');
  const dados = path.join(p.home, '.local', 'share', 'server-dashboard');
  const data = path.join(dados, 'data');
  for (const dir of [config, path.join(data, 'ssh'), path.join(data, 'history'), path.join(dados, '.backups'), path.join(p.home, '.ssh'), path.join(p.home, '.local', 'bin')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const chave = path.join(p.home, '.ssh', 'dashboard-servidor-3f9a12c4');
  fs.writeFileSync(path.join(config, '.env'), 'PORT=3999\n', { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'ssh', 'config'), `Host servidor\n  IdentityFile "${chave}"\n`, { mode: 0o600 });
  fs.writeFileSync(chave, 'chave falsa\n', { mode: 0o600 });
  fs.writeFileSync(`${chave}.pub`, 'ssh-ed25519 AAAA dashboard@teste\n');
  fs.writeFileSync(path.join(data, 'sessions.json'), '[]', { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'history', '2026-11-06.ndjson'), '{}\n', { mode: 0o600 });
  // O comando pessoal de um clone: no pacote, o desinstalar não mexe nele.
  const outroClone = path.join(p.dir, 'clone');
  fs.mkdirSync(outroClone);
  fs.writeFileSync(path.join(outroClone, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(path.join(outroClone, 'dashboard'), path.join(p.home, '.local', 'bin', 'dashboard'));
  const antes = fs.readdirSync(ROOT).sort();

  let r = rodar(p, ['desinstalar', '--sim']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(config), false, 'a pasta da configuração vazia sai');
  for (const f of [path.join(data, 'ssh'), path.join(data, 'sessions.json'), chave, `${chave}.pub`]) assert.equal(fs.existsSync(f), false, f);
  assert.ok(fs.existsSync(path.join(data, 'history', '2026-11-06.ndjson')), 'o histórico fica sem --apagar-historico');
  assert.ok(fs.lstatSync(path.join(p.home, '.local', 'bin', 'dashboard')).isSymbolicLink(), 'o comando do clone fica');
  assert.match(r.stdout, /O código do painel fica em \/opt\/server-dashboard/);
  assert.match(r.stdout, /sudo apt purge server-dashboard/);
  assert.doesNotMatch(r.stdout, /rm -rf/);

  r = rodar(p, ['desinstalar', '--sim', '--apagar-historico']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(dados), false, 'sem o histórico, a pasta de dados vazia sai');
  assert.deepEqual(fs.readdirSync(path.join(p.home, '.local')).sort(), ['bin', 'share'], 'só as pastas do painel saem');
  assert.deepEqual(fs.readdirSync(ROOT).sort(), antes, 'nada muda na pasta do código');
});

test('lançador: --importar-pasta e --importar-v1 passam no pacote e conferem a pasta antes de tudo', (t) => {
  const p = montarPacote(t);
  const r = rodar(p, ['instalar', '--importar-pasta', p.dir]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /essa pasta não é um clone do painel/);
  assert.equal(fs.existsSync(path.join(p.home, '.config', 'server-dashboard', '.env')), false);
  // O --importar-v1 também funciona no pacote: confere a pasta da V1.
  const v1 = rodar(p, ['instalar', '--importar-v1', p.dir]);
  assert.equal(v1.status, 1, v1.stdout + v1.stderr);
  assert.match(v1.stdout, /essa pasta não é uma instalação da V1/);
});

test('lançador: a instalação cria as pastas pessoais (0700) e usa a porta do .env de lá', async (t) => {
  const p = montarPacote(t);
  const porta = await portaLivre();
  const config = path.join(p.home, '.config', 'server-dashboard');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, '.env'), `PORT=${porta}\n`, { mode: 0o600 });
  const antes = fs.readdirSync(ROOT).sort();
  // Sem --servidor, o modo sem perguntas para logo depois das conferências (código 2).
  const r = rodar(p, ['instalar', '--sem-interface']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /instalada pelo pacote \.deb/);
  assert.match(r.stdout, /Node\.js 24 — o do pacote/);
  assert.match(r.stdout, new RegExp(`porta ${porta} livre`));
  const dados = path.join(p.home, '.local', 'share', 'server-dashboard');
  for (const dir of [config, dados, path.join(dados, 'data'), path.join(dados, 'data', 'ssh')]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
  // Nada novo na pasta do código (no pacote, ela é de outro usuário e só leitura).
  assert.deepEqual(fs.readdirSync(ROOT).sort(), antes);
});

test('lançador: sem o Node do pacote e com um Node antigo no sistema, para com a explicação', (t) => {
  const p = montarPacote(t, { comNode: false });
  const r = rodar(p, ['versao']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sem Node\.js 24/);
  assert.equal(r.stdout, '');
});

test('lançador: sem a versão atual, para com a explicação', (t) => {
  const p = montarPacote(t, { comAtual: false });
  const r = rodar(p, ['versao']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nenhuma versão do painel instalada/);
});

test('lançador: o sinal do modo vem só do lançador; a CLI sem ele continua no modo clone', () => {
  const env = { ...process.env, HOME: os.tmpdir() };
  delete env.SERVER_DASHBOARD_MODO;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli', 'index.js'), 'status'], { env, encoding: 'utf8', timeout: 60000 });
  assert.match(r.stdout, new RegExp(`pasta: ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(r.stdout, /dados:/);
});
