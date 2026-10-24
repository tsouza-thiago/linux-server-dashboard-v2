// Arquivos da instalação nesta máquina (zero sudo): tudo dentro da pasta do projeto, em
// data/ (0700), exceto a chave do painel (~/.ssh/dashboard-<servidor>-<id>, 0600), o
// serviço systemd de usuário e o atalho no menu de aplicativos.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile } from '../config.js';
import { KEY_COMMENT, NAME_PREFIX, installId, knownHostsName, machineLabel, sshConfigText, validHost, validPort } from './acesso.js';
import { UNIT_NAME, unitPath, systemctlUser, hasSystemdUser } from '../cli/servico.js';
import { PANEL_NODE_FLAGS } from '../node-flags.js';

// Atalho do menu de aplicativos (~/.local/share/applications/).
const DESKTOP_FILE = 'server-dashboard.desktop';
const desktopPath = (home = os.homedir()) => path.join(home, '.local', 'share', 'applications', DESKTOP_FILE);

// Grava via arquivo temporário + rename (atômico), com o modo pedido (padrão 0600).
const writeAtomic = (file, text, mode = 0o600) => {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
};

/** data/ e data/ssh/ só para o dono (0700). */
export function ensureDataDirs(root) {
  const data = path.join(root, 'data');
  const ssh = path.join(data, 'ssh');
  for (const dir of [data, ssh]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  return { data, ssh };
}

/** Chave pública de um arquivo .pub: { publicKey: "tipo base64", comment }, ou null. */
function readPub(file) {
  try {
    const [type, b64, ...comment] = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
    return { publicKey: `${type} ${b64}`, comment: comment.join(' ') };
  } catch {
    return null;
  }
}

/** A chave é do painel? Ed25519, em ~/.ssh, nome dashboard* e .pub com o comentário do painel. */
function panelKey(file, dir) {
  if (!file || path.dirname(file) !== dir || !path.basename(file).startsWith(NAME_PREFIX) || !fs.existsSync(file)) return null;
  const pub = readPub(`${file}.pub`);
  return pub && pub.comment === KEY_COMMENT && pub.publicKey.startsWith('ssh-ed25519 ') ? pub : null;
}

/**
 * Chave Ed25519 desta instalação (ADR 0020).
 * - `current`: a chave que esta pasta já usa (IdentityFile do data/ssh/config). Reconfigurar
 *   continua com ela, então o ID e a linha no servidor não mudam. Vale também para as
 *   chaves das versões até a 2.1.0 (~/.ssh/dashboard_ed25519).
 * - sem ela: chave nova, ~/.ssh/dashboard-<servidor>-<id>. Cada instalação tem a sua, então
 *   duas pastas no mesmo computador não dividem a linha no servidor. O ID sai da chave
 *   pública: ela nasce numa pasta temporária de ~/.ssh e só depois ganha o nome final.
 */
export function ensureKey({ home = os.homedir(), run = spawnSync, server = '', current = '' } = {}) {
  const dir = path.join(home, '.ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const own = panelKey(current, dir);
  if (own) {
    fs.chmodSync(current, 0o600);
    return { file: current, publicKey: own.publicKey, created: false };
  }
  const tmpDir = fs.mkdtempSync(path.join(dir, `.${NAME_PREFIX}-nova-`));
  try {
    const tmp = path.join(tmpDir, 'chave');
    const r = run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', KEY_COMMENT, '-f', tmp], { stdio: 'ignore' });
    const pub = !r.error && r.status === 0 ? readPub(`${tmp}.pub`) : null;
    if (!pub) throw new Error('não consegui criar a chave SSH (o ssh-keygen está instalado?)');
    const file = path.join(dir, `${NAME_PREFIX}-${machineLabel(server, 'servidor')}-${installId(pub.publicKey)}`);
    // Mesmo nome = mesmo ID = mesma chave: só por colisão de SHA-256; nunca sobrescreve.
    if (fs.existsSync(file) || fs.existsSync(`${file}.pub`)) throw new Error(`${file} já existe`);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.renameSync(`${tmp}.pub`, `${file}.pub`);
    return { file, publicKey: pub.publicKey, created: true };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** known_hosts próprio com a identidade que a pessoa conferiu no passo 3. */
export function writeKnownHosts(root, { host, port = 22, type, key }) {
  if (!validHost(host) || !validPort(port)) throw new Error('servidor inválido');
  if (!/^[a-z0-9@.-]+$/.test(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) throw new Error('chave do servidor inválida');
  const { ssh } = ensureDataDirs(root);
  const file = path.join(ssh, 'known_hosts');
  writeAtomic(file, `${knownHostsName(host, port)} ${type} ${key}\n`);
  return file;
}

/** data/ssh/config do painel (ssh -F). */
export function writeSshConfig(root, { host, port = 22, keyFile, hostKeyType }) {
  const { ssh } = ensureDataDirs(root);
  const file = path.join(ssh, 'config');
  writeAtomic(file, sshConfigText({ host, port, keyFile, knownHosts: path.join(ssh, 'known_hosts'), hostKeyType }));
  return file;
}

/**
 * Atualiza o .env (0600) sem perder o resto: troca a 1ª linha `CHAVE=` de cada item e
 * acrescenta as que faltam. Sem .env, parte do .env.example.
 */
export function updateEnv(root, updates) {
  const file = path.join(root, '.env');
  let text = '';
  if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  else if (fs.existsSync(path.join(root, '.env.example'))) text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  // Nome só com A–Z e _, e valor sem quebra de linha, aspas nem # (não dá para injetar
  // outra variável nem um comentário no .env).
  for (const [key, raw] of Object.entries(updates)) {
    if (!/^[A-Z_]+$/.test(key)) throw new Error(`variável inválida: ${key}`);
    const value = String(raw ?? '');
    if (/[\r\n\0"'#]/.test(value)) throw new Error(`valor inválido para ${key}`);
    const i = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeAtomic(file, `${lines.join('\n')}\n`);
  return file;
}

/** DASH_TOKEN do .env, gerando um novo (32 bytes) se ainda não houver. */
export function ensureToken(root) {
  // Leitura linha a linha (a mesma do config.js): `DASH_TOKEN=` vazio não "pega" a linha seguinte.
  const current = String(loadEnvFile(path.join(root, '.env')).DASH_TOKEN || '').trim();
  if (current) return { token: current, created: false };
  const token = crypto.randomBytes(32).toString('base64url');
  updateEnv(root, { DASH_TOKEN: token });
  return { token, created: true };
}

// systemd: especificadores com % viram %%; ExecStart e listas aceitam "…" com \" e \\.
const unitEscape = (s) => String(s).replace(/%/g, '%%');
const unitQuote = (s) => `"${unitEscape(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Node usado pelo serviço: o da pasta (.runtime) se existir, senão o que roda agora. */
export function serviceNode(root, current = process.execPath) {
  const local = path.join(root, '.runtime', 'node', 'bin', 'node');
  return fs.existsSync(local) ? local : current;
}

/** Unidade systemd de usuário. Com hardening (isolamento do systemd), o painel só grava em data/. */
export function unitText({ root, nodeBin, hardening = true }) {
  if (/[\r\n]/.test(root) || /[\r\n]/.test(nodeBin)) throw new Error('caminho inválido');
  return [
    '[Unit]',
    'Description=Server Dashboard (painel do servidor Linux)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${unitEscape(root)}`,
    // As opções do Node (server/node-flags.js) não têm espaço nem caractere especial do systemd.
    `ExecStart=${unitQuote(nodeBin)} ${PANEL_NODE_FLAGS.join(' ')} ${unitQuote(path.join(root, 'server', 'index.js'))}`,
    'Restart=on-failure',
    'RestartSec=10',
    'UMask=0077',
    ...(hardening ? [
      '# Hardening: sem novos privilégios e só data/ com escrita',
      'NoNewPrivileges=yes',
      'PrivateTmp=yes',
      'ProtectSystem=strict',
      'ProtectHome=read-only',
      `ReadWritePaths=${unitQuote(path.join(root, 'data'))}`,
      'ProtectKernelTunables=yes',
      'ProtectControlGroups=yes',
      'RestrictSUIDSGID=yes',
      'LockPersonality=yes',
    ] : ['# Hardening desligado: este sistema não permite o isolamento do systemd de usuário']),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * Instala e liga o serviço de usuário ("iniciar com o computador"). Se o isolamento do
 * systemd não funcionar nesta máquina, refaz a unidade sem ele e avisa (hardening: false).
 * Sem systemd de usuário (container, WSL…), devolve ok: false e o painel roda em
 * segundo plano pelo `dashboard iniciar`.
 */
export async function installService({ root, home = os.homedir(), nodeBin = serviceNode(root), enable = true, run, waitMs = 4000 } = {}) {
  const file = unitPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const apply = (hardening) => {
    writeAtomic(file, unitText({ root, nodeBin, hardening }), 0o600);
    systemctlUser(['daemon-reload'], { run });
  };
  if (!hasSystemdUser({ run })) {
    fs.rmSync(file, { force: true });
    return { ok: false, error: 'sem systemd de usuário nesta sessão' };
  }
  // 1ª tentativa com o isolamento; se o serviço não ficar ativo, a 2ª sem ele.
  for (const hardening of [true, false]) {
    apply(hardening);
    if (enable) systemctlUser(['enable', UNIT_NAME], { run });
    else systemctlUser(['disable', UNIT_NAME], { run });
    systemctlUser(['restart', UNIT_NAME], { run });
    const until = Date.now() + waitMs;
    let state = '';
    while (Date.now() < until) {
      state = (systemctlUser(['is-active', UNIT_NAME], { run })?.stdout || '').trim();
      if (state === 'active' || state === 'failed') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // "active" por alguns instantes ainda pode cair se o isolamento falhar ao abrir arquivos.
    if (state === 'active') {
      await new Promise((r) => setTimeout(r, Math.min(1000, waitMs)));
      state = (systemctlUser(['is-active', UNIT_NAME], { run })?.stdout || '').trim();
    }
    if (state === 'active') return { ok: true, hardening, file, enabled: enable };
    systemctlUser(['reset-failed', UNIT_NAME], { run });
  }
  return { ok: false, error: 'o serviço não ficou ativo (veja: journalctl --user -u server-dashboard)', file };
}

/** Desliga e apaga o serviço de usuário (desinstalar); devolve se ele existia. */
export function removeService({ home = os.homedir(), run } = {}) {
  const file = unitPath(home);
  if (!fs.existsSync(file)) return false;
  systemctlUser(['disable', '--now', UNIT_NAME], { run });
  fs.rmSync(file, { force: true });
  systemctlUser(['daemon-reload'], { run });
  return true;
}

// Desktop Entry: argumentos com espaço vão entre aspas; dentro delas, \ " ` $ levam \.
const desktopArg = (s) => `"${String(s).replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, '%%')}"`;

/** Texto do atalho do menu: abre o painel pelo `./dashboard abrir`. */
export function desktopEntryText({ root }) {
  if (/[\r\n]/.test(root)) throw new Error('caminho inválido');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Server Dashboard',
    'Comment=Painel do seu servidor Linux',
    `Exec=${desktopArg(path.join(root, 'dashboard'))} abrir`,
    `Icon=${path.join(root, 'public', 'icone.svg')}`,
    'Terminal=false',
    'Categories=System;Monitor;',
    'StartupNotify=false',
    '',
  ].join('\n');
}

/** Atalho "Server Dashboard" no menu de aplicativos. */
export function installShortcut({ root, home = os.homedir() } = {}) {
  const file = desktopPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, desktopEntryText({ root }), 0o644);
  return file;
}

/** Apaga o atalho do menu; devolve se ele existia. */
export function removeShortcut({ home = os.homedir() } = {}) {
  const file = desktopPath(home);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}
