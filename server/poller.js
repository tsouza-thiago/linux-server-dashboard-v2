// Fachada da coleta usada pelo servidor (server/index.js) e pelo CLI `--once`.
// A implementação V2 vive em ./collector/ (builder, parser, rates).
import { config, isPlaceholderHost } from './config.js';
import {
  collect as collectV2, describeError, runSSH, smartDue, SSH_OPTS, SMART_INTERVAL_MS,
} from './collector/index.js';
import { buildScript, normalizeTargets } from './collector/builder.js';
import { parseOutput } from './collector/parser.js';
import { computeRates } from './collector/rates.js';
import { evaluate } from './alerts/rules.js';

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

/**
 * Alertas de uma amostra isolada, pelas regras do motor (server/alerts/rules.js) com os
 * limiares do .env. Sem estado: a histerese e o debounce do offline ficam no motor.
 */
export function computeAlerts(sample, thresholds = config.ALERTS) {
  return evaluate(sample, thresholds).conditions;
}

/** SSH com a configuração própria do painel (data/ssh/config), quando houver. */
export const configRunner = (host, command) => runSSH(host, command, 45000, { configFile: config.SSH_CONFIG });

/** Coleta com os alvos e o acesso do .env; mesmos parâmetros da V1 (`runner` recebe host e comando). */
export function collect({ host, prev, runner = configRunner, targets = configTargets(), now, access = config.SSH_ACESSO } = {}) {
  return collectV2({ host, prev, runner, targets, now, access, alerts: computeAlerts });
}

const isCLI = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCLI) {
  const host = config.SSH_HOST;
  if (isPlaceholderHost(host)) {
    console.error('ERRO: SSH_HOST não configurado. Rode ./dashboard instalar.');
    process.exit(1);
  }
  const res = await collect({ host, prev: null });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
