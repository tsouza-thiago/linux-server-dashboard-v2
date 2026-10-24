// Servidor que só aceita chave (#61, ADR 0021), com sshd de verdade: SSH só por chave,
// AuthenticationMethods publickey e MaxAuthTries 1; a chave do administrador tem passphrase
// e um apelido num ssh config. O painel lê o apelido com `ssh -G`, confere o ssh-agent e
// conecta só com aquela chave, mesmo com outras chaves no agente. Pulado sem OpenSSH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSshd, keygen } from '../../test-support/sshd.js';
import { resolveAlias, checkAgentKey, runAdmin, describeAdminError } from '../../server/setup/remoto.js';
import { detectionScript, parseDetection } from '../../server/setup/deteccao.js';
import { esperarAte } from '../../test-support/esperar.js';

const FRASE = 'frase longa da chave do administrador';

/** ssh-agent próprio do teste, num socket da pasta temporária. */
async function startAgent(dir) {
  const sock = path.join(dir, 'agente.sock');
  const child = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
  await esperarAte(() => fs.existsSync(sock), { timeoutMs: 5000 });
  return { sock, stop: () => child.kill('SIGKILL') };
}

/** ssh-add com a passphrase entregue por um askpass do teste (a pessoa digitaria no terminal). */
function sshAdd(sock, key, dir) {
  const askpass = path.join(dir, 'askpass.sh');
  fs.writeFileSync(askpass, `#!/bin/sh\necho '${FRASE}'\n`, { mode: 0o700 });
  execFileSync('ssh-add', ['-t', '900', key], {
    stdio: 'ignore', env: { ...process.env, SSH_AUTH_SOCK: sock, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' },
  });
}

test('sshd só com chave: apelido + ssh-agent + só a chave do apelido (MaxAuthTries 1)', async (t) => {
  const sshd = await startSshd({ extraConfig: ['AuthenticationMethods publickey', 'MaxAuthTries 1', 'PermitRootLogin prohibit-password'] });
  if (!sshd) return t.skip('OpenSSH (ssh/sshd) não disponível');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-chave-'));
  t.after(() => { sshd.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const key = path.join(dir, 'chave_admin');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', FRASE, '-C', 'admin', '-f', key]);
  sshd.setAuthorizedKeys(fs.readFileSync(`${key}.pub`, 'utf8').trim());
  const knownHosts = path.join(dir, 'known_hosts');
  fs.writeFileSync(knownHosts, `${sshd.knownHostsLine}\n`);
  const agent = await startAgent(dir);
  t.after(agent.stop);
  const configFile = path.join(dir, 'config');
  fs.writeFileSync(configFile, [
    'Host meu-servidor', '  HostName 127.0.0.1', `  Port ${sshd.port}`, `  User ${sshd.user}`, `  IdentityFile ${key}`, `  IdentityAgent ${agent.sock}`,
    'Host com-salto', '  HostName 127.0.0.1', '  ProxyJump outra-maquina', '',
  ].join('\n'));

  // 1. O apelido, lido sem conectar; o com salto é recusado.
  const a = await resolveAlias('meu-servidor', { configFile, home: dir });
  assert.equal(a.ok, true, a.erro);
  assert.deepEqual([a.host, a.port, a.user, a.identityFile, a.identityAgent], ['127.0.0.1', sshd.port, sshd.user, key, agent.sock]);
  assert.match((await resolveAlias('com-salto', { configFile, home: dir })).erro, /ProxyJump/);

  // 2. Agente sem a chave: o painel diz o ssh-add, e a conexão não pergunta nada (BatchMode).
  const conn = { host: a.host, port: a.port, user: a.user, identityFile: a.identityFile, identityAgent: a.identityAgent, knownHosts, hostKeyType: 'ssh-ed25519' };
  assert.deepEqual(await checkAgentKey({ ...a, home: dir }), { ok: false, motivo: 'falta', comando: `ssh-add -t 15m ~/chave_admin` });
  const semChave = await runAdmin({ ...conn, script: 'echo oi\n', timeoutMs: 20000 });
  assert.notEqual(semChave.code, 0);
  assert.match(describeAdminError(semChave), /recusou a chave/);

  // 3. Outras chaves no agente antes da certa: com IdentitiesOnly, só a do apelido é oferecida
  // (sem isso, o MaxAuthTries 1 derrubaria a conexão na primeira chave errada).
  for (const n of ['outra1', 'outra2']) {
    keygen(path.join(dir, n));
    execFileSync('ssh-add', [path.join(dir, n)], { stdio: 'ignore', env: { ...process.env, SSH_AUTH_SOCK: agent.sock } });
  }
  sshAdd(agent.sock, key, dir);
  assert.deepEqual(await checkAgentKey({ ...a, home: dir }), { ok: true, via: 'agente' });
  const r = await runAdmin({ ...conn, script: detectionScript(), timeoutMs: 30000 });
  assert.equal(r.code, 0, `${r.stderr}\n${sshd.log()}`);
  const det = parseDetection(r.stdout);
  assert.equal(det.user, sshd.user);
  assert.ok(['root', 'nopasswd', 'pede-senha', 'requiretty', 'nao', 'ausente'].includes(det.sudo));
  assert.equal(det.clientIp, '127.0.0.1');
});
