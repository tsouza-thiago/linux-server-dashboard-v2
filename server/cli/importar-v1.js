// Upgrade V1 → V2 (`./dashboard instalar --importar-v1 <pasta-da-v1>`, Q11): para a V1
// (nunca as duas juntas: seriam 2 SSH por minuto), traz as configurações e os dados dela
// e liga a V2. A pasta da V1 não é alterada: ela é o backup e fica pronta para voltar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampInt, loadEnvFile, sanitizeToken, isPlaceholderHost, sanitizeHost } from '../config.js';
import { ensureDataDirs, updateEnv, installService, installShortcut } from '../setup/local.js';
import { hasSystemdUser, systemctlUser, startPanel, waitForPort, panelPort } from './servico.js';

export const V1_UNIT = 'linux-server-dashboard.service';
const DATA_FILES = ['history.json', 'alerts.json', 'annotations.json'];

/** É uma instalação da V1? (package.json 1.x do linux-server-dashboard + server/index.js) */
export function detectV1(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.name !== 'linux-server-dashboard' || !/^1\./.test(pkg.version)) return { ok: false, reason: 'nao-e-v1' };
    if (!fs.existsSync(path.join(dir, 'server', 'index.js'))) return { ok: false, reason: 'incompleta' };
    return { ok: true, version: pkg.version, env: fs.existsSync(path.join(dir, '.env')) };
  } catch {
    return { ok: false, reason: 'nao-e-v1' };
  }
}

/** Configurações da V1 que valem na V2, já saneadas (nada cru vai para o .env novo). */
export function v1Settings(env) {
  const out = {};
  const host = sanitizeHost(env.SSH_HOST);
  if (env.SSH_HOST && !isPlaceholderHost(host) && /^[A-Za-z0-9._@:-]+$/.test(host)) out.SSH_HOST = host;
  const tokens = (k) => sanitizeToken(env[k] || '').join(' ');
  for (const k of ['DISK_MOUNTS', 'DISK_DEVS', 'SERVICES']) if (env[k] !== undefined) out[k] = tokens(k);
  if (env.NET_IF !== undefined) out.NET_IF = sanitizeToken(env.NET_IF)[0] || '';
  if (env.POLL_INTERVAL) out.POLL_INTERVAL = clampInt(env.POLL_INTERVAL, 60000, 10000, 3600000);
  if (env.PORT) out.PORT = clampInt(env.PORT, 3000, 1, 65535);
  if (env.HISTORY_LIMIT) out.HISTORY_LIMIT = clampInt(env.HISTORY_LIMIT, 4320, 100, 100000);
  if (env.DASH_TOKEN && /^[A-Za-z0-9._~-]{16,200}$/.test(env.DASH_TOKEN.trim())) out.DASH_TOKEN = env.DASH_TOKEN.trim();
  return out;
}

/** PID da V1 em segundo plano, só se for mesmo o server/index.js daquela pasta. */
export function v1Pid(dir, procDir = '/proc') {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'data', 'dashboard.pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const args = fs.readFileSync(path.join(procDir, String(pid), 'cmdline'), 'utf8').split('\0');
    const script = path.join(dir, 'server', 'index.js');
    return args.some((a) => a === script || (a === 'server/index.js' && fs.realpathSync(`${procDir}/${pid}/cwd`) === fs.realpathSync(dir))) ? pid : null;
  } catch {
    return null;
  }
}

/** Para a V1: serviço de usuário (stop + disable) ou processo em segundo plano conferido. */
export async function stopV1(dir, { run, procDir = '/proc', kill = process.kill } = {}) {
  const done = [];
  if (hasSystemdUser({ run })) {
    const active = (systemctlUser(['is-active', V1_UNIT], { run })?.stdout || '').trim() === 'active';
    const enabled = (systemctlUser(['is-enabled', V1_UNIT], { run })?.stdout || '').trim() === 'enabled';
    if (active) { systemctlUser(['stop', V1_UNIT], { run }); done.push('servico-parado'); }
    if (enabled) { systemctlUser(['disable', V1_UNIT], { run }); done.push('servico-desligado'); }
  }
  const pid = v1Pid(dir, procDir);
  if (pid) {
    kill(pid, 'SIGTERM');
    for (let i = 0; i < 50 && v1Pid(dir, procDir); i += 1) await new Promise((r) => setTimeout(r, 100));
    done.push('processo-parado');
  }
  return done;
}

