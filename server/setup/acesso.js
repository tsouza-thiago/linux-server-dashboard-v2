// Textos do acesso restrito (ADR 0008), gerados a partir das escolhas de monitoramento:
// a linha do authorized_keys do usuário dashmon, a linha do sudoers (cada disco listado,
// sem curinga) e o arquivo de configuração SSH próprio do painel (data/ssh/config).
// Tudo é validado aqui antes de virar texto: nada do que a pessoa digita chega cru a um
// arquivo de configuração ou a um comando (espelha o install-lib.sh da V1).
import { buildForcedScript, normalizeTargets } from '../collector/builder.js';

export const PANEL_USER = 'dashmon';
export const SSH_ALIAS = 'servidor';
export const KEY_COMMENT = 'server-dashboard';

/** Endereço do servidor: IP ou nome, [A-Za-z0-9._-:] (IPv6 sem colchetes), sem '-' no início. */
export function validHost(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 253 && !v.startsWith('-') && /^[A-Za-z0-9._:-]+$/.test(v);
}

/** Usuário do servidor (padrão POSIX/Debian, sem '-' no início). */
export function validUser(v) {
  return typeof v === 'string' && /^[a-z_][a-z0-9_.-]{0,31}$/i.test(v);
}

export function validPort(v) {
  const s = String(v ?? '');
  if (!/^\d{1,5}$/.test(s)) return false;
  const n = Number(s);
  return n >= 1 && n <= 65535;
}

/** Disco (sda, vdb, nvme0n1, mmcblk0): só letras minúsculas e números. */
export function validDevice(v) {
  return typeof v === 'string' && /^[a-z][a-z0-9]{1,31}$/.test(v);
}

/** Endereço para a opção from= (IPv4 ou IPv6 literal). */
export function validIp(v) {
  if (typeof v !== 'string') return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) return v4.slice(1).every((n) => Number(n) <= 255);
  return v.includes(':') && /^[0-9a-fA-F:]{2,39}$/.test(v);
}

/** Caminho absoluto simples (para o smartctl no sudoers). */
export function validAbsPath(v) {
  return typeof v === 'string' && /^\/[A-Za-z0-9/._-]+$/.test(v) && !v.includes('..');
}

/** Chave pública Ed25519 no formato do OpenSSH (sem comentário). */
export function validPublicKey(v) {
  return typeof v === 'string' && /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(v);
}

/**
 * Escapa o comando para `command="…"`: no authorized_keys só `\"` é especial (o OpenSSH
 * troca `\"` por `"` e copia o resto). Comando com quebra de linha ou terminado em `\`
 * não pode ser representado com segurança.
 */
export function quoteCommandOption(command) {
  if (/[\r\n\0]/.test(command)) throw new Error('comando com quebra de linha não cabe no authorized_keys');
  if (command.endsWith('\\')) throw new Error('comando terminado em \\ não cabe no authorized_keys');
  return `"${command.replace(/"/g, '\\"')}"`;
}

/**
 * Linha do authorized_keys do dashmon: só roda o comando de coleta, sem terminal, sem
 * encaminhamentos (`restrict`) e, opcionalmente, só a partir deste computador (`from=`).
 */
export function authorizedKeysLine({ publicKey, targets, from = '' }) {
  if (!validPublicKey(publicKey)) throw new Error('chave pública inválida');
  if (from && !validIp(from)) throw new Error('endereço de origem inválido');
  const { script, hash } = buildForcedScript(normalizeTargets(targets));
  const opts = ['restrict', ...(from ? [`from="${from}"`] : []), `command=${quoteCommandOption(script)}`];
  return { line: `${opts.join(',')} ${publicKey} ${KEY_COMMENT}`, hash };
}

/** Linha do sudoers: `smartctl -H` em cada disco escolhido, um por um (nunca `*`). */
export function sudoersLine({ devs, smartctl = '/usr/sbin/smartctl', user = PANEL_USER }) {
  if (!validAbsPath(smartctl)) throw new Error('caminho do smartctl inválido');
  if (!validUser(user)) throw new Error('usuário inválido');
  const list = [...new Set(devs || [])];
  if (!list.length) return '';
  if (!list.every(validDevice)) throw new Error('disco inválido');
  return `${user} ALL=(root) NOPASSWD: ${list.map((d) => `${smartctl} -H /dev/${d}`).join(', ')}`;
}

const quotePath = (p) => {
  if (/["\r\n\0]/.test(p)) throw new Error(`caminho não suportado: ${p}`);
  return `"${p}"`;
};

/**
 * data/ssh/config: o painel fala com o servidor só por este arquivo (`ssh -F`). Identidade
 * do servidor conferida no known_hosts próprio (StrictHostKeyChecking yes): se mudar, a
 * coleta falha com aviso claro em vez de aceitar em silêncio.
 */
export function sshConfigText({ host, port = 22, user = PANEL_USER, keyFile, knownHosts }) {
  if (!validHost(host)) throw new Error('endereço do servidor inválido');
  if (!validPort(port)) throw new Error('porta inválida');
  if (!validUser(user)) throw new Error('usuário inválido');
  return [
    '# Server Dashboard: configuração SSH própria do painel (ssh -F). O ~/.ssh/config não é usado.',
    `Host ${SSH_ALIAS}`,
    `  HostName ${host}`,
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${quotePath(keyFile)}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${quotePath(knownHosts)}`,
    '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking yes',
    '  UpdateHostKeys no',
    '  BatchMode yes',
    '  ConnectTimeout 10',
    '  ServerAliveInterval 15',
    '  ServerAliveCountMax 2',
    '  ForwardAgent no',
    '  ForwardX11 no',
    '  ClearAllForwardings yes',
    '  RequestTTY no',
    '  LogLevel ERROR',
    '',
  ].join('\n');
}

/** Nome do servidor no known_hosts (`[host]:porta` fora da 22, como o OpenSSH grava). */
export function knownHostsName(host, port = 22) {
  return Number(port) === 22 ? host : `[${host}]:${port}`;
}
