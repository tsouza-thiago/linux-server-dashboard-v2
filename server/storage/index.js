// Histórico da V2 (ADR 0005): amostras brutas das últimas 72 h (ndjson.js) + agregados de
// 5 min por 90 dias (rollup.js), atrás da mesma interface que o servidor já usava.
import path from 'node:path';
import { RawStore, HOUR_MS } from './ndjson.js';
import { RollupStore, ROLLUP_STEP_MS } from './rollup.js';
import { aggregate, bucketMerger, mergeBuckets } from './buckets.js';
import { mergeSpans, clipSpans } from './coverage.js';

/** Janela das amostras brutas (1 por minuto): 72 h. */
export const RAW_RETENTION_MS = 72 * HOUR_MS;
/** Janela dos agregados de 5 min: 90 dias. */
export const ROLLUP_DAYS = 90;
// Teto de baldes numa resposta (o gráfico não tem largura para mais) e o menor passo (1 min).
const MAX_BUCKETS = 2000;
const MIN_MS = 60000;

// Arredonda `v` para cima, para um múltiplo de `unit`.
const ceilTo = (v, unit) => Math.ceil(v / unit) * unit;

/** Histórico completo do painel: brutas recentes + agregados antigos, numa interface só. */
export class History {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir pasta data/ do painel
   * @param {number} [opts.limit] HISTORY_LIMIT (máximo de amostras brutas em memória)
   */
  constructor({ dataDir, limit = 4320, retentionMs = RAW_RETENTION_MS, rollupDays = ROLLUP_DAYS, log } = {}) {
    this.raw = new RawStore({ dir: path.join(dataDir, 'history'), limit, retentionMs, log });
    this.rollup = new RollupStore({ dir: path.join(dataDir, 'rollup'), retentionDays: rollupDays, log });
    // Retoma baldes que ficaram sem fechar (painel parado ou derrubado).
    const latest = this.raw.getLatest();
    if (latest) this.rollup.close(this.raw.samples, Date.parse(latest.ts));
  }

  // Atalhos para o bruto (o servidor e os testes usam a mesma forma da V1).
  get limit() { return this.raw.limit; }
  get length() { return this.raw.length; }
  get samples() { return this.raw.samples; }

  append(sample) {
    // Fecha os baldes ANTES de o bruto descartar as amostras antigas: depois de uma pausa
    // maior que a janela bruta, o último balde aberto só existe nelas.
    this.rollup.close(this.raw.samples, Date.parse(sample?.ts));
    this.raw.append(sample);
  }

  /** Espera as gravações pendentes dos dois (encerramento do painel, B11). */
  async flush() {
    await Promise.all([this.raw.flush(), this.rollup.flush()]);
  }

  /** Instante (ms) do dado mais antigo conhecido: início do monitoramento, ou null. */
  firstMs() {
    const rolled = this.rollup.firstT();
    const raw = this.raw.samples.length ? Date.parse(this.raw.samples[0].ts) : null;
    const known = [rolled, raw].filter((v) => v !== null);
    return known.length ? Math.min(...known) : null;
  }

  /**
   * Tempo medido em [fromMs, toMs] (ADR 0018): as faixas de 5 min com amostra, agregada ou
   * bruta (as brutas cobrem o balde ainda aberto), mais os intervalos `extra` (as quedas: o
   * painel estava rodando e tentando coletar). Devolve intervalos [início, fim) em ms.
   */
  monitored(fromMs, toMs, extra = []) {
    const spans = [...this.rollup.coverage()];
    for (const s of this.raw.samples) {
      const ms = Date.parse(s.ts);
      if (!(ms >= fromMs - ROLLUP_STEP_MS && ms <= toMs)) continue;
      const t = Math.floor(ms / ROLLUP_STEP_MS) * ROLLUP_STEP_MS;
      spans.push([t, t + ROLLUP_STEP_MS]);
    }
    return clipSpans(mergeSpans([...spans, ...extra]), fromMs, toMs);
  }

  getLatest() { return this.raw.getLatest(); }
  getSamples(limit) { return this.raw.getSamples(limit); }
  getRange(from, to, limit) { return this.raw.getRange(from, to, limit); }

  /**
   * Série agregada por balde para o intervalo pedido, com no máximo `maxPoints` baldes.
   * Dentro da janela bruta usa as amostras de 1 min; antes dela, os agregados de 5 min
   * (o passo vira múltiplo de 5 min para os baldes se encaixarem sem sobreposição).
   * @returns {{from: string, to: string, step: number, buckets: object[]}}
   */
  buckets({ fromMs, toMs, maxPoints = 720 }) {
    // Passo: o intervalo dividido pelos pontos pedidos, em minutos inteiros.
    const points = Math.min(Math.max(maxPoints, 1), MAX_BUCKETS);
    const raw = this.raw.samples;
    const rawStart = raw.length ? Date.parse(raw[0].ts) : Infinity;
    let step = ceilTo(Math.max(MIN_MS, (toMs - fromMs) / points), MIN_MS);
    let old = [];
    let boundary = fromMs;
    if (fromMs < rawStart) {
      step = ceilTo(Math.max(step, ROLLUP_STEP_MS), ROLLUP_STEP_MS);
      // Baldes que começam antes da 1ª amostra bruta alinhada vêm dos agregados.
      boundary = rawStart === Infinity ? toMs + 1 : ceilTo(rawStart, step);
      const first = Math.floor(fromMs / step) * step;
      // Cada agregado lido é somado e solto na hora (#78): nunca os 90 dias de uma vez.
      const merger = bucketMerger(step);
      this.rollup.each(first, Math.min(toMs, boundary - 1), merger.add);
      old = merger.finish().filter((b) => b.t < boundary);
    }
    // Brutas a partir da fronteira, mais as anteriores a ela que ainda não viraram agregado
    // (balde de 5 min aberto): cada amostra entra uma única vez.
    const lastRolled = this.rollup.lastT;
    const recentSamples = raw.filter((s) => {
      const ms = Date.parse(s.ts);
      if (ms < fromMs || ms > toMs) return false;
      return ms >= boundary || Math.floor(ms / ROLLUP_STEP_MS) * ROLLUP_STEP_MS > lastRolled;
    });
    const recent = aggregate(recentSamples, step);
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      step,
      buckets: old.length ? mergeBuckets([...old, ...recent], step) : recent,
    };
  }
}
