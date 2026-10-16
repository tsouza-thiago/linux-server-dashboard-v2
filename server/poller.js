// Fachada da coleta: liga ./collector/ (builder, parser, rates) à configuração do .env e às
// regras de alerta. Quem usa: o servidor (server/index.js), o `npm run poll` (`--once`, uma
// coleta impressa em JSON) e o scripts/capturar-amostra.mjs.
import { config, isPlaceholderHost } from './config.js';
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
 * Aceita os nomes da V1 (`diskMounts`, `diskDevs`) além de `mounts` e `devs`.
 */
export function buildCommand(overrides = {}, mode = 'basico') {
  const base = configTargets();
  const targets = {
    netIf: overrides.netIf ?? base.netIf,
    mounts: overrides.diskMounts ?? overrides.mounts ?? base.mounts,
    devs: overrides.diskDevs ?? overrides.devs ?? base.devs,
    // Discos trocados no override sem SMART explícito: o SMART segue os mesmos discos.
    smartDevs: overrides.smartDevs ?? (overrides.diskDevs || overrides.devs ? undefined : base.smartDevs),
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

// Rodando direto (`node server/poller.js --once`, o `npm run poll`)? Compara só o nome do
// arquivo: funciona também com a pasta atrás de um link simbólico.
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
