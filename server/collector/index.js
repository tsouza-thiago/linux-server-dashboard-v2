// Coleta V2: 1 conexão SSH por chamada, comando de ./builder.js, saída lida por ./parser.js
// e taxas de ./rates.js. O teste SMART roda no máximo 1x por intervalo (padrão 1 h): ele
// passa pelo sudo, e cada sudo grava 1 linha de log no servidor (discos SMR, ADR 0008).
import { spawn } from 'node:child_process';
import { buildScript, normalizeTargets } from './builder.js';
import { parseOutput } from './parser.js';
import { computeRates } from './rates.js';

export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
export const SMART_INTERVAL_MS = 3600000;
// Uma coleta normal tem ~3–7 KB. Acima de 1 MB a resposta não é a da coleta (servidor
// comprometido ou quebrado): a conexão é cortada para não encher a memória desta máquina.
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Executa 1 comando no host por SSH não interativo. Nunca lança: devolve o resultado.
 * Com `configFile`, usa só aquele arquivo (`ssh -F`, data/ssh/config): o ~/.ssh/config da
 * pessoa não entra na conta e o known_hosts é o do painel.
 */
export function runSSH(host, command, timeoutMs = 45000, { configFile = '', maxBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve) => {
    if (!host || String(host).startsWith('-')) {
      resolve({ stdout: '', stderr: '', code: 255, timedOut: false, error: 'host inválido' });
      return;
    }
    const args = [...(configFile ? ['-F', configFile] : []), ...SSH_OPTS, host, command];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let bytes = 0;
    let tooBig = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const take = (d) => {
      bytes += d.length;
      if (bytes <= maxBytes) return String(d);
      if (!tooBig) { tooBig = true; child.kill('SIGKILL'); }
      return '';
    };
    child.stdout.on('data', (d) => { stdout += take(d); });
    child.stderr.on('data', (d) => { stderr += take(d); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (tooBig) {
        resolve({ stdout: '', stderr: '', code, timedOut, error: `resposta grande demais (mais de ${Math.round(maxBytes / 1024)} KB) — não parece a coleta; a conexão foi cortada` });
        return;
      }
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
    return 'identidade do servidor desconhecida ou mudou — confira e rode ./dashboard reconfigurar';
  }
  if (code === 255) return 'SSH falhou (exit 255) — host não encontrado ou chave inválida';
  if (code !== null && code !== undefined) return `SSH falhou (exit ${code})`;
  return 'sem resposta';
}

/** O SMART é pedido quando há discos configurados e o último teste tem mais de 1 intervalo. */
export function smartDue(targets, prev, nowMs, intervalMs = SMART_INTERVAL_MS) {
  if (!(targets.smartDevs ?? targets.devs).length) return false;
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
 * @param {'direto'|'restrito'} [p.access] restrito: o script mora no authorized_keys e o
 *   painel envia só a palavra do modo ("basico" ou "smart")
 */
export async function collect({ host, prev = null, targets, runner = runSSH, alerts = () => [], now = Date.now(), access = 'direto' }) {
  const t = normalizeTargets(targets);
  const ts = new Date(now).toISOString();
  const mode = smartDue(t, prev, now) ? 'smart' : 'basico';
  const { script, hash } = buildScript(t, mode);
  const started = performance.now();
  const { stdout, stderr, code, timedOut, error } = await runner(host, access === 'restrito' ? mode : script);
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