export async function importarV1({ out, root, dir, home = os.homedir(), deps = {} }) {
  const v1 = path.resolve(String(dir || ''));
  const det = detectV1(v1);
  if (!det.ok) {
    out.fail('essa pasta não é uma instalação da V1', v1);
    out.explain('procurei o package.json 1.x do linux-server-dashboard e o server/index.js.', 'passe a pasta onde você clonou a V1, por exemplo: ./dashboard instalar --importar-v1 ~/linux-server-dashboard');
    return 1;
  }
  if (path.resolve(root) === v1) { out.fail('a pasta da V1 é esta mesma'); return 1; }
  out.ok(`V1 encontrada (${det.version})`, v1);

  const stopped = await (deps.stopV1 ?? stopV1)(v1, deps);
  out.ok(stopped.length ? 'V1 parada' : 'a V1 não estava rodando', stopped.includes('servico-desligado') ? 'o serviço dela não inicia mais com o computador' : 'nunca as duas ao mesmo tempo');

  const settings = v1Settings(loadEnvFile(path.join(v1, '.env')));
  if (!settings.SSH_HOST) {
    out.fail('a V1 não tinha servidor configurado (SSH_HOST)');
    out.explain('', 'rode ./dashboard instalar sem --importar-v1 para configurar pelo assistente.');
    return 1;
  }
  ensureDataDirs(root);
  // Acesso direto, pelo ~/.ssh/config, como a V1 fazia: funciona na hora. A chave restrita
  // vem depois, com o dashboard reconfigurar.
  updateEnv(root, { ...settings, SSH_ACESSO: 'direto', SSH_CONFIG: '' });
  out.ok('configurações trazidas da V1', Object.keys(settings).filter((k) => k !== 'DASH_TOKEN').join(', '));

  const copied = [];
  for (const f of DATA_FILES) {
    const src = path.join(v1, 'data', f);
    const dst = path.join(root, 'data', f);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst) || (f === 'history.json' && fs.existsSync(path.join(root, 'data', 'history.v1-migrado.json')))) continue;
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o600);
    copied.push(f);
  }
  out.ok(copied.length ? `dados da V1 copiados (${copied.join(', ')})` : 'nenhum dado novo para copiar', 'o histórico é convertido na 1ª subida, com backup');

  let servico = null;
  if ((deps.hasSystemdUser ?? hasSystemdUser)()) servico = await (deps.installService ?? installService)({ root, home });
  if (!servico || !servico.ok) {
    const r = await (deps.startPanel ?? startPanel)({ root, home });
    if (!r.ok) { out.fail('a V2 não subiu', r.error); return 1; }
  }
  (deps.installShortcut ?? installShortcut)({ root, home });
  const port = panelPort(root);
  if (!(await (deps.waitForPort ?? waitForPort)(port, { timeoutMs: 60000 }))) { out.fail('a V2 não respondeu'); return 1; }
  out.ok(`V2 no ar em http://127.0.0.1:${port}`, servico && servico.ok ? 'serviço de usuário' : 'segundo plano');
  out.line();
  out.warn('a V2 ainda usa o acesso completo da V1 ao servidor');
  out.explain('', 'quando puder, rode ./dashboard reconfigurar: ele cria o usuário dashmon com a chave restrita à coleta.');
  out.line(out.c.dim(`Para voltar à V1: ./dashboard parar e, na pasta ${v1}, ./start.sh --background${stopped.includes('servico-desligado') ? ` (ou systemctl --user enable --now ${V1_UNIT})` : ''}.`));
  return 0;
}
