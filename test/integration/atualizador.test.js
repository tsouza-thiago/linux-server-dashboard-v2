// Executor do modo sistema (libexec/atualizador, F9 etapa 4, ADR 0042 e 0044): montado numa pasta
// temporária com o layout do pacote (<base>/libexec, repo.git, versoes, atual, estado), contra uma
// origem git local com tags assinadas por uma chave de teste. Confere que só tag assinada pelas
// chaves da versão atual passa, que o atualizar só instala o que o verificar gravou, que a troca
// de link é completa ou nenhuma e que o voltar vale só por 24 h. Nada sai da máquina.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../server/config.js';
import { aoFim } from '../../test-support/limpeza.js';

const EXECUTOR = path.join(ROOT, 'libexec', 'atualizador');
const ENV_GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

// Pacote falso com a versão 2.90.0 instalada (o que a semente do .deb faria) e uma origem.
function montar(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atualizador-'));
  aoFim(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base');
  const origem = path.join(dir, 'origem');
  for (const d of ['libexec', 'versoes', 'estado']) fs.mkdirSync(path.join(base, d), { recursive: true });
  fs.copyFileSync(EXECUTOR, path.join(base, 'libexec', 'atualizador'));
  fs.chmodSync(path.join(base, 'libexec', 'atualizador'), 0o755);

  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV_GIT } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const chave = (nome) => {
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', nome, '-f', path.join(dir, nome)]);
    return fs.readFileSync(path.join(dir, `${nome}.pub`), 'utf8').split(' ').slice(0, 2).join(' ');
  };
  const boa = chave('chave');
  chave('estranha');

  fs.mkdirSync(path.join(origem, 'server', 'cli'), { recursive: true });
  fs.mkdirSync(path.join(origem, 'docs'));
  fs.writeFileSync(path.join(origem, 'docs', 'allowed_signers'), `teste@example.com namespaces="git" ${boa}\n`);
  git(origem, 'init', '-q');
  git(origem, 'config', 'user.email', 'teste@example.com');
  git(origem, 'config', 'user.name', 'Mantenedor (teste)');

  /** Commit e tag de `v`: assinada pela chave boa (padrão), pela `estranha` ou sem assinatura. */
  const publicar = (v, { assinatura = 'chave', semCodigo = false } = {}) => {
    const cli = path.join(origem, 'server', 'cli', 'index.js');
    if (semCodigo) fs.rmSync(cli, { force: true });
    else fs.writeFileSync(cli, `// versão ${v}\n`);
    fs.writeFileSync(path.join(origem, 'CHANGELOG.md'), `# Changelog\n\n## [${v}] — 2026-11-05\n\n- Novidade da ${v}.\n`);
    git(origem, 'add', '-A');
    git(origem, 'commit', '-q', '-m', v);
    if (assinatura) {
      git(origem, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${path.join(dir, assinatura)}`,
        'tag', '-s', `v${v}`, '-m', v);
    } else {
      git(origem, 'tag', '-a', `v${v}`, '-m', v);
    }
  };

  publicar('2.90.0');
  // A versão instalada, extraída da tag como o executor faz.
  fs.mkdirSync(path.join(base, 'versoes', 'v2.90.0'));
  const arq = spawnSync('sh', ['-c', `git -C "${origem}" archive v2.90.0 | tar -x -C "${path.join(base, 'versoes', 'v2.90.0')}"`]);
  assert.equal(arq.status, 0);
  // O link que o executor troca fica em versoes/; o da base é fixo, do pacote (ADR 0045).
  fs.symlinkSync('v2.90.0', path.join(base, 'versoes', 'atual'));
  fs.symlinkSync('versoes/atual', path.join(base, 'atual'));
  spawnSync('git', ['init', '-q', '--bare', path.join(base, 'repo.git')], { env: { ...process.env, ...ENV_GIT } });
  git(path.join(base, 'repo.git'), 'remote', 'add', 'origin', origem);
  // A base é do pacote (root) e a unidade systemd não deixa gravar nela: aqui, só leitura.
  fs.chmodSync(base, 0o555);
  aoFim(t, () => fs.chmodSync(base, 0o755));

  // Roda pelo caminho dado (o link do teste da base) com variáveis que o executor precisa ignorar.
  const rodar = (sub, { via = path.join(base, 'libexec', 'atualizador') } = {}) => {
    const r = spawnSync(via, sub === undefined ? [] : [].concat(sub), {
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: path.join(dir, 'nao-existe'), BASE: path.join(dir, 'outra') },
    });
    return { codigo: r.status, texto: `${r.stdout}${r.stderr}` };
  };
  const estado = (nome) => {
    const f = path.join(base, 'estado', nome);
    if (!fs.existsSync(f)) return {};
    return Object.fromEntries(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  };
  const link = (nome) => {
    try { return fs.readlinkSync(path.join(base, 'versoes', nome)); } catch { return null; }
  };
  /** As versões extraídas em versoes/, sem os links. */
  const versoes = () => fs.readdirSync(path.join(base, 'versoes')).filter((n) => /^v/.test(n)).sort();
  return { dir, base, origem, git, publicar, rodar, estado, link, versoes };
}

test('atualizador: verificar acha a assinada mais nova e grava em estado/', (t) => {
  const p = montar(t);
  p.publicar('2.91.0');
  const r = p.rodar('verificar');
  assert.equal(r.codigo, 0, r.texto);
  const d = p.estado('disponivel');
  assert.equal(d.versao, 'v2.91.0');
  assert.match(d.objeto, /^[0-9a-f]{40}$/);
  assert.equal(d.erro, '');
  assert.match(fs.readFileSync(path.join(p.base, 'estado', 'novidades.md'), 'utf8'), /Novidade da 2\.91\.0/);
  assert.match(fs.readFileSync(path.join(p.base, 'estado', 'registro.log'), 'utf8'), /versão nova v2\.91\.0/);
  // Estado é leitura para todos, sem segredo.
  assert.equal(fs.statSync(path.join(p.base, 'estado', 'disponivel')).mode & 0o777, 0o644);
});

test('atualizador: tag sem assinatura, de chave fora da lista ou com nome trocado é recusada', (t) => {
  const p = montar(t);
  p.publicar('2.91.0', { assinatura: null });
  p.publicar('2.92.0', { assinatura: 'estranha' });
  // A tag velha assinada (2.90.0) publicada como 2.93.0: a assinatura confere, o nome não.
  p.git(p.origem, 'tag', 'v2.93.0', p.git(p.origem, 'rev-parse', 'refs/tags/v2.90.0'));
  const r = p.rodar('verificar');
  assert.equal(r.codigo, 0, r.texto);
  assert.equal(p.estado('disponivel').versao, '');
  for (const v of ['v2.91.0', 'v2.92.0', 'v2.93.0']) assert.match(r.texto, new RegExp(`${v.replaceAll('.', '\\.')} recusada`));
  // Com uma assinada abaixo das recusadas, ela é a escolhida.
  const q = montar(t);
  q.publicar('2.91.0');
  q.publicar('2.92.0', { assinatura: null });
  assert.equal(q.rodar('verificar').codigo, 0);
  assert.equal(q.estado('disponivel').versao, 'v2.91.0');
});

test('atualizar sem verificar é recusado e não mexe no atual', (t) => {
  const p = montar(t);
  p.publicar('2.91.0');
  const r = p.rodar('atualizar');
  assert.equal(r.codigo, 1);
  assert.match(r.texto, /nenhuma versão verificada/);
  assert.equal(p.link('atual'), 'v2.90.0');
  assert.equal(p.link('anterior'), null);
});

test('atualizar troca atual e anterior, sem sobra, e confere a tag de novo', (t) => {
  const p = montar(t);
  p.publicar('2.91.0');
  assert.equal(p.rodar('verificar').codigo, 0);
  const r = p.rodar('atualizar');
  assert.equal(r.codigo, 0, r.texto);
  assert.equal(p.link('atual'), 'v2.91.0');
  assert.equal(p.link('anterior'), 'v2.90.0');
  assert.equal(fs.readFileSync(path.join(p.base, 'atual', 'server', 'cli', 'index.js'), 'utf8'), '// versão 2.91.0\n');
  // Nada temporário fica para trás (nem a versão .tmp, nem o link .novo).
  assert.deepEqual(p.versoes(), ['v2.90.0', 'v2.91.0']);
  assert.ok(!fs.readdirSync(path.join(p.base, 'versoes')).some((n) => n.endsWith('.novo')));
  // O link fixo da base não muda: ele segue versoes/atual.
  assert.equal(fs.readlinkSync(path.join(p.base, 'atual')), 'versoes/atual');
  const troca = p.estado('troca');
  assert.equal(troca.de, 'v2.90.0');
  assert.equal(troca.para, 'v2.91.0');
  assert.equal(p.estado('disponivel').versao, '');
  // Um 2º atualizar não tem o que instalar.
  assert.equal(p.rodar('atualizar').codigo, 1);
});

test('atualizar recusa versão gravada que não confere com a tag', (t) => {
  const p = montar(t);
  p.publicar('2.91.0');
  p.publicar('2.92.0', { assinatura: null });
  assert.equal(p.rodar('verificar').codigo, 0);
  const arq = path.join(p.base, 'estado', 'disponivel');
  const original = fs.readFileSync(arq, 'utf8');
  // Objeto diferente do que o verificar conferiu.
  fs.writeFileSync(arq, original.replace(/objeto=.*/, `objeto=${'0'.repeat(40)}`));
  assert.match(p.rodar('atualizar').texto, /mudou depois do verificar/);
  // Uma versão sem assinatura escrita à mão em estado/.
  p.git(path.join(p.base, 'repo.git'), 'fetch', '-q', 'origin', 'refs/tags/v2.92.0:refs/tags/v2.92.0');
  const objeto = p.git(path.join(p.base, 'repo.git'), 'rev-parse', 'refs/tags/v2.92.0');
  fs.writeFileSync(arq, `versao=v2.92.0\nobjeto=${objeto}\nverificado=1\nerro=\n`);
  assert.match(p.rodar('atualizar').texto, /assinatura de v2\.92\.0 não confere/);
  assert.equal(p.link('atual'), 'v2.90.0');
});

test('atualizar com extração incompleta não troca nada', (t) => {
  const p = montar(t);
  p.publicar('2.91.0', { semCodigo: true });
  assert.equal(p.rodar('verificar').codigo, 0);
  const r = p.rodar('atualizar');
  assert.equal(r.codigo, 1);
  assert.match(r.texto, /incompleta/);
  assert.equal(p.link('atual'), 'v2.90.0');
  assert.deepEqual(p.versoes(), ['v2.90.0']);
});

test('voltar troca atual por anterior uma vez, só até 24 h depois da troca', (t) => {
  const p = montar(t);
  assert.match(p.rodar('voltar').texto, /nenhuma troca para desfazer/);
  p.publicar('2.91.0');
  p.rodar('verificar');
  assert.equal(p.rodar('atualizar').codigo, 0);
  const r = p.rodar('voltar');
  assert.equal(r.codigo, 0, r.texto);
  assert.equal(p.link('atual'), 'v2.90.0');
  assert.equal(p.link('anterior'), null);
  assert.equal(p.rodar('voltar').codigo, 1, 'um 2º voltar nunca vale');

  // Fora do prazo: a mesma troca, com a data de 24 h e 1 s atrás.
  const q = montar(t);
  q.publicar('2.91.0');
  q.rodar('verificar');
  assert.equal(q.rodar('atualizar').codigo, 0);
  const arq = path.join(q.base, 'estado', 'troca');
  const velha = Math.floor(Date.now() / 1000) - 86401;
  fs.writeFileSync(arq, fs.readFileSync(arq, 'utf8').replace(/em=\d+/, `em=${velha}`));
  const fora = q.rodar('voltar');
  assert.equal(fora.codigo, 1);
  assert.match(fora.texto, /só vale até 24 h/);
  assert.equal(q.link('atual'), 'v2.91.0');
});

test('atualizador: a pasta vem do caminho real, e a entrada é só 1 subcomando conhecido', (t) => {
  const p = montar(t);
  p.publicar('2.91.0');
  // Por um link de fora (como uma unidade systemd chamaria), com GIT_DIR e BASE falsos no ambiente.
  const via = path.join(p.dir, 'link-do-executor');
  fs.symlinkSync(path.join(p.base, 'libexec', 'atualizador'), via);
  assert.equal(p.rodar('verificar', { via }).codigo, 0);
  assert.equal(p.estado('disponivel').versao, 'v2.91.0');
  assert.equal(p.rodar(undefined).codigo, 2);
  assert.equal(p.rodar(['verificar', 'v2.91.0']).codigo, 2);
  assert.equal(p.rodar('instalar').codigo, 2);
  // Trava de um processo vivo barra a 2ª operação; a de um processo morto é tirada.
  fs.mkdirSync(path.join(p.base, 'estado', 'trava'));
  fs.writeFileSync(path.join(p.base, 'estado', 'trava', 'pid'), `${process.pid}\n`);
  assert.match(p.rodar('verificar').texto, /em andamento/);
  fs.writeFileSync(path.join(p.base, 'estado', 'trava', 'pid'), '999999999\n');
  assert.equal(p.rodar('verificar').codigo, 0);
  assert.ok(!fs.existsSync(path.join(p.base, 'estado', 'trava')));
});

// Cada unidade systemd (pacote/systemd/, ADR 0045) só deixa gravar nas pastas do seu
// ReadWritePaths=. Aqui as outras pastas do pacote ficam só leitura, e cada subcomando precisa
// funcionar assim. Uma gravação nova fora da lista quebra este teste antes de quebrar o pacote.
test('atualizador: cada subcomando grava só nas pastas que a sua unidade systemd libera', (t) => {
  const p = montar(t);
  p.publicar('2.91.0');
  const pastas = ['repo.git', 'versoes', 'estado'];
  /** Pastas (relativas à base) do ReadWritePaths= da unidade do subcomando. */
  const liberadas = (sub) => {
    const texto = fs.readFileSync(path.join(ROOT, 'pacote', 'systemd', `server-dashboard-${sub}.service`), 'utf8');
    return texto.match(/^ReadWritePaths=(.*)$/m)[1].split(/\s+/).map((c) => path.relative('/opt/server-dashboard', c));
  };
  /** Trava (0555) ou solta (0755) todas as pastas abaixo de `raiz`, inclusive ela. */
  const modo = (raiz, m) => {
    for (const d of [raiz, ...fs.readdirSync(raiz, { recursive: true }).map((n) => path.join(raiz, n))]) {
      if (fs.lstatSync(d).isDirectory()) fs.chmodSync(d, m);
    }
  };
  aoFim(t, () => { for (const d of pastas) modo(path.join(p.base, d), 0o755); });
  for (const sub of ['verificar', 'atualizar', 'voltar']) {
    const livres = liberadas(sub);
    assert.ok(livres.every((d) => pastas.includes(d) || d === 'node'), `${sub}: ${livres}`);
    for (const d of pastas) modo(path.join(p.base, d), livres.includes(d) ? 0o755 : 0o555);
    const r = p.rodar(sub);
    assert.equal(r.codigo, 0, `${sub}: ${r.texto}`);
  }
  assert.equal(p.link('atual'), 'v2.90.0');
  assert.match(p.estado('troca').voltou, /^\d+$/);
});
