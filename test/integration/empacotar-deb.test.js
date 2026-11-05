// npm run empacotar-deb (F9 do #92, ADR 0042 item 10 e ADR 0049): gera o .deb de um repositório
// git temporário com os arquivos do pacote desta pasta e confere que ele é reprodutível (umask e
// fuso diferentes dão os mesmos bytes), que tudo sai da ref (nunca da pasta de trabalho), que o
// dono é root e as permissões são fixas, e que o conteúdo é o da tabela da ADR 0042.
// Sem o dpkg-deb, pula com o motivo; no CI (CI=true), falha.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../server/config.js';
import { aoFim } from '../../test-support/limpeza.js';

const SCRIPT = path.join(ROOT, 'scripts', 'empacotar-deb.mjs');
const ENV_GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const temDpkg = spawnSync('dpkg-deb', ['--version']).status === 0;
if (!temDpkg && process.env.CI === 'true') {
  throw new Error('CI=true, mas o dpkg-deb não está instalado: o pacote ficaria sem conferência');
}
const semDpkg = !temDpkg && 'sem o dpkg-deb';
// Data fixa do commit (SOURCE_DATE_EPOCH do pacote).
const DATA = 1793836800;
// Os arquivos que o pacote leva desta pasta.
const ORIGENS = ['bin/dashboard', 'libexec/atualizador', 'docs/allowed_signers', 'scripts/completar.bash', 'LICENSE',
  ...fs.readdirSync(path.join(ROOT, 'pacote'), { recursive: true }).map((f) => `pacote/${f}`)
    .filter((f) => fs.statSync(path.join(ROOT, f)).isFile())];

/** Repositório temporário com os arquivos do pacote e a tag `v`. */
function repo(t, v = 'v2.90.0-rc.1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empacotar-'));
  aoFim(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  const r = path.join(dir, 'repo');
  for (const f of ORIGENS) {
    fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(r, f));
  }
  fs.mkdirSync(path.join(r, 'server', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(r, 'server', 'cli', 'index.js'), '// CLI\n');
  fs.writeFileSync(path.join(r, 'package.json'), `${JSON.stringify({ name: 'linux-server-dashboard', version: v.slice(1), private: true }, null, 2)}\n`);
  const env = { ...process.env, ...ENV_GIT, GIT_AUTHOR_DATE: `@${DATA} +0000`, GIT_COMMITTER_DATE: `@${DATA} +0000` };
  const git = (...args) => {
    const x = spawnSync('git', ['-C', r, ...args], { encoding: 'utf8', env });
    assert.equal(x.status, 0, x.stderr);
    return x.stdout;
  };
  git('init', '-q');
  git('-c', 'user.email=teste@example.com', '-c', 'user.name=Teste', 'add', '-A');
  git('-c', 'user.email=teste@example.com', '-c', 'user.name=Teste', 'commit', '-q', '-m', v);
  git('-c', 'user.email=teste@example.com', '-c', 'user.name=Teste', 'tag', '-a', v, '-m', v);
  return { dir, r, git };
}

/**
 * Roda o script com um umask e um fuso; devolve o código e o texto. Sem shell: o umask vale para
 * este processo só durante a chamada e passa ao filho, e os argumentos vão em lista.
 */
function empacotar(args, { umask = 0o022, tz = 'UTC' } = {}) {
  const antes = process.umask(umask);
  try {
    const x = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    return { codigo: x.status, texto: `${x.stdout}${x.stderr}` };
  } finally {
    process.umask(antes);
  }
}

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('empacotar-deb: a mesma tag dá os mesmos bytes, com qualquer umask e fuso', { skip: semDpkg }, (t) => {
  const { dir, r } = repo(t);
  const a = empacotar(['--repo', r, '--ref', 'v2.90.0-rc.1', '--saida', path.join(dir, 'a')]);
  assert.equal(a.codigo, 0, a.texto);
  // Mudança na pasta de trabalho sem commit não entra no pacote: tudo sai da ref.
  fs.appendFileSync(path.join(r, 'bin', 'dashboard'), '# fora do commit\n');
  const b = empacotar(['--repo', r, '--ref', 'v2.90.0-rc.1', '--saida', path.join(dir, 'b')], { umask: 0o077, tz: 'America/Sao_Paulo' });
  assert.equal(b.codigo, 0, b.texto);
  const nome = 'server-dashboard_2.90.0~rc.1_all.deb';
  assert.equal(sha256(path.join(dir, 'a', nome)), sha256(path.join(dir, 'b', nome)));
  assert.equal(fs.readFileSync(path.join(dir, 'a', 'SHA256SUMS'), 'utf8'), `${sha256(path.join(dir, 'a', nome))}  ${nome}\n`);
  assert.match(a.texto, /ssh-keygen -Y sign -f <chave privada> -n server-dashboard /);
});

