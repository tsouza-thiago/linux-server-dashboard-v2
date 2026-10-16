// Tags assinadas (ADR 0012) com git e chave SSH de verdade num repositório temporário:
// assinada pela chave listada passa; sem assinatura, com outra chave ou sem chaves não.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyTag, currentVersionStatus, signedReleaseTags, compareVersions, describeVersion, installTag,
} from '../../server/setup/assinatura.js';

const hasTools = !spawnSync('git', ['--version']).error && !spawnSync('ssh-keygen', ['-?']).error;

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.email', 'mantenedor@example.com');
  git('config', 'user.name', 'Mantenedor');
  for (const name of ['chave', 'outra']) spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', path.join(dir, `.${name}`)]);
  fs.mkdirSync(path.join(dir, 'docs'));
  const pub = fs.readFileSync(path.join(dir, '.chave.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(path.join(dir, 'docs', 'allowed_signers'), `# chave do projeto\nmantenedor@example.com namespaces="git" ${pub}\n`);
  git('add', 'docs');
  git('commit', '-q', '-m', 'inicio');
  const sign = (tag, key = 'chave') => git('-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${path.join(dir, `.${key}`)}`, 'tag', '-s', tag, '-m', tag);
  return { dir, git, sign };
}

test('assinatura: só passa a tag assinada pela chave de docs/allowed_signers', { skip: !hasTools }, (t) => {
  const { dir, git, sign } = repo(t);
  assert.deepEqual(currentVersionStatus(dir), { ok: false, reason: 'sem-tag' });
  sign('v2.0.0-alpha.8');
  assert.deepEqual(currentVersionStatus(dir), { ok: true, tag: 'v2.0.0-alpha.8' });
  git('tag', 'v2.0.0-alpha.99');
  assert.deepEqual(currentVersionStatus(dir), { ok: true, tag: 'v2.0.0-alpha.8' }, 'tag sem assinatura no mesmo commit não derruba a assinada');
  git('tag', '-d', 'v2.0.0-alpha.99');
  git('tag', '-a', 'v2.0.0-alpha.9', '-m', 'sem assinatura');
  assert.equal(verifyTag(dir, 'v2.0.0-alpha.9').reason, 'sem-assinatura');
  git('tag', 'v2.0.0-alpha.10');
  assert.equal(verifyTag(dir, 'v2.0.0-alpha.10').reason, 'sem-assinatura', 'tag leve (criada pela interface do GitHub)');
  sign('v2.0.0-beta.1', 'outra');
  assert.equal(verifyTag(dir, 'v2.0.0-beta.1').reason, 'invalida', 'chave que não está na lista');
  sign('v2.0.0');
  assert.equal(verifyTag(dir, 'v1.0.0').reason, 'tag-invalida', 'fora do padrão v2.x');
  assert.deepEqual(signedReleaseTags(dir), ['v2.0.0', 'v2.0.0-alpha.8']);
  assert.deepEqual(signedReleaseTags(dir, { includePre: false }), ['v2.0.0']);
  sign('v2.0.1-rc.1');
  assert.equal(installTag(signedReleaseTags(dir)), 'v2.0.0', 'instalação nova fica na estável, não na rc mais nova');
  assert.equal(installTag(signedReleaseTags(dir), { pre: true }), 'v2.0.1-rc.1', '--pre escolhe a mais nova de todas');
  assert.equal(installTag(['v2.0.0-beta.2', 'v2.0.0-beta.1']), 'v2.0.0-beta.2', 'sem estável, a pré-versão mais nova');
  assert.equal(installTag([]), null);
  const empty = path.join(dir, 'vazio');
  fs.writeFileSync(empty, '# nada\n');
  assert.equal(verifyTag(dir, 'v2.0.0', { signersFile: empty }).reason, 'sem-chaves');
  assert.equal(currentVersionStatus(os.tmpdir()).ok, false);
});

test('versões: ordem SemVer com alpha < beta < rc < final; frases para a tela', () => {
  const list = ['v2.0.0', 'v2.0.0-rc.1', 'v2.0.0-alpha.10', 'v2.0.0-alpha.9', 'v2.0.0-beta.2', 'v2.1.0-alpha.1'];
  assert.deepEqual([...list].sort(compareVersions), ['v2.0.0-alpha.9', 'v2.0.0-alpha.10', 'v2.0.0-beta.2', 'v2.0.0-rc.1', 'v2.0.0', 'v2.1.0-alpha.1']);
  assert.equal(compareVersions('lixo', 'v2.0.0'), 0);
  assert.equal(describeVersion({ ok: true, tag: 'v2.0.0' }), 'versão v2.0.0 — assinatura conferida');
  assert.match(describeVersion({ ok: false, reason: 'invalida', tag: 'v2.0.0' }), /não confere/);
  assert.match(describeVersion({ ok: false, reason: 'sem-tag' }), /não está numa versão publicada/);
});

test('instalação nova: clone do main fica na estável assinada, não na rc mais nova; --pre e tag escolhida à mão são respeitados', { skip: !hasTools }, async (t) => {
  const { preflight } = await import('../../server/cli/instalar.js');
  const { makeOutput } = await import('../../server/cli/saida.js');
  const { dir, git, sign } = repo(t);
  const run = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  const check = (flags = {}) => {
    let text = '';
    const out = makeOutput({ stream: { write: (s) => { text += s; }, isTTY: false }, env: { NO_COLOR: '1' } });
    const r = preflight({ out, root: dir, flags, run, reexec: () => 'reexecutou' });
    return { r, text };
  };
  sign('v2.0.0');
  const stable = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'merge da rc');
  sign('v2.0.1-rc.1');
  // No branch main, com a rc no último commit: troca para a estável.
  let c = check();
  assert.equal(c.r, 'reexecutou');
  assert.match(c.text, /usando a versão estável assinada mais nova: v2\.0\.0/);
  assert.equal(git('rev-parse', 'HEAD'), stable);
  // Tag escolhida à mão (HEAD solto na rc): continua nela.
  git('checkout', '-q', '--detach', 'v2.0.1-rc.1');
  c = check();
  assert.notEqual(c.r, 'reexecutou');
  assert.match(c.text, /versão v2\.0\.1-rc\.1 — assinatura conferida/);
  // --pre no branch: fica na rc.
  git('checkout', '-q', '-B', 'main', 'v2.0.1-rc.1');
  c = check({ pre: true });
  assert.notEqual(c.r, 'reexecutou');
  assert.match(c.text, /versão v2\.0\.1-rc\.1 — assinatura conferida/);
  // Último commit sem tag: também vai para a estável.
  git('commit', '-q', '--allow-empty', '-m', 'trabalho em andamento');
  c = check();
  assert.equal(c.r, 'reexecutou');
  assert.match(c.text, /usando a versão assinada mais nova: v2\.0\.0/);
});
