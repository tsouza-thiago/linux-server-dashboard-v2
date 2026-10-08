// Controle do painel na máquina local: serviço systemd de usuário quando instalado (D12),
// senão um processo em segundo plano com PID registrado em data/dashboard.pid.
//
// B12: `parar` só encerra o PID que o próprio painel registrou, e só depois de conferir em
// /proc/<pid>/cmdline que ele roda o server/index.js DESTA pasta. Nada de procurar pela
// porta (lsof) ou pelo nome (pgrep): isso podia matar o processo de outra pessoa.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { clampInt, loadEnvFile } from '../config.js';

export const UNIT_NAME = 'server-dashboard.service';

export const unitPath = (home = os.homedir()) => path.join(home, '.config', 'systemd', 'user', UNIT_NAME);
export const pidFile = (root) => path.join(root, 'data', 'dashboard.pid');
export const serverScript = (root) => path.join(root, 'server', 'index.js');

/** Porta do painel (PORT do .env, padrão 3000). */
export function panelPort(root) {
  return clampInt(loadEnvFile(path.join(root, '.env')).PORT, 3000, 1, 65535);
}

/** O processo `pid` é o painel desta pasta? (lê a linha de comando em /proc) */
export function isOurProcess(pid, root, procDir = '/proc') {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let args;
  try {
    args = fs.readFileSync(path.join(procDir, String(pid), 'cmdline'), 'utf8').split('\0');
  } catch {
    return false;
  }
  return args.includes(serverScript(root));
}

export function readPid(root) {
  try {
    const n = Number(fs.readFileSync(pidFile(root), 'utf8').trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

/** PID do painel em segundo plano, se estiver mesmo rodando. */
export function runningPid(root, procDir = '/proc') {
  const pid = readPid(root);
  return pid && isOurProcess(pid, root, procDir) ? pid : null;
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** Espera a porta aceitar conexões (o painel subiu) até `timeoutMs`. */
export async function waitForPort(port, { timeoutMs = 15000, host = '127.0.0.1' } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, host);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** systemctl --user (null se não houver systemd de usuário nesta sessão). */
export function systemctlUser(args, { run = spawnSync } = {}) {
  const r = run('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return null;
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function hasSystemdUser(opts) {
  const r = systemctlUser(['show-environment'], opts);
  return Boolean(r && r.status === 0);
}

/** Estado do painel: serviço systemd, processo em segundo plano ou parado. */
export function panelStatus({ root, home = os.homedir(), procDir = '/proc', run } = {}) {
  const port = panelPort(root);
  const service = fs.existsSync(unitPath(home)) && hasSystemdUser({ run });
  if (service) {
    const active = systemctlUser(['is-active', UNIT_NAME], { run });
    const enabled = systemctlUser(['is-enabled', UNIT_NAME], { run });
    return {
      mode: 'servico',
      running: Boolean(active && active.stdout.trim() === 'active'),
      enabled: Boolean(enabled && enabled.stdout.trim() === 'enabled'),
      port,
    };
  }
  const pid = runningPid(root, procDir);
  return { mode: pid ? 'processo' : 'parado', running: Boolean(pid), pid, enabled: false, port };
}

/**
 * Inicia o painel. Com o serviço instalado, via systemd; senão em segundo plano, com o PID
 * gravado (0600) para o `parar` conferir depois.
 */
export async function startPanel({ root, home = os.homedir(), nodeBin = process.execPath, run, spawnFn = spawn } = {}) {
  const st = panelStatus({ root, home, run });
  if (st.running) return { ok: true, already: true, ...st };
  if (st.mode === 'servico') {
    const r = systemctlUser(['start', UNIT_NAME], { run });
    if (!r || r.status !== 0) return { ok: false, error: `o serviço não iniciou: ${(r && r.stderr.trim()) || 'systemctl falhou'}`, ...st };
    const up = await waitForPort(st.port);
    return { ok: up, error: up ? null : 'o serviço iniciou mas o painel não respondeu', ...st, running: up };
  }
  if (!(await portFree(st.port))) {
    return { ok: false, error: `a porta ${st.port} já está em uso por outro programa (mude PORT no .env)`, ...st };
  }
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const errLog = path.join(dataDir, 'dashboard-erros.log');
  const fd = fs.openSync(errLog, 'a', 0o600);
  const child = spawnFn(nodeBin, [serverScript(root)], { cwd: root, detached: true, stdio: ['ignore', 'ignore', fd] });
  fs.closeSync(fd);
  fs.writeFileSync(pidFile(root), `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  const up = await waitForPort(st.port);
  return { ok: up, error: up ? null : 'o painel não respondeu; veja data/dashboard-erros.log', mode: 'processo', running: up, pid: child.pid, port: st.port };
}

/** Para o painel (serviço ou PID registrado e conferido — B12). */
export async function stopPanel({ root, home = os.homedir(), procDir = '/proc', run, graceMs = 5000 } = {}) {
  const st = panelStatus({ root, home, procDir, run });
  if (st.mode === 'servico') {
    if (!st.running) return { ok: true, wasRunning: false, mode: 'servico' };
    const r = systemctlUser(['stop', UNIT_NAME], { run });
    return { ok: Boolean(r && r.status === 0), wasRunning: true, mode: 'servico' };
  }
  const pid = readPid(root);
  if (!pid) return { ok: true, wasRunning: false, mode: 'parado' };
  if (!isOurProcess(pid, root, procDir)) {
    // PID antigo (o painel já saiu e o número pode ser de outro programa): só limpa o arquivo.
    fs.rmSync(pidFile(root), { force: true });
    return { ok: true, wasRunning: false, mode: 'parado', stalePid: pid };
  }
  process.kill(pid, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && isOurProcess(pid, root, procDir)) await sleep(100);
  let forced = false;
  if (isOurProcess(pid, root, procDir)) {
    process.kill(pid, 'SIGKILL');
    forced = true;
  }
  fs.rmSync(pidFile(root), { force: true });
  return { ok: true, wasRunning: true, mode: 'processo', pid, forced };
}

/** Abre uma URL no navegador da sessão gráfica (false se não houver tela). */
export function openBrowser(url, { env = process.env, spawnFn = spawn, run = spawnSync } = {}) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const has = run('sh', ['-c', 'command -v xdg-open'], { stdio: 'ignore' });
  if (has.status !== 0) return false;
  const child = spawnFn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return true;
}
