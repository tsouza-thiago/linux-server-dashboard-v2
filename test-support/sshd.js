// sshd de verdade para testes (OpenSSH do sistema), só em 127.0.0.1 e numa porta livre,
// com chave do servidor e authorized_keys próprios numa pasta temporária. Devolve null
// quando não há sshd na máquina (o teste que o usa é pulado).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p));

export const hasSsh = () => {
  try {
    execFileSync('ssh', ['-V'], { stdio: 'ignore' });
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
  } catch (err) {
    if (err.code === 'ENOENT') return false;
  }
  return Boolean(SSHD);
};

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

export function keygen(file, comment = 'teste') {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);
  return fs.readFileSync(`${file}.pub`, 'utf8').trim();
}

export async function startSshd() {
  if (!hasSsh()) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sshd-'));
  const port = await freePort();
  const hostPub = keygen(path.join(dir, 'host_ed25519'), 'host');
  const ak = path.join(dir, 'authorized_keys');
  fs.writeFileSync(ak, '', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'sshd_config'), [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${path.join(dir, 'host_ed25519')}`,
    `AuthorizedKeysFile ${ak}`,
    'StrictModes no',
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    `PidFile ${path.join(dir, 'sshd.pid')}`,
    '',
  ].join('\n'));
  if (process.getuid() === 0) fs.mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
  const child = spawn(SSHD, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const until = Date.now() + 5000;
  let up = false;
  while (!up && Date.now() < until && child.exitCode === null) {
    up = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (!up) await new Promise((r) => setTimeout(r, 50));
  }
  const stop = () => {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  };
  if (!up) { stop(); return null; }
  return {
    dir,
    port,
    user: os.userInfo().username,
    hostPub,
    knownHostsLine: `[127.0.0.1]:${port} ${hostPub.split(' ').slice(0, 2).join(' ')}`,
    setAuthorizedKeys: (text) => fs.writeFileSync(ak, `${text}\n`, { mode: 0o600 }),
    log: () => log,
    stop,
  };
}
