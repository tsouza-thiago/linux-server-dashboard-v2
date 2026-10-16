// Configuração do painel: o ÚNICO lugar que lê o .env (AGENTS, "Configuração").
//
// Quem usa: o servidor (server/index.js), a coleta (server/poller.js), a CLI e os scripts.
// O que garante (security by design):
//   - cada variável tem padrão e faixa; valor fora da faixa volta ao padrão, com aviso;
//   - os alvos da coleta (pastas, discos, serviços, interface) passam por uma whitelist
//     ANTES de entrar no script que roda no servidor (anti-injeção, CWE-78);
//   - todo caminho de arquivo de dados é forçado para dentro de data/ (clampPathToData).
// O .env é lido uma vez, quando o módulo carrega; process.env tem prioridade sobre ele.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Raiz do projeto (a pasta que contém server/, public/ e data/). */
export const ROOT = path.join(__dirname, '..');

/**
 * Lê um arquivo no formato .env (`CHAVE=valor`, uma por linha) e devolve `{ CHAVE: valor }`.
 * Linhas comentadas (#) e linhas fora do formato são ignoradas; aspas nas pontas do valor
 * saem. Arquivo ausente devolve `{}` (o .env é opcional: tudo tem padrão).
 */
export function loadEnvFile(filePath = path.join(ROOT, '.env')) {
  const out = {};
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env opcional */ }
  return out;
}

// O .env desta instalação, lido uma vez.
const fileEnv = loadEnvFile();

/** Valor de uma variável: process.env, depois o .env; vazio ou ausente = `def`. */
export const env = (key, def) => {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === '' ? def : v;
};

// Whitelist dos alvos da coleta: só letras, números e `_ . / : -`. Nada de espaço, aspas,
// `$`, `;`, `|`, crase ou quebra de linha, que mudariam o script no servidor.
const TOKEN_RE = /^[A-Za-z0-9_./:-]+$/;

/**
 * Separa uma lista do .env (separada por espaços) e devolve só os itens seguros: que
 * passam na whitelist e não começam com `-` (não podem virar opção de comando, CWE-88).
 * Itens recusados simplesmente somem: nunca chegam ao servidor.
 */
export function sanitizeToken(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => TOKEN_RE.test(t) && !t.startsWith('-'));
}

// Valores de exemplo que indicam "ainda não instalado" (o .env.example e a V1 usam estes).
const PLACEHOLDER_RE = /seu[-_ ]?host|seu_host|usuario@ip/i;

/** O SSH_HOST ainda é o valor de exemplo? (a CLI usa para dizer "rode ./dashboard instalar"). */
export function isPlaceholderHost(value) {
  return PLACEHOLDER_RE.test(String(value || ''));
}

/** Inteiro dentro de [min, max]; qualquer outra coisa (texto, fora da faixa) vira `def`. */
export function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

/**
 * Inteiro do .env validado: vazio usa o padrão; fora da faixa usa o padrão e registra um
 * aviso (só o nome da variável e o valor numérico recusado — nunca o conteúdo do .env).
 */
export function intSetting(key, raw, def, min, max, warnings) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    warnings.push(`${key} inválido (aceita ${min}–${max}); usando ${def}`);
    return def;
  }
  return n;
}

/**
 * Limiares dos alertas (ADR 0006): fonte única para o motor, o índice de saúde e a tela.
 * `get` lê a variável (padrão: o .env); os avisos de valor recusado vão para `warnings`.
 * Padrões e faixas: AGENTS, tabela "Configuração" (conferida pelo docs.test.js).
 */
export function alertThresholds(get = (k) => env(k, ''), warnings = []) {
  return {
    diskPct: intSetting('ALERT_DISK_PCT', get('ALERT_DISK_PCT'), 90, 50, 99, warnings),
    ramPct: intSetting('ALERT_RAM_PCT', get('ALERT_RAM_PCT'), 90, 50, 99, warnings),
    tempC: intSetting('ALERT_TEMP_C', get('ALERT_TEMP_C'), 60, 30, 110, warnings),
    hysteresis: intSetting('ALERT_HYSTERESIS', get('ALERT_HYSTERESIS'), 5, 0, 20, warnings),
    offlineAfter: intSetting('ALERT_OFFLINE_AFTER', get('ALERT_OFFLINE_AFTER'), 2, 1, 10, warnings),
  };
}