test('empacotar-deb: conteúdo da ADR 0042, dono root, permissões e data fixas', { skip: semDpkg }, (t) => {
  const { dir, r, git } = repo(t);
  assert.equal(empacotar(['--repo', r, '--ref', 'v2.90.0-rc.1', '--saida', path.join(dir, 'a')]).codigo, 0);
  const deb = path.join(dir, 'a', 'server-dashboard_2.90.0~rc.1_all.deb');
  const campo = (c) => spawnSync('dpkg-deb', ['-f', deb, c], { encoding: 'utf8' }).stdout.trim();
  assert.equal(campo('Package'), 'server-dashboard');
  assert.equal(campo('Version'), '2.90.0~rc.1');
  assert.equal(campo('Architecture'), 'all');
  assert.match(campo('Depends'), /polkitd/);
  assert.match(campo('Depends'), /curl \| wget/);

  const linhas = spawnSync('dpkg-deb', ['-c', deb], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).stdout.trim().split('\n');
  const entradas = Object.fromEntries(linhas.map((l) => {
    const m = l.match(/^(\S+) (\S+)\s+\d+ (\S+ \S+) \.\/(.*?)(?: -> (.*))?$/);
    assert.ok(m, l);
    return [m[4].replace(/\/$/, ''), { modo: m[1], dono: m[2], data: m[3], alvo: m[5] }];
  }));
  const quando = new Date(DATA * 1000).toISOString().slice(0, 16).replace('T', ' ');
  for (const [p, e] of Object.entries(entradas)) {
    assert.equal(e.dono, 'root/root', p);
    assert.equal(e.data, quando, p);
    // Nada gravável por outros, nem pelo grupo.
    assert.match(e.modo, /^.....-..-.$|^l/, `${p}: ${e.modo}`);
  }
  const arquivos = Object.entries(entradas).filter(([, e]) => e.modo.startsWith('-'));
  assert.deepEqual(arquivos.map(([p]) => p).sort(), [
    'opt/server-dashboard/bin/dashboard',
    'opt/server-dashboard/libexec/atualizador',
    'opt/server-dashboard/share/allowed_signers',
    'opt/server-dashboard/share/semente.tar',
    'usr/lib/systemd/system/server-dashboard-atualizar.service',
    'usr/lib/systemd/system/server-dashboard-verificar.service',
    'usr/lib/systemd/system/server-dashboard-verificar.timer',
    'usr/lib/systemd/system/server-dashboard-voltar.service',
    'usr/lib/sysusers.d/server-dashboard.conf',
    'usr/share/bash-completion/completions/dashboard',
    'usr/share/doc/server-dashboard/copyright',
    'usr/share/polkit-1/rules.d/50-server-dashboard.rules',
  ]);
  for (const [p, e] of arquivos) {
    assert.equal(e.modo, /\/(bin\/dashboard|atualizador)$/.test(p) ? '-rwxr-xr-x' : '-rw-r--r--', p);
  }
  assert.equal(entradas['opt/server-dashboard/atual'].alvo, 'versoes/atual');
  assert.equal(entradas['usr/bin/dashboard'].alvo, '/opt/server-dashboard/bin/dashboard');
  // Pastas do executor ficam fora do dpkg: o postinst as cria do _server-dashboard.
  for (const p of ['repo.git', 'versoes', 'estado', 'node']) assert.equal(entradas[`opt/server-dashboard/${p}`], undefined, p);

  // Os bytes de cada arquivo são os da ref, e o md5sums confere.
  const x = path.join(dir, 'x');
  assert.equal(spawnSync('dpkg-deb', ['-R', deb, x]).status, 0);
  const md5 = fs.readFileSync(path.join(x, 'DEBIAN', 'md5sums'), 'utf8').trim().split('\n');
  assert.equal(md5.length, arquivos.length);
  for (const l of md5) {
    const [soma, p] = l.split('  ');
    assert.equal(crypto.createHash('md5').update(fs.readFileSync(path.join(x, p))).digest('hex'), soma, p);
  }
  for (const [destino, origem] of [['opt/server-dashboard/libexec/atualizador', 'libexec/atualizador'],
    ['usr/share/polkit-1/rules.d/50-server-dashboard.rules', 'pacote/polkit/50-server-dashboard.rules'],
    ['DEBIAN/postinst', 'pacote/debian/postinst'], ['DEBIAN/prerm', 'pacote/debian/prerm'], ['DEBIAN/postrm', 'pacote/debian/postrm']]) {
    assert.deepEqual(fs.readFileSync(path.join(x, destino)), fs.readFileSync(path.join(r, origem)), destino);
  }
  // A semente é o git archive da tag, como o executor extrai.
  const arq = spawnSync('git', ['-C', r, 'archive', '--format=tar', 'v2.90.0-rc.1'], { env: { ...process.env, ...ENV_GIT } }).stdout;
  assert.deepEqual(fs.readFileSync(path.join(x, 'opt/server-dashboard/share/semente.tar')), arq);
  assert.ok(git('rev-parse', 'v2.90.0-rc.1'));
});

