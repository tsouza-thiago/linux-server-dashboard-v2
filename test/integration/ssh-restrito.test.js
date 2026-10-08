// Acesso restrito (ADR 0008): a linha do authorized_keys é lida pelo OpenSSH exatamente
// como o comando de coleta, a chave só roda a coleta (qualquer outro comando vira a coleta
// básica), `from=` barra outros endereços e o known_hosts próprio barra servidor trocado.
// A parte com sshd de verdade é pulada se não houver OpenSSH na máquina.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  quoteCommandOption, authorizedKeysLine, sudoersLine, sshConfigText, knownHostsName,
  validHost, validUser, validPort, validDevice, validIp, validAbsPath, validPublicKey, SSH_ALIAS,
} from '../../server/setup/acesso.js';
import { buildForcedScript } from '../../server/collector/builder.js';
import { collect, runSSH } from '../../server/collector/index.js';
import { sshAccess, sshConfigFile, ROOT } from '../../server/config.js';
import { startSshd, keygen } from '../../test-support/sshd.js';

const PUB = `ssh-ed25519 ${'A'.repeat(68)}`;
const FULL = { netIf: 'lo', mounts: ['/', '/tmp'], devs: ['sda', 'nvme0n1'], services: ['ssh', 'cron'] };

/** opt_dequote() do OpenSSH (auth-options.c), linha por linha: só `\"` é especial. */
function opensshDequote(s) {
  assert.equal(s[0], '"', 'falta a aspa inicial');
  let i = 1;
  let out = '';
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && s[i + 1] === '"') i += 1;
    out += s[i];
    i += 1;
  }
  assert.equal(s[i], '"', 'falta a aspa final');
  return { value: out, rest: s.slice(i + 1) };
}

