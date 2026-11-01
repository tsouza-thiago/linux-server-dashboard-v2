// Instalação de verdade numa pasta temporária, para a atualização de ponta a ponta: uma origem git
// com o código deste repositório, tags assinadas por uma chave de teste e um clone que roda o
// ./dashboard de verdade. O HOME é temporário e o ambiente não leva nada do systemd do usuário:
// o serviço real desta máquina nunca é tocado (#118). Nada sai da máquina: o `origin` é uma pasta,
// e o servidor monitorado é um nome .invalid, que nunca resolve.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esperarAte } from './esperar.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// O que o painel precisa para rodar: copiar os testes e as imagens só deixaria tudo mais lento.
const ARQUIVOS = ['dashboard', 'package.json', 'CHANGELOG.md', '.gitignore', 'server', 'public', 'scripts'];
const ENV_GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
// Versão que não liga: suja data/ antes de cair, para provar que a volta atrás restaura.
const QUEBRADA = "import fs from 'node:fs';\nfs.writeFileSync(new URL('../data/estragado.txt', import.meta.url), 'x');\nprocess.exit(1);\n";
export const TOKEN = 'token-de-teste-ponta-a-ponta';

const portaLivre = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/**
 * Sobe a estrutura e devolve os comandos do teste: `dash()` roda o ./dashboard da instalação,
 * `publicar()` assina uma versão nova na origem e `api()` fala com o painel pelo token. Ao
 * terminar, para o painel e apaga tudo.
 */
export async function instalacaoReal(t, { versao = '2.90.0' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-ponta-'));
  const origem = path.join(base, 'origem');
  const pasta = path.join(base, 'instalado');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const porta = await portaLivre();
  for (const dir of [origem, home, bin]) fs.mkdirSync(dir);
  const git = (dir, ...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV_GIT } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  for (const nome of ARQUIVOS) fs.cpSync(path.join(REPO, nome), path.join(origem, nome), { recursive: true });
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'teste', '-f', path.join(base, 'chave')]);
  const chave = fs.readFileSync(path.join(base, 'chave.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  fs.mkdirSync(path.join(origem, 'docs'));
  fs.writeFileSync(path.join(origem, 'docs', 'allowed_signers'), `teste@example.com namespaces="git" ${chave}\n`);
  git(origem, 'init', '-q');
  git(origem, 'config', 'user.email', 'teste@example.com');
  git(origem, 'config', 'user.name', 'Mantenedor (teste)');

  /** Commit e tag assinada de `v`. Com `quebrada`, o painel dessa versão não liga. */
  const publicar = (v, { quebrada = false, changelog = '- Sem novidades.' } = {}) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(origem, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(origem, 'package.json'), `${JSON.stringify({ ...pkg, version: v }, null, 2)}\n`);
    fs.writeFileSync(path.join(origem, 'CHANGELOG.md'), `# Changelog\n\n## [${v}] — 2026-11-02\n\n${changelog}\n`);
    const original = fs.readFileSync(path.join(origem, 'server', 'index.js'));
    if (quebrada) fs.writeFileSync(path.join(origem, 'server', 'index.js'), QUEBRADA);
    git(origem, 'add', '-A');
    git(origem, 'commit', '-q', '-m', v);
    git(origem, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${path.join(base, 'chave')}`, 'tag', '-s', `v${v}`, '-m', v);
    // A próxima versão publicada volta a ligar.
    if (quebrada) fs.writeFileSync(path.join(origem, 'server', 'index.js'), original);
  };

  publicar(versao);
  spawnSync('git', ['clone', '-q', origem, pasta], { env: { ...process.env, ...ENV_GIT } });
  git(pasta, 'checkout', '-q', '--detach', `v${versao}`);
  fs.writeFileSync(path.join(pasta, '.env'), `SSH_HOST=servidor-de-teste.invalid\nPORT=${porta}\nDASH_TOKEN=${TOKEN}\nPOLL_INTERVAL=3600000\n`, { mode: 0o600 });

  // Só o necessário: sem XDG_RUNTIME_DIR nem barramento, o `systemctl --user` não acha o systemd daqui.
  const ambiente = { PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(':'), HOME: home, LANG: 'C.UTF-8', ...ENV_GIT };
  const dash = (args, env = {}) => {
    const r = spawnSync(path.join(pasta, 'dashboard'), args, { cwd: pasta, encoding: 'utf8', env: { ...ambiente, ...env }, timeout: 120000 });
    return { codigo: r.status, texto: `${r.stdout}${r.stderr}` };
  };
  /** Roda o ./dashboard sem esperar, como o executor faz; `fim` é o código de saída. */
  const dashAoFundo = (args) => {
    const filho = spawn(path.join(pasta, 'dashboard'), args, { cwd: pasta, env: ambiente, stdio: 'ignore' });
    t.after(() => filho.kill('SIGKILL'));
    return { filho, fim: new Promise((resolve) => { filho.on('close', resolve); }) };
  };
  const api = (rota, { metodo = 'GET', corpo } = {}) => fetch(`http://127.0.0.1:${porta}${rota}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });

  /** Lê o registro como a tela: o painel cai no meio, e a leitura só tenta de novo. */
  async function fimDaTroca({ timeoutMs = 90000 } = {}) {
    let fim = null;
    await esperarAte(async () => {
      const r = await (await api('/api/atualizacao/registro')).json();
      if (r.fase === 'fim') fim = r;
      return fim;
    }, { timeoutMs, passoMs: 200 });
    return fim;
  }

  /** O estado do painel. Tenta de novo: a conexão guardada pelo fetch caiu junto com o painel antigo. */
  async function estadoNoAr() {
    let estado = null;
    await esperarAte(async () => {
      estado = await (await api('/api/atualizacao')).json();
      return true;
    }, { timeoutMs: 5000, passoMs: 100 });
    return estado;
  }

  /** O botão da tela: procura, confere a versão nova e pede a troca. */
  async function apertarAtualizar(alvo) {
    const procura = await (await api('/api/atualizacao/verificar', { metodo: 'POST', corpo: {} })).json();
    assert.equal(procura.nova, alvo, JSON.stringify(procura));
    const iniciar = await api('/api/atualizacao/iniciar', { metodo: 'POST', corpo: { versao: alvo } });
    assert.equal(iniciar.status, 202);
    return procura;
  }

  t.after(() => {
    dash(['parar']);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { pasta, bin, porta, git, dash, dashAoFundo, publicar, apertarAtualizar, fimDaTroca, estadoNoAr };
}