test('empacotar-deb recusa tag com outra versão, ref estranha e opção desconhecida', { skip: semDpkg }, (t) => {
  const { dir, r, git } = repo(t);
  git('-c', 'user.email=teste@example.com', '-c', 'user.name=Teste', 'tag', '-a', 'v2.91.0', '-m', 'v2.91.0');
  const saida = path.join(dir, 'a');
  assert.match(empacotar(['--repo', r, '--ref', 'v2.91.0', '--saida', saida]).texto, /a tag v2\.91\.0 traz a versão 2\.90\.0-rc\.1/);
  assert.match(empacotar(['--repo', r, '--ref', '--upload-pack=x', '--saida', saida]).texto, /ref inválida/);
  assert.match(empacotar(['--repo', r, '--ref', 'v2.90.0-rc.1', '--outra', 'x']).texto, /opção inválida: --outra/);
  assert.equal(fs.existsSync(saida), false);
});

test('CI: o pacote é gerado 2 vezes no verificação e conferido contra o Release assinado', () => {
  const sem = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/(^|\s)#.*$/gm, '$1');
  const ver = sem('.github/workflows/seguranca.yml');
  assert.match(ver, /npm run empacotar-deb -- --ref HEAD --saida "\$RUNNER_TEMP\/a"/);
  assert.match(ver, /umask 077[^\n]*npm run empacotar-deb -- --ref HEAD --saida "\$RUNNER_TEMP\/b"/);
  assert.match(ver, /cmp "\$RUNNER_TEMP\/a\/SHA256SUMS" "\$RUNNER_TEMP\/b\/SHA256SUMS"/);
  const pub = sem('.github/workflows/pacote.yml');
  assert.match(pub, /release:\s*\n\s+types: \[published\]/);
  // A tag do Release só entra pelo ambiente e passa pelo padrão antes de qualquer uso.
  for (const l of pub.split('\n').filter((x) => x.includes('${{'))) assert.match(l, /^\s+(TAG|ref): \$\{\{/, l);
  assert.match(pub, /grep -Eq '\^v2\\\.\[0-9\]\+\\\.\[0-9\]\+/);
  assert.match(pub, /ssh-keygen -Y verify -f docs\/allowed_signers -I tsouza-thiago -n server-dashboard/);
  assert.match(pub, /cmp SHA256SUMS "\$RUNNER_TEMP\/novo\/SHA256SUMS"/);
});
