import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

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

const fileEnv = loadEnvFile();
export const env = (key, def) => {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === '' ? def : v;
};

const TOKEN_RE = /^[A-Za-z0-9_./:-]+$/;

export function sanitizeToken(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => TOKEN_RE.test(t) && !t.startsWith('-'));
}

const PLACEHOLDER_RE = /seu[-_ ]?host|seu_host|usuario@ip/i;

export function isPlaceholderHost(value) {
  return PLACEHOLDER_RE.test(String(value || ''));
}

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

/** Limiares dos alertas (ADR 0006): fonte única para o motor, o índice de saúde e a UI. */
export function alertThresholds(get = (k) => env(k, ''), warnings = []) {
  return {
    diskPct: intSetting('ALERT_DISK_PCT', get('ALERT_DISK_PCT'), 90, 50, 99, warnings),
    ramPct: intSetting('ALERT_RAM_PCT', get('ALERT_RAM_PCT'), 90, 50, 99, warnings),
    tempC: intSetting('ALERT_TEMP_C', get('ALERT_TEMP_C'), 60, 30, 110, warnings),
    hysteresis: intSetting('ALERT_HYSTERESIS', get('ALERT_HYSTERESIS'), 5, 0, 20, warnings),
    offlineAfter: intSetting('ALERT_OFFLINE_AFTER', get('ALERT_OFFLINE_AFTER'), 2, 1, 10, warnings),
  };
}

export function clampPathToData(value, fallbackBasename) {
  const p = path.resolve(ROOT, value || '');
  const dataDir = path.join(ROOT, 'data');
  if (p === dataDir || p.startsWith(dataDir + path.sep)) return p;
  return path.join(dataDir, fallbackBasename);
}

const sanitizedMounts = sanitizeToken(env('DISK_MOUNTS', '/'));
const sanitizedDevs = sanitizeToken(env('DISK_DEVS', ''));
const sanitizedServices = sanitizeToken(env('SERVICES', ''));
const sanitizedNetIf = sanitizeToken(env('NET_IF', ''));

export function sanitizeHost(value) {
  const v = String(value || '').trim();
  if (!v || v.startsWith('-')) return 'seu-host';
  return v;
}

/** Avisos de configuração (valores recusados), mostrados no log ao iniciar. */
export const configWarnings = [];

export const config = {
  SSH_HOST: sanitizeHost(env('SSH_HOST', 'seu-host')),
  POLL_INTERVAL: clampInt(env('POLL_INTERVAL', ''), 60000, 10000, 3600000),
  PORT: clampInt(env('PORT', ''), 3000, 1, 65535),
  HISTORY_LIMIT: clampInt(env('HISTORY_LIMIT', ''), 4320, 100, 100000),
  HISTORY_FILE: clampPathToData(env('HISTORY_FILE', ''), 'history.json'),
  LOG_FILE: clampPathToData(env('LOG_FILE', ''), 'dashboard.log'),
  NET_IF: sanitizedNetIf[0] || '',
  DISK_MOUNTS: sanitizedMounts.length ? sanitizedMounts : ['/'],
  DISK_DEVS: sanitizedDevs,
  SERVICES: sanitizedServices,
  DASH_TOKEN: env('DASH_TOKEN', '').trim(),
  ALERTS: alertThresholds(undefined, configWarnings),
};