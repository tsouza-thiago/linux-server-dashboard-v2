// Fachada da coleta: liga ./collector/ (builder, parser, rates) à configuração do .env e às
// regras de alerta. Quem usa: o servidor (server/index.js) e o scripts/capturar-amostra.mjs.
import { config } from './config.js';
import { collect as collectV2, runSSH } from './collector/index.js';
import { buildScript, normalizeTargets } from './collector/builder.js';
import { evaluate } from './alerts/rules.js';

/** Alvos da coleta vindos do .env (já saneados pelo config.js). */
export function configTargets() {
  return normalizeTargets({
    netIf: config.NET_IF,
    mounts: config.DISK_MOUNTS,
    devs: config.DISK_DEVS,
    smartDevs: config.SMART_DEVS,
    services: config.SERVICES,
  });
}

/**
 * Comando de coleta (modo direto), com os alvos do .env e, se dados, alguns trocados.
 */
export function buildCommand(overrides = {}, mode = 'basico') {
  const base = configTargets();
  const targets = {
    netIf: overrides.netIf ?? base.netIf,
    mounts: overrides.mounts ?? base.mounts,
    devs: overrides.devs ?? base.devs,
    // Discos trocados no override sem SMART explícito: o SMART segue os mesmos discos.
    smartDevs: overrides.smartDevs ?? (overrides.devs ? undefined : base.smartDevs),
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
const configRunner = (host, command) => runSSH(host, command, 45000, { configFile: config.SSH_CONFIG });

/** Coleta com os alvos e o acesso do .env (`runner` recebe host e comando; injetável nos testes). */
export function collect({ host, prev, runner = configRunner, targets = configTargets(), now, access = config.SSH_ACESSO } = {}) {
  return collectV2({ host, prev, runner, targets, now, access, alerts: computeAlerts });
}
