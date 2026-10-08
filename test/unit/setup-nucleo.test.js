// Núcleo da instalação (F7): detecção, plano de preparo do servidor, conexões e arquivos
// locais — sem rede e sem tocar no sistema (servidor, systemd e ssh são falsos aqui; o
// caminho real foi exercitado contra um Debian 12 em contêiner, ver test/e2e/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectionScript, parseDetection, parsePairs, recommendedChoices, estimateCost, shQuote,
} from '../../server/setup/deteccao.js';
import { preparationPlan, assistedScript, completedSteps, removalScript } from '../../server/setup/preparo.js';
import {
  fingerprint, fingerprintBlocks, describeAdminError, runAdmin, hostKeyAlgorithms, probePort, scanHostKeys, ASKPASS,
} from '../../server/setup/remoto.js';
import {
  ensureDataDirs, ensureKey, writeKnownHosts, writeSshConfig, updateEnv, ensureToken, unitText, installService, removeService,
  desktopEntryText, installShortcut, removeShortcut, serviceNode,
} from '../../server/setup/local.js';
import { loadEnvFile } from '../../server/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(HERE, '..', 'fixtures', 'instalacao', 'deteccao-debian12.txt'), 'utf8');
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDXqoDsmPk6vUrrUKNE8wEZDIdA5ykxe5ArqBrMcqzcM';
const tmp = (t, p = 'dash-setup-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const sh = (script) => spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });

test('detecção: script só de leitura, sintaxe POSIX e senha só como variável', () => {
  const plain = detectionScript();
  assert.equal(sh(plain).status, 0, sh(plain).stderr);
  assert.match(plain, /^P=''$/m);
  for (const bad of [/\brm\b/, /\bmv\b/, /\binstall\b/, /useradd/, /tee\b/, />\s*\/(etc|var|home)/]) assert.doesNotMatch(plain, bad);
  const withPass = detectionScript({ password: "a'b c$d" });
  assert.match(withPass, /^P='a'\\''b c\$d'$/m, 'aspas simples POSIX');
  assert.equal(sh(withPass).status, 0);
  assert.match(withPass, /sudo -S -k -p '' true/, 'sudo -k sempre pede a senha (nunca usa cache)');
  assert.throws(() => detectionScript({ password: 'a\nb' }), /quebra de linha/);
  assert.equal(shQuote("it's"), "'it'\\''s'");
});

test('detecção: roda de verdade no sh local e devolve um retrato válido', () => {
  const r = spawnSync('sh', ['-s'], { input: detectionScript(), encoding: 'utf8', env: { ...process.env, SSH_CONNECTION: '192.0.2.50 5000 192.0.2.10 22' } });
  assert.equal(r.status, 0, r.stderr);
  const det = parseDetection(r.stdout);
  assert.equal(det.clientIp, '192.0.2.50');
  assert.equal(det.user, os.userInfo().username);
  assert.ok(['root', 'nopasswd', 'senha', 'nao', 'ausente'].includes(det.sudo));
});

test('detecção: discos, pastas, rede e serviços do servidor de exemplo', () => {
  const det = parseDetection(FIXTURE);
  assert.deepEqual([det.user, det.uid, det.clientIp, det.os, det.hostname, det.sudo], ['maria', 1000, '192.0.2.50', 'Debian GNU/Linux 12 (bookworm)', 'servidor-casa', 'senha']);
  assert.equal(det.smartctl, '/usr/sbin/smartctl');
  assert.equal(det.smartPossible, true);
  assert.equal(det.dashmonExists, false);
  assert.deepEqual(det.disks.map((d) => [d.name, d.virtual, d.rotational, d.model]), [
    ['sda', false, false, 'SSD 120GB'], ['sdb', false, true, 'HDD 4TB'], ['sdc', false, true, 'HDD Externo'],
  ], 'zram e loop ficam de fora; \\x20 do lsblk vira espaço');
  assert.deepEqual(det.mounts.map((m) => [m.target, m.disk, m.pct, m.recommended]), [
    ['/', 'sda', 41, true], ['/boot/efi', 'sda', 2, false], ['/mnt/dados', 'sdb', 64, true], ['/mnt/backup', 'sdc', 22, true],
  ], 'criptografado (dm-0) chega ao disco sdc; camadas do Docker e /etc/hosts ficam de fora');
  assert.deepEqual(det.nets.map((n) => [n.name, n.up, n.wifi, n.default]), [['enp3s0', true, false, true], ['wlp2s0', false, true, false]]);
  assert.deepEqual(det.services.map((s) => [s.name, s.recommended, s.label]), [
    ['docker', true, 'contêineres'], ['jellyfin', true, 'mídia'], ['nmbd', true, 'compartilhamento'], ['smbd', true, 'compartilhamento'],
    ['cron', false, 'tarefas agendadas'], ['ssh', false, 'acesso remoto'],
  ], 'serviços do sistema (dbus, systemd-*, getty@…) não aparecem');
  const rec = recommendedChoices(det);
  assert.deepEqual(rec, {
    mounts: ['/', '/mnt/dados', '/mnt/backup'], smart: ['sda', 'sdb', 'sdc'], io: ['sda', 'sdb', 'sdc'], netIf: 'enp3s0',
    services: ['docker', 'jellyfin', 'nmbd', 'smbd'],
  });
  assert.deepEqual(recommendedChoices({ ...det, sudo: 'nao' }).smart, [], 'sem sudo, sem SMART');
  assert.deepEqual(recommendedChoices({ ...det, smartPossible: false }).smart, []);
  assert.throws(() => parseDetection('===WHO===\nmaria\n'), /não terminou/);
  assert.deepEqual(parsePairs('NAME="a b" X="\\x41"'), { NAME: 'a b', X: 'A' });
  const cost = estimateCost({ mounts: ['/', '/a', '/b'], devs: ['sda', 'sdb', 'sdc'], services: ['a', 'b', 'c'], netIf: 'e' });
  assert.ok(cost.seconds > 0.5 && cost.seconds < 1.5 && cost.kb > 3 && cost.kb < 16, JSON.stringify(cost), 'dentro do orçamento Q17');
});

test('preparo: o mesmo plano vira script do assistido e blocos do manual', () => {
  const targets = { mounts: ['/', '/mnt/dados'], devs: ['sda', 'sdb'], services: ['smbd'], netIf: 'enp3s0' };
  const plan = preparationPlan({ adminUser: 'maria', publicKey: PUB, targets, smartDevs: ['sda', 'sdb'], from: '192.0.2.50' });
  assert.deepEqual(plan.actions.map((a) => a.id), ['sudo', 'usuario', 'chave', 'sudoers', 'teste']);
  assert.equal(plan.actions[0].detalhe, 'pede a senha de maria uma vez');
  assert.match(plan.actions[3].detalhe, /apenas smartctl -H em sda e sdb/);
  assert.equal(sh(plan.rootScript).status, 0, sh(plan.rootScript).stderr);
  assert.match(plan.rootScript, /^set -e$/m);
  assert.match(plan.rootScript, /restrict,from="192\.0\.2\.50",command=/);
  assert.match(plan.rootScript, /visudo -cf \/etc\/sudoers\.d\/dashboard\.novo && mv/);
  assert.deepEqual(completedSteps(plan.rootScript.replace(/echo '(@@ok \w+)'/g, '$1')), ['usuario', 'chave', 'sudoers']);
  assert.ok(plan.displayed.startsWith('# executado como root numa única chamada de sudo (pede a senha de maria uma vez)'));
  assert.ok(!plan.displayed.includes('@@ok'), 'só os comandos de verdade aparecem para a pessoa');

  const blocks = Object.fromEntries(plan.manualBlocks.map((b) => [b.id, b.codigo]));
  assert.deepEqual(Object.keys(blocks), ['usuario', 'chave', 'sudoers', 'pronto']);
  assert.equal(blocks.usuario, 'sudo id dashmon >/dev/null 2>&1 || sudo useradd --system --create-home --shell /bin/sh dashmon\nsudo passwd --lock dashmon >/dev/null');
  assert.match(blocks.chave, /^sudo install -m 600 -o dashmon -g dashmon \/dev\/stdin ~dashmon\/\.ssh\/authorized_keys <<'FIM_DA_CHAVE'\nrestrict,/m);
  assert.doesNotMatch(blocks.chave, /\nsudo restrict/, 'a linha dentro do heredoc não ganha sudo');
  assert.match(blocks.sudoers, /^dashmon ALL=\(root\) NOPASSWD: \/usr\/sbin\/smartctl -H \/dev\/sda, \/usr\/sbin\/smartctl -H \/dev\/sdb$/m);
  assert.match(blocks.sudoers, /sudo visudo -cf \/etc\/sudoers\.d\/dashboard\.novo && sudo mv/);
  for (const code of Object.values(blocks)) assert.equal(sh(code).status, 0, code);

  const root = preparationPlan({ adminUser: 'root', publicKey: PUB, targets, smartDevs: [] });
  assert.equal(root.actions[0].titulo, 'Entrar como administrador');
  assert.match(root.rootScript, /rm -f \/etc\/sudoers\.d\/dashboard/, 'sem SMART: a regra antiga sai');
  assert.ok(!root.manualBlocks.some((b) => b.codigo.includes('sudo ')), 'root não precisa de sudo');
  assert.match(root.keyLine, /^restrict,command=/, 'sem from=');
  assert.match(removalScript(), /userdel -r dashmon/);
  assert.equal(sh(removalScript()).status, 0);
});

test('preparo: como o script chega a root (senha uma vez, conferida antes)', () => {
  const rs = 'set -e\necho oi\n';
  assert.equal(assistedScript(rs, { sudo: 'root' }), "/bin/sh -s <<'FIM_DO_PREPARO'\nset -e\necho oi\nFIM_DO_PREPARO\n");
  assert.match(assistedScript(rs, { sudo: 'nopasswd' }), /\| sudo -n \/bin\/sh -s\n$/);
  const withPass = assistedScript(rs, { sudo: 'senha', password: "s'x" });
  assert.equal(sh(withPass).status, 0);
  assert.match(withPass, /^P='s'\\''x'$/m);
  assert.match(withPass, /sudo -S -k -p '' true 2>\/dev\/null \|\| \{ P=; echo '@@erro senha'; exit 9; \}/, 'senha conferida antes');
  assert.match(withPass, /\| sudo -S -k -p '' \/bin\/sh -s$/m);
  assert.throws(() => assistedScript(rs, { sudo: 'senha' }), /precisa da senha/);
  assert.throws(() => assistedScript(rs, { sudo: 'nao', password: 'x' }), /precisa da senha/);
  assert.throws(() => assistedScript(rs, { sudo: 'senha', password: 'a\nb' }), /quebra de linha/);
  assert.throws(() => assistedScript('x\nFIM_DO_PREPARO\ny', { sudo: 'root' }), /inválido/);
  // Simula o servidor: um "sudo" falso que lê a 1ª linha (senha) e roda o resto.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sudo-'));
  try {
    fs.writeFileSync(path.join(dir, 'sudo'), '#!/bin/sh\nIFS= read -r pw\n[ "$pw" = "certa" ] || exit 1\nshift 4\n[ "$1" = true ] && exit 0\nexec "$@"\n', { mode: 0o755 });
    const run = (pw) => spawnSync('sh', ['-s'], { input: assistedScript("echo '@@ok usuario'\n", { sudo: 'senha', password: pw }), encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin` } });
    assert.deepEqual(completedSteps(run('certa').stdout), ['usuario']);
    const wrong = run('errada');
    assert.equal(wrong.status, 9);
    assert.match(wrong.stdout, /^@@erro senha$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remoto: impressão digital igual à do ssh-keygen e erros em português', () => {
  assert.equal(fingerprint('AAAAC3NzaC1lZDI1NTE5AAAAICLXaq8Zb0WG4QWeKtFRHjyahVNxZFkczJ5it2xMlpU2'), 'SHA256:8oOm2IqGGSLMQ94IC6SBJJ/EIGqCSF6BhAsYUkBWlXw');
  assert.deepEqual(fingerprintBlocks('SHA256:abcdefghij'), ['abcd', 'efgh', 'ij']);
  assert.equal(hostKeyAlgorithms('ssh-rsa'), 'rsa-sha2-512,rsa-sha2-256,ssh-rsa');
  assert.equal(hostKeyAlgorithms('ssh-ed25519'), 'ssh-ed25519');
  const cases = [
    [{ code: 255, stderr: 'maria@192.0.2.10: Permission denied (publickey,password).' }, /recusou a entrada/],
    [{ code: 255, stderr: 'Host key verification failed.' }, /identidade do servidor não é a que você confirmou/],
    [{ code: 255, stderr: 'connect to host x port 22: Connection refused' }, /porta do SSH está fechada/],
    [{ code: 255, stderr: 'connect to host x port 22: Connection timed out' }, /não respondeu/],
    [{ code: 255, stderr: 'ssh: Could not resolve hostname x' }, /nome não foi encontrado/],
    [{ code: 255, stderr: 'algo\nkex error' }, /falhou: kex error/],
    [{ code: 3, stderr: '' }, /código 3\)$/],
    [{ timedOut: true }, /parou de responder/],
    [{ error: 'ssh não encontrado' }, /ssh não encontrado/],
  ];
  for (const [err, re] of cases) assert.match(describeAdminError(err), re);
});

test('remoto: conexão do administrador sem ~/.ssh/config, senha só no ambiente do ssh', async () => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = { on() {}, end(text) { input = text; setImmediate(() => { child.stdout.emit('data', 'ok\n'); child.emit('close', 0); }); } };
    child.kill = () => {};
    calls.push({ cmd, args, env: opts.env, input: () => input });
    return child;
  };
  const withPass = await runAdmin({ host: '192.0.2.10', port: 2222, user: 'maria', password: 'segredo', knownHosts: '/k', hostKeyType: 'ssh-ed25519', script: 'echo oi\n', spawnFn });
  assert.equal(withPass.code, 0);
  const a = calls[0];
  assert.equal(a.cmd, 'ssh');
  assert.deepEqual(a.args.slice(0, 6), ['-F', '/dev/null', '-p', '2222', '-l', 'maria']);
  assert.deepEqual(a.args.slice(-4), ['-T', '--', '192.0.2.10', '/bin/sh -s']);
  assert.ok(a.args.includes('StrictHostKeyChecking=yes') && a.args.includes('UserKnownHostsFile=/k') && a.args.includes('HostKeyAlgorithms=ssh-ed25519'));
  assert.ok(a.args.includes('PubkeyAuthentication=no'));
  assert.ok(!a.args.join(' ').includes('segredo'), 'a senha nunca vai na linha de comando');
  assert.equal(a.env.DASHBOARD_SENHA_SSH, 'segredo');
  assert.equal(a.env.SSH_ASKPASS, ASKPASS);
  assert.equal(a.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(a.input(), 'echo oi\n', 'o script vai pelo stdin');
  await runAdmin({ host: 'servidor', user: 'maria', knownHosts: '/k', script: '', spawnFn });
  assert.ok(calls[1].args.includes('BatchMode=yes'), 'sem senha: chaves de sempre, sem perguntar');
  assert.equal(calls[1].env.DASHBOARD_SENHA_SSH, undefined);
  assert.throws(() => runAdmin({ host: '-oProxyCommand=x', user: 'maria', script: '' }), /inválido/);
  const ask = spawnSync(ASKPASS, [], { encoding: 'utf8', env: { DASHBOARD_SENHA_SSH: 'x y' } });
  assert.equal(ask.stdout, 'x y\n', 'o ajudante devolve a senha ao ssh');
});

test('remoto: alcance da porta e identidade com servidor local falso', async (t) => {
  const net = await import('node:net');
  const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  t.after(() => srv.close());
  const ok = await probePort('127.0.0.1', srv.address().port);
  assert.equal(ok.ok, true);
  assert.ok(ok.ms >= 1);
  assert.deepEqual(await probePort('-x', 22), { ok: false, reason: 'invalido' });
  const closed = await probePort('127.0.0.1', 1);
  assert.deepEqual(closed, { ok: false, reason: 'porta-fechada' });
  const unknown = await probePort('nao-existe.invalid', 22, { timeoutMs: 3000 });
  assert.equal(unknown.ok, false);
  const fakeScan = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on() {}, end() { setImmediate(() => {
      child.stdout.emit('data', '# comentário\n192.0.2.10 ssh-rsa AAAAB3Nza\n192.0.2.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICLXaq8Zb0WG4QWeKtFRHjyahVNxZFkczJ5it2xMlpU2\nlixo\n');
      child.emit('close', 0);
    }); } };
    child.kill = () => {};
    assert.deepEqual(args.slice(0, 4), ['-T', '8', '-p', '22']);
    return child;
  };
  const keys = await scanHostKeys('192.0.2.10', 22, { spawnFn: fakeScan });
  assert.deepEqual(keys.map((k) => k.type), ['ssh-ed25519', 'ssh-rsa'], 'Ed25519 primeiro');
  await assert.rejects(() => scanHostKeys('a b', 22), /inválido/);
});

test('local: .env mesclado (0600), token, chave dedicada e arquivos SSH do painel', (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, '.env.example'), '# modelo\nSSH_HOST=seu_host\nPORT=3000\n');
  updateEnv(root, { SSH_HOST: 'servidor', DISK_MOUNTS: '/ /mnt/dados', NOVA: 'x' });
  const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.equal(text, '# modelo\nSSH_HOST=servidor\nPORT=3000\nDISK_MOUNTS=/ /mnt/dados\nNOVA=x\n');
  assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
  assert.deepEqual(loadEnvFile(path.join(root, '.env')).DISK_MOUNTS, '/ /mnt/dados');
  assert.throws(() => updateEnv(root, { A: 'x\nSSH_HOST=mau' }), /valor inválido/);
  assert.throws(() => updateEnv(root, { 'a-b': 'x' }), /variável inválida/);
  const tok = ensureToken(root);
  assert.equal(tok.created, true);
  assert.ok(tok.token.length >= 40);
  assert.deepEqual(ensureToken(root), { token: tok.token, created: false }, 'não troca o token existente');
  const r2 = tmp(t);
  fs.writeFileSync(path.join(r2, '.env'), 'DASH_TOKEN=\nSSH_HOST=servidor\n');
  assert.equal(ensureToken(r2).created, true, 'DASH_TOKEN vazio não "pega" a linha seguinte');
  assert.equal(loadEnvFile(path.join(r2, '.env')).SSH_HOST, 'servidor');

  const home = tmp(t, 'dash-home-');
  const k1 = ensureKey({ home });
  assert.equal(k1.file, path.join(home, '.ssh', 'dashboard_ed25519'));
  assert.equal(k1.created, true);
  assert.match(k1.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+$/);
  assert.equal(fs.statSync(k1.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, '.ssh')).mode & 0o777, 0o700);
  assert.deepEqual(ensureKey({ home }), { ...k1, created: false }, 'reaproveita a chave do painel');
  const home2 = tmp(t, 'dash-home-');
  fs.mkdirSync(path.join(home2, '.ssh'));
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'linux-server-dashboard', '-f', path.join(home2, '.ssh', 'dashboard_ed25519')]);
  const k2 = ensureKey({ home: home2 });
  assert.equal(k2.file, path.join(home2, '.ssh', 'dashboard_v2_ed25519'), 'a chave da V1 (acesso completo) não é reaproveitada');
  assert.throws(() => ensureKey({ home: tmp(t, 'dash-home-'), run: () => ({ status: 1 }) }), /não consegui criar a chave/);

  const dirs = ensureDataDirs(root);
  assert.equal(fs.statSync(dirs.ssh).mode & 0o777, 0o700);
  const kh = writeKnownHosts(root, { host: '192.0.2.10', port: 2222, type: 'ssh-ed25519', key: 'AAAAC3Nz' });
  assert.equal(fs.readFileSync(kh, 'utf8'), '[192.0.2.10]:2222 ssh-ed25519 AAAAC3Nz\n');
  assert.throws(() => writeKnownHosts(root, { host: '192.0.2.10', type: 'x y', key: 'A' }), /inválida/);
  const cfg = writeSshConfig(root, { host: '192.0.2.10', port: 2222, keyFile: k1.file, hostKeyType: 'ssh-ed25519' });
  assert.match(fs.readFileSync(cfg, 'utf8'), /HostKeyAlgorithms ssh-ed25519/);
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  assert.equal(serviceNode(root, '/usr/bin/node'), '/usr/bin/node');
  fs.mkdirSync(path.join(root, '.runtime', 'node', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.runtime', 'node', 'bin', 'node'), '');
  assert.equal(serviceNode(root, '/usr/bin/node'), path.join(root, '.runtime', 'node', 'bin', 'node'));
});

test('local: unidade systemd com hardening e caminhos com espaço e %', () => {
  const unit = unitText({ root: '/home/maria/Área de Trabalho/dash 100%', nodeBin: '/usr/bin/node' });
  assert.match(unit, /^WorkingDirectory=\/home\/maria\/Área de Trabalho\/dash 100%%$/m);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/home\/maria\/Área de Trabalho\/dash 100%%\/server\/index\.js"$/m);
  assert.match(unit, /^ReadWritePaths="\/home\/maria\/Área de Trabalho\/dash 100%%\/data"$/m);
  for (const opt of ['NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectSystem=strict', 'UMask=0077', 'WantedBy=default.target']) assert.ok(unit.includes(opt), opt);
  const soft = unitText({ root: '/r', nodeBin: '/n', hardening: false });
  assert.ok(!soft.includes('ProtectSystem') && soft.includes('Hardening desligado'));
  assert.throws(() => unitText({ root: '/a\nExecStartPre=/bin/sh', nodeBin: '/n' }), /inválido/);
  const desk = desktopEntryText({ root: '/home/maria/Área de Trabalho/dash "x" $y' });
  assert.match(desk, /^Exec="\/home\/maria\/Área de Trabalho\/dash \\"x\\" \\\$y\/dashboard" abrir$/m);
  assert.match(desk, /^Icon=\/home\/maria\/Área de Trabalho\/dash "x" \$y\/public\/icone\.svg$/m);
  assert.match(desk, /^Name=Server Dashboard$/m);
});

test('local: serviço de usuário liga com hardening, ou sem ele se o sistema não deixar', async (t) => {
  const home = tmp(t, 'dash-home-');
  const root = tmp(t);
  const calls = [];
  let unitHard = false;
  const run = (cmd, args) => {
    calls.push(args.slice(1).join(' '));
    const sub = args[1];
    if (sub === 'is-active') return { status: 0, stdout: unitHard ? 'failed\n' : 'active\n' };
    const unit = path.join(home, '.config/systemd/user/server-dashboard.service');
    if (sub === 'daemon-reload' && fs.existsSync(unit)) unitHard = fs.readFileSync(unit, 'utf8').includes('ProtectSystem');
    return { status: 0, stdout: '' };
  };
  const r = await installService({ root, home, nodeBin: '/n', run, waitMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.hardening, false, 'isolamento falhou: refez sem ele');
  assert.ok(calls.includes('enable server-dashboard.service'));
  assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
  const ok = await installService({ root, home, nodeBin: '/n', run: (c, a) => (a[1] === 'is-active' ? { status: 0, stdout: 'active\n' } : { status: 0, stdout: '' }), waitMs: 50, enable: false });
  assert.deepEqual([ok.ok, ok.hardening, ok.enabled], [true, true, false]);
  const never = await installService({ root, home, nodeBin: '/n', run: (c, a) => (a[1] === 'is-active' ? { status: 0, stdout: 'failed\n' } : { status: 0, stdout: '' }), waitMs: 50 });
  assert.equal(never.ok, false);
  assert.match(never.error, /journalctl/);
  const none = await installService({ root, home, nodeBin: '/n', run: () => ({ error: new Error('x') }) });
  assert.deepEqual([none.ok, fs.existsSync(path.join(home, '.config/systemd/user/server-dashboard.service'))], [false, false]);
  assert.equal(removeService({ home, run }), false);
  fs.mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/systemd/user/server-dashboard.service'), '');
  assert.equal(removeService({ home, run }), true);

  const sc = installShortcut({ root, home });
  assert.equal(fs.statSync(sc).mode & 0o777, 0o644);
  assert.equal(removeShortcut({ home }), true);
  assert.equal(removeShortcut({ home }), false);
});