/**
 * Caminho de arquivo de dados SEMPRE dentro de data/ (CWE-22): um `HISTORY_FILE=../../etc/x`
 * ou um caminho absoluto fora de data/ vira `data/<fallbackBasename>`.
 */
export function clampPathToData(value, fallbackBasename) {
  const p = path.resolve(ROOT, value || '');
  const dataDir = path.join(ROOT, 'data');
  if (p === dataDir || p.startsWith(dataDir + path.sep)) return p;
  return path.join(dataDir, fallbackBasename);
}

// Alvos da coleta, já filtrados pela whitelist.
const sanitizedMounts = sanitizeToken(env('DISK_MOUNTS', '/'));
const sanitizedDevs = sanitizeToken(env('DISK_DEVS', ''));
const sanitizedServices = sanitizeToken(env('SERVICES', ''));
// SMART_DEVS ausente = SMART em todos os DISK_DEVS (V1); presente e vazio = nenhum. Por isso
// esta leitura distingue "ausente" de "vazio" (o env() trataria os dois como padrão).
const rawSmartDevs = process.env.SMART_DEVS ?? fileEnv.SMART_DEVS;
const sanitizedNetIf = sanitizeToken(env('NET_IF', ''));

/**
 * Servidor do SSH (alias do data/ssh/config ou `usuario@host`). Vazio ou começando com `-`
 * vira o valor de exemplo: um `-oProxyCommand=…` nunca chega ao `ssh` como opção (CWE-88).
 * O valor vai ao `ssh` como argumento separado, sem shell (server/collector/index.js).
 */
export function sanitizeHost(value) {
  const v = String(value || '').trim();
  if (!v || v.startsWith('-')) return 'seu-host';
  return v;
}

/**
 * Acesso SSH (ADR 0008). `restrito`: a chave do painel tem `command="…"` no authorized_keys
 * e o painel envia só a palavra do modo; `direto`: o painel envia o script inteiro (V1 e
 * quem ainda não preparou o servidor).
 */
export function sshAccess(value) {
  return String(value || '').trim().toLowerCase() === 'restrito' ? 'restrito' : 'direto';
}

/** Arquivo de configuração SSH próprio (`ssh -F`), sempre dentro de data/; vazio = nenhum. */
export function sshConfigFile(value) {
  return String(value || '').trim() ? clampPathToData(String(value).trim(), 'ssh/config') : '';
}

/** Avisos de configuração (valores recusados), mostrados no log ao iniciar. */
export const configWarnings = [];

// A configuração ativa. Cada chave é uma variável do .env (nomes, padrões e faixas iguais à
// tabela do AGENTS e ao .env.example; o docs.test.js confere os três).
export const config = {
  SSH_HOST: sanitizeHost(env('SSH_HOST', 'seu-host')),
  SSH_CONFIG: sshConfigFile(env('SSH_CONFIG', '')),
  SSH_ACESSO: sshAccess(env('SSH_ACESSO', '')),
  POLL_INTERVAL: clampInt(env('POLL_INTERVAL', ''), 60000, 10000, 3600000),
  PORT: clampInt(env('PORT', ''), 3000, 1, 65535),
  HISTORY_LIMIT: clampInt(env('HISTORY_LIMIT', ''), 4320, 100, 100000),
  HISTORY_FILE: clampPathToData(env('HISTORY_FILE', ''), 'history.json'),
  LOG_FILE: clampPathToData(env('LOG_FILE', ''), 'dashboard.log'),
  // Uma interface só: se vierem várias, vale a primeira.
  NET_IF: sanitizedNetIf[0] || '',
  // Sem nenhuma pasta válida, acompanha ao menos a raiz.
  DISK_MOUNTS: sanitizedMounts.length ? sanitizedMounts : ['/'],
  DISK_DEVS: sanitizedDevs,
  // null = "siga os DISK_DEVS"; lista (mesmo vazia) = exatamente estes.
  SMART_DEVS: rawSmartDevs === undefined ? null : sanitizeToken(rawSmartDevs),
  SERVICES: sanitizedServices,
  DASH_TOKEN: env('DASH_TOKEN', '').trim(),
  ALERTS: alertThresholds(undefined, configWarnings),
};