test('authorized_keys: o OpenSSH lê de volta exatamente o comando de coleta', () => {
  const { script } = buildForcedScript(FULL);
  assert.ok(script.includes('"'), 'o script tem aspas duplas (o escape é exercitado)');
  assert.deepEqual(opensshDequote(quoteCommandOption(script)), { value: script, rest: '' });
  for (const tricky of ['a\\"b', 'x "y" z', '\\\\"', 'fim\\x', '"']) {
    assert.equal(opensshDequote(quoteCommandOption(tricky)).value, tricky, tricky);
  }
  assert.throws(() => quoteCommandOption('a\nb'), /quebra de linha/);
  assert.throws(() => quoteCommandOption('termina\\'), /terminado em/);

  const { line, hash } = authorizedKeysLine({ publicKey: PUB, targets: FULL, from: '192.0.2.50' });
  assert.match(line, /^restrict,from="192\.0\.2\.50",command="/);
  assert.ok(line.endsWith(` ${PUB} server-dashboard`));
  const cmd = opensshDequote(line.slice(line.indexOf('command=') + 8));
  assert.equal(cmd.value, script);
  assert.equal(cmd.rest, ` ${PUB} server-dashboard`);
  assert.equal(hash, buildForcedScript(FULL).hash);
  assert.ok(!line.includes('\n'));
  assert.match(authorizedKeysLine({ publicKey: PUB, targets: FULL }).line, /^restrict,command="/, 'from= é opcional');
  assert.throws(() => authorizedKeysLine({ publicKey: 'ssh-rsa AAAA', targets: FULL }), /chave pública/);
  assert.throws(() => authorizedKeysLine({ publicKey: PUB, targets: FULL, from: '1.2.3.4" ,command="sh' }), /origem/);
});

test('sudoers: cada disco listado, nunca curinga, e só o smartctl -H', () => {
  assert.equal(
    sudoersLine({ devs: ['sda', 'sdb', 'sda'] }),
    'dashmon ALL=(root) NOPASSWD: /usr/sbin/smartctl -H /dev/sda, /usr/sbin/smartctl -H /dev/sdb',
  );
  assert.equal(sudoersLine({ devs: [] }), '', 'sem SMART, sem regra');
  assert.equal(sudoersLine({ devs: ['vda'], smartctl: '/usr/bin/smartctl' }), 'dashmon ALL=(root) NOPASSWD: /usr/bin/smartctl -H /dev/vda');
  for (const bad of ['sd*', 'sda,ALL', '../sda', 'sda b', 'SDA']) assert.throws(() => sudoersLine({ devs: [bad] }), /disco/, bad);
  assert.throws(() => sudoersLine({ devs: ['sda'], smartctl: 'smartctl' }), /smartctl/);
  assert.throws(() => sudoersLine({ devs: ['sda'], smartctl: '/usr/sbin/../bin/sh' }), /smartctl/);
});

test('validação das entradas do assistente (portada do install-lib.sh da V1)', () => {
  for (const ok of ['192.0.2.10', 'meu-servidor', 'servidor.local', 'localhost', '2001:db8::1']) assert.ok(validHost(ok), ok);
  for (const bad of ['-oProxyCommand=x', 'a b', 'a/b', 'a;rm', '', 'x'.repeat(254), undefined]) assert.ok(!validHost(bad), String(bad));
  for (const ok of ['root', 'maria', 'admin_1', 'joao.silva']) assert.ok(validUser(ok), ok);
  for (const bad of ['-root', 'root\nHost evil', 'a b', '', '1abc', 'x'.repeat(33)]) assert.ok(!validUser(bad), bad);
  for (const ok of [22, '2222', '65535', 1]) assert.ok(validPort(ok), String(ok));
  for (const bad of [0, '70000', 'abc', '', '22a', null]) assert.ok(!validPort(bad), String(bad));
  for (const ok of ['sda', 'nvme0n1', 'mmcblk0', 'vdb']) assert.ok(validDevice(ok), ok);
  for (const ok of ['192.0.2.50', '2001:db8::5', '::1']) assert.ok(validIp(ok), ok);
  for (const bad of ['256.1.1.1', 'servidor', '1.2.3', '', null]) assert.ok(!validIp(bad), String(bad));
  assert.ok(validAbsPath('/usr/sbin/smartctl'));
  assert.ok(!validAbsPath('/usr/sbin/smartctl -a'));
  assert.ok(validPublicKey(PUB));
  assert.ok(!validPublicKey(`${PUB} comentario`));
});

test('data/ssh/config: só o arquivo do painel, identidade conferida e sem encaminhamentos', () => {
  const text = sshConfigText({ host: '192.0.2.10', port: 2222, keyFile: '/home/m/.ssh/dashboard_ed25519', knownHosts: '/opt/dash/data/ssh/known_hosts' });
  assert.match(text, /^Host servidor$/m);
  assert.match(text, /^ {2}HostName 192\.0\.2\.10$/m);
  assert.match(text, /^ {2}Port 2222$/m);
  assert.match(text, /^ {2}User dashmon$/m);
  assert.match(text, /^ {2}IdentityFile "\/home\/m\/\.ssh\/dashboard_ed25519"$/m);
  assert.match(text, /^ {2}StrictHostKeyChecking yes$/m);
  assert.match(text, /^ {2}GlobalKnownHostsFile \/dev\/null$/m);
  assert.match(text, /^ {2}ClearAllForwardings yes$/m);
  assert.throws(() => sshConfigText({ host: 'a\nHost *', keyFile: '/k', knownHosts: '/h' }), /endereço/);
  assert.throws(() => sshConfigText({ host: 'h', keyFile: '/k"x', knownHosts: '/h' }), /caminho/);
  assert.throws(() => sshConfigText({ host: 'h', port: 0, keyFile: '/k', knownHosts: '/h' }), /porta/);
  assert.equal(knownHostsName('192.0.2.10'), '192.0.2.10');
  assert.equal(knownHostsName('192.0.2.10', 2222), '[192.0.2.10]:2222');
  assert.equal(sshAccess('RESTRITO'), 'restrito');
  assert.equal(sshAccess(''), 'direto');
  assert.equal(sshConfigFile(''), '');
  assert.equal(sshConfigFile('data/ssh/config'), path.join(ROOT, 'data', 'ssh', 'config'));
  assert.equal(sshConfigFile('/etc/ssh/ssh_config'), path.join(ROOT, 'data', 'ssh', 'config'), 'fora de data/ não');
});

test('sshd de verdade: chave restrita só roda a coleta, from= e identidade do servidor valem', async (t) => {
  const sshd = await startSshd();
  if (!sshd) return t.skip('OpenSSH (ssh/sshd) não disponível');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-restrito-'));
  t.after(() => { sshd.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const keyFile = path.join(dir, 'dashboard_ed25519');
  const publicKey = keygen(keyFile).split(' ').slice(0, 2).join(' ');
  const knownHosts = path.join(dir, 'known_hosts');
  fs.writeFileSync(knownHosts, `${sshd.knownHostsLine}\n`);
  const configFile = path.join(dir, 'config');
  fs.writeFileSync(configFile, sshConfigText({ host: '127.0.0.1', port: sshd.port, user: sshd.user, keyFile, knownHosts }));
  const targets = { mounts: ['/'], devs: ['sda'], services: ['ssh-teste-inexistente'], netIf: 'lo' };
  const runner = (h, c) => runSSH(h, c, 15000, { configFile });

  sshd.setAuthorizedKeys(authorizedKeysLine({ publicKey, targets, from: '127.0.0.1' }).line);
  const first = await collect({ host: SSH_ALIAS, targets, runner, access: 'restrito', now: Date.parse('2026-10-08T12:00:00Z') });
  assert.equal(first.ok, true, `${first.error} ${sshd.log()}`);
  const s = first.sample;
  assert.equal(s.collector.complete, true);
  assert.equal(s.collector.hashMismatch, false, 'linha do authorized_keys em dia');
  assert.equal(s.collector.mode, 'smart', '1ª coleta pede o SMART: o modo chega ao comando forçado');
  assert.ok(Array.isArray(s.smart) && s.smart[0].dev === 'sda', 'seção SMART presente');
  const second = await collect({ host: SSH_ALIAS, targets, runner, access: 'restrito', prev: s, now: Date.parse('2026-10-08T12:01:00Z') });
  assert.equal(second.sample.collector.mode, 'basico');

  const evil = await runner(SSH_ALIAS, 'cat /etc/passwd; echo PWNED');
  assert.equal(evil.code, 0);
  assert.ok(evil.stdout.includes('===FIM==='), 'qualquer comando vira a coleta');
  // (o PS da coleta lista o próprio cliente ssh desta máquina, então a palavra pode aparecer
  // dentro de uma linha de processo; o que não pode existir é a linha que o echo imprimiria)
  assert.ok(!/^PWNED$/m.test(evil.stdout) && !/^root:x?:0:/m.test(evil.stdout), 'o comando pedido não roda');
  assert.match(evil.stdout, /===VER===\n\S+ \S+\nbasico\n/, 'pedido estranho vira a coleta básica');

  const changed = await collect({ host: SSH_ALIAS, targets: { ...targets, services: ['cron'] }, runner, access: 'restrito' });
  assert.equal(changed.sample.collector.hashMismatch, true, '.env mudou: avisa que a linha está desatualizada');

  sshd.setAuthorizedKeys(authorizedKeysLine({ publicKey, targets, from: '192.0.2.99' }).line);
  const blocked = await runner(SSH_ALIAS, 'basico');
  assert.notEqual(blocked.code, 0, 'from= de outro endereço: a chave não entra');

  sshd.setAuthorizedKeys(authorizedKeysLine({ publicKey, targets }).line);
  fs.writeFileSync(knownHosts, `[127.0.0.1]:${sshd.port} ${keygen(path.join(dir, 'outro'), 'x').split(' ').slice(0, 2).join(' ')}\n`);
  const spoofed = await collect({ host: SSH_ALIAS, targets, runner, access: 'restrito' });
  assert.equal(spoofed.ok, false, 'identidade do servidor diferente: não conecta');
  assert.match(spoofed.error, /identidade do servidor/);
});
