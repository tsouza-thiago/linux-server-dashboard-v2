// Coleta V2: 1 conexão SSH por chamada, comando de ./builder.js, saída lida por ./parser.js
// e taxas de ./rates.js. O teste SMART roda no máximo 1x por intervalo (padrão 1 h): ele
// passa pelo sudo, e cada sudo grava 1 linha de log no servidor (discos SMR, ADR 0008).
import { spawn } from 'node:child_process';
import { buildScript, normalizeTargets } from './builder.js';
import { parseOutput } from './parser.js';
import { computeRates } from './rates.js';

export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
export const SMART_INTERVAL_MS = 3600000;

/** Executa 1 comando no host por SSH não interativo. Nunca lança: devolve o resultado. */
export function runSSH(host, command, timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (!host || String(host).startsWith('-')) {
      resolve({ stdout: '', stderr: '', code: 255, timedOut: false, error: 'host inválido' });
      return;
    }
    const child = spawn('ssh', [...SSH_OPTS, host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: -1, timedOut, error: err.message });
    });
  });
}

export function describeError({ code, error, stderr, timedOut }) {
  if (timedOut) return 'timeout — servidor não respondeu (rede/servidor fora do ar?)';
  if (error) return error;
  if (stderr && /Host key verification/i.test(stderr)) {
    return 'chave do servidor não autorizada — rode ./install.sh para autorizar';
  }
  if (code === 255) return 'SSH falhou (exit 255) — host não encontrado ou chave inválida';
  if (code !== null && code !== undefined) return `SSH falhou (exit ${code})`;
  return 'sem resposta';
}

/** O SMART é pedido quando há discos configurados e o último teste tem mais de 1 intervalo. */
export function smartDue(targets, prev, nowMs, intervalMs = SMART_INTERVAL_MS) {
  if (!targets.devs.length) return false;
  const last = prev && prev.smartAt ? Date.parse(prev.smartAt) : NaN;
  return !Number.isFinite(last) || nowMs - last >= intervalMs;
}

/**
 * Faz 1 coleta.
 * @param {object} p
 * @param {string} p.host alias SSH ou user@host
 * @param {object|null} p.prev amostra anterior (para taxas e para manter o último SMART)
 * @param {object} p.targets alvos da coleta (netIf, mounts, devs, services)
 * @param {Function} [p.runner] (host, command) => resultado do SSH (injetável nos testes)
 * @param {Function} [p.alerts] amostra => lista de alertas
 * @param {number} [p.now] relógio (ms), injetável
 */
export async function collect({ host, prev = null, targets, runner = runSSH, alerts = () => [], now = Date.now() }) {
  const t = normalizeTargets(targets);
  const ts = new Date(now).toISOString();
  const mode = smartDue(t, prev, now) ? 'smart' : 'basico';
  const { script, hash } = buildScript(t, mode);
  const started = performance.now();
  const { stdout, stderr, code, timedOut, error } = await runner(host, script);
  const durationMs = Math.round(performance.now() - started);
  if (code !== 0 || !stdout || !stdout.includes('===HOST===')) {
    return { ok: false, error: describeError({ code, error, stderr, timedOut }), ts };
  }
  const sample = parseOutput(stdout, ts, { targets: t });
  sample.collector.expectedHash = hash;
  sample.collector.hashMismatch = sample.collector.hash !== null && sample.collector.hash !== hash;
  // Custo da coleta no servidor (faixa de status e Visão geral): tempo do SSH e tamanho da saída.
  sample.collector.durationMs = durationMs;
  sample.collector.outputBytes = Buffer.byteLength(stdout);
  if (sample.smart === null && prev && prev.smart) {
    sample.smart = prev.smart;
    sample.smartAt = prev.smartAt ?? null;
  }
  computeRates(sample, prev);
  return { ok: true, sample, alerts: alerts(sample) };
}
