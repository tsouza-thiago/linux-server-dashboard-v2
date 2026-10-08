// Tags assinadas (ADR 0012) com git e chave SSH de verdade num repositório temporário:
// assinada pela chave listada passa; sem assinatura, com outra chave ou sem chaves não.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyTag, currentVersionStatus, signedReleaseTags, compareVersions, describeVersion,
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
