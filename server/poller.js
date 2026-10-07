// Fachada da coleta usada pelo servidor (server/index.js) e pelo CLI `--once`.
// A implementação V2 vive em ./collector/ (builder, parser, rates).
import { config, isPlaceholderHost } from './config.js';
import {
  collect as collectV2, describeError, runSSH, smartDue, SSH_OPTS, SMART_INTERVAL_MS,
} from './collector/index.js';
import { buildScript, normalizeTargets } from './collector/builder.js';
import { parseOutput } from './collector/parser.js';
import { computeRates } from './collector/rates.js';

export { describeError, runSSH, smartDue, SSH_OPTS, SMART_INTERVAL_MS, parseOutput, computeRates };

/** Alvos da coleta vindos do .env (já saneados pelo config.js). */
export function configTargets() {
  return normalizeTargets({
    netIf: config.NET_IF,
    mounts: config.DISK_MOUNTS,
    devs: config.DISK_DEVS,
    services: config.SERVICES,
  });
}

/**
 * Comando de coleta (modo direto). Aceita os nomes antigos de override da V1
 * (netIf, diskMounts, diskDevs, services) para os chamadores existentes.
 */
export function buildCommand(overrides = {}, mode = 'basico') {
  const base = configTargets();
  const targets = {
    netIf: overrides.netIf ?? base.netIf,
    mounts: overrides.diskMounts ?? overrides.mounts ?? base.mounts,
    devs: overrides.diskDevs ?? overrides.devs ?? base.devs,
    services: overrides.services ?? base.services,
  };
  return buildScript(targets, mode).script;
}

// Estados de serviço que não indicam parada (o resto vira alerta crítico).
const SERVICE_OK = new Set(['active', 'reloading', 'activating', 'desconhecido']);

/** Alertas da V1 (o motor da V2 chega na F3). SMART só alerta em FAILED (B1). */
export function computeAlerts(sample) {
  const alerts = [];
  for (const d of sample.disks || []) {
    if (d.pct !== null && d.pct !== undefined && d.pct >= 90) {
      alerts.push({ level: 'warning', message: `Disco ${d.mount} com ${d.pct}% usado` });
    }
  }
  if (sample.ram && sample.ram.total > 0) {
    const pct = (sample.ram.used / sample.ram.total) * 100;
    if (pct >= 90) alerts.push({ level: 'warning', message: `RAM usada em ${pct.toFixed(0)}%` });
  }
  if (sample.tempC !== null && sample.tempC !== undefined && sample.tempC >= 60) {
    alerts.push({ level: 'warning', message: `Temperatura CPU ${sample.tempC.toFixed(1)}°C` });
  }
  for (const s of sample.smart || []) {
    if (s.status === 'FAILED') alerts.push({ level: 'critical', message: `SMART /dev/${s.dev}: ${s.status}` });
  }
  for (const [svc, state] of Object.entries(sample.services || {})) {
    if (!SERVICE_OK.has(state)) alerts.push({ level: 'critical', message: `Serviço ${svc} ${state}` });
  }
  return alerts;
}

/** Coleta com os alvos do .env; mesmos parâmetros da V1 (`runner` recebe host e comando). */
export function collect({ host, prev, runner, targets = configTargets(), now } = {}) {
  return collectV2({ host, prev, runner, targets, now, alerts: computeAlerts });
}

const isCLI = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCLI) {
  const host = config.SSH_HOST;
  if (isPlaceholderHost(host)) {
    console.error('ERRO: SSH_HOST não configurado. Rode ./install.sh ou edite o .env.');
    process.exit(1);
  }
  const res = await collect({ host, prev: null });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
