// Textos do acesso restrito (ADR 0008), gerados a partir das escolhas de monitoramento:
// a linha do authorized_keys do usuário dashmon, a linha do sudoers (cada disco listado,
// sem curinga) e o arquivo de configuração SSH próprio do painel (data/ssh/config).
// Tudo é validado aqui antes de virar texto: nada do que a pessoa digita chega cru a um
// arquivo de configuração ou a um comando.
// Cada instalação tem um ID tirado da sua chave pública (ADR 0020): é ele que liga a chave
// à linha do authorized_keys e ao arquivo do sudoers, para vários computadores dividirem o
// mesmo servidor sem um apagar o outro.
import crypto from 'node:crypto';
import { buildForcedScript, normalizeTargets } from '../collector/builder.js';

/** Usuário que o painel cria no servidor (sem senha; só roda a coleta). */
export const PANEL_USER = 'dashmon';
/** Nome do servidor no data/ssh/config (o SSH_HOST que a instalação grava). */
export const SSH_ALIAS = 'servidor';
/** Comentário do .pub das chaves do painel e das linhas gravadas até a 2.1.0 (sem ID). */
export const KEY_COMMENT = 'server-dashboard';
/** Prefixo dos nomes por instalação: chave, comentário no servidor e arquivo do sudoers. */
export const NAME_PREFIX = 'dashboard';

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
 * ID da instalação: 8 hex do SHA-256 da chave pública. Vem da chave, e não de um arquivo,
 * de propósito: copiar a pasta do painel para outro computador não leva a chave (ela fica
 * em ~/.ssh), então o outro computador ganha chave e ID próprios e não apaga a linha deste.
 */
export function installId(publicKey) {
  if (!validPublicKey(publicKey)) throw new Error('chave pública inválida');
  return crypto.createHash('sha256').update(Buffer.from(publicKey.split(' ')[1], 'base64')).digest('hex').slice(0, 8);
}

/** ID de instalação: 8 hex minúsculos. */
export function validInstallId(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}$/.test(v);
}

/**
 * Rótulo de um nome de máquina para nomes de arquivo e comentários: minúsculas, só
 * [a-z0-9-], até 24 caracteres. O ponto vira hífen porque o `#includedir` do sudo ignora
 * arquivo com ponto no nome (a regra sumiria sem aviso). O rótulo só serve para leitura:
 * quem identifica a instalação é o ID (dois computadores podem ter o mesmo nome).
 */
export function machineLabel(name, fallback = 'computador') {
  const s = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 24).replace(/-+$/, '');
  return s || fallback;
}

/** Rótulo já saneado (o que machineLabel devolve). */
export function validLabel(v) {
  return typeof v === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(v);
}

/** ID, rótulo deste computador e comentário da linha no servidor (dashboard@<computador>:<id>). */
export function installNames({ publicKey, computer }) {
  const id = installId(publicKey);
  const label = machineLabel(computer);
  return { id, label, comment: `${NAME_PREFIX}@${label}:${id}` };
}

/**
 * Escapa o comando para `command="…"`: no authorized_keys só `\"` é especial (o OpenSSH
 * troca `\"` por `"` e copia o resto). Comando com quebra de linha ou terminado em `\`
 * não pode ser representado com segurança.
 *
 * A `\` fica como está DE PROPÓSITO (o CodeQL js/incomplete-sanitization aponta isso, mas
 * é falso positivo): o opt_dequote não desfaz `\\`, então dobrar a barra mudaria o script
 * de coleta (`\t`, `\n` do awk e do tr). O caso `\` antes de `"` sai como `\\"` e volta
 * certo; o teste de ida e volta em test/integration/ssh-restrito.test.js confere.
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
export function authorizedKeysLine({ publicKey, targets, from = '', comment = KEY_COMMENT }) {
  if (!validPublicKey(publicKey)) throw new Error('chave pública inválida');
  if (from && !validIp(from)) throw new Error('endereço de origem inválido');
  // O comentário entra no fim da linha e no padrão que acha a linha depois: só texto simples.
  if (!/^[A-Za-z0-9@:._-]{1,64}$/.test(comment)) throw new Error('comentário da chave inválido');
  const { script, hash } = buildForcedScript(normalizeTargets(targets));
  const opts = ['restrict', ...(from ? [`from="${from}"`] : []), `command=${quoteCommandOption(script)}`];
  return { line: `${opts.join(',')} ${publicKey} ${comment}`, hash };
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

// Caminho entre aspas para o ssh_config; aspas e quebras de linha não têm escape seguro lá.
const quotePath = (p) => {
  if (/["\r\n\0]/.test(p)) throw new Error(`caminho não suportado: ${p}`);
  return `"${p}"`;
};

/**
 * data/ssh/config: o painel fala com o servidor só por este arquivo (`ssh -F`). Identidade
 * do servidor conferida no known_hosts próprio (StrictHostKeyChecking yes): se mudar, a
 * coleta falha com aviso claro em vez de aceitar em silêncio.
 */
/** `hostKeyType`: valor do HostKeyAlgorithms (ver remoto.hostKeyAlgorithms). */
export function sshConfigText({ host, port = 22, user = PANEL_USER, keyFile, knownHosts, hostKeyType = '' }) {
  if (!validHost(host)) throw new Error('endereço do servidor inválido');
  if (!validPort(port)) throw new Error('porta inválida');
  if (!validUser(user)) throw new Error('usuário inválido');
  if (hostKeyType && !/^[a-z0-9@.,-]+$/.test(hostKeyType)) throw new Error('tipo de chave do servidor inválido');
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
    // Só o tipo de chave que a pessoa conferiu no passo 3.
    ...(hostKeyType ? [`  HostKeyAlgorithms ${hostKeyType}`] : []),
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
