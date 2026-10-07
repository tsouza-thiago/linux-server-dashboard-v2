// Agregados de 5 min por 90 dias (ADR 0005): 1 linha { t, n, m } por balde fechado, em
// arquivos NDJSON diários (UTC) em data/rollup/. Os baldes são calculados a partir das
// amostras brutas em memória, então fechar de novo um balde já gravado não faz nada
// (idempotente) e uma reinicialização retoma de onde parou.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { aggregate } from './buckets.js';
import { readNdjson, listDays, dayOf, DAY_MS } from './ndjson.js';

export const ROLLUP_STEP_MS = 5 * 60000;

const bucketStart = (ms) => Math.floor(ms / ROLLUP_STEP_MS) * ROLLUP_STEP_MS;
const validBucket = (b) => b && Number.isFinite(b.t) && Number.isFinite(b.n) && b.m && typeof b.m === 'object';

export class RollupStore {
  constructor({ dir, retentionDays = 90, log = (m) => console.warn(m) } = {}) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.log = log;
    this._queue = Promise.resolve();
    this._prunedFor = null;
    this._torn = new Set();
    this.lastT = this._readLastT();
  }

  fileFor(day) {
    return path.join(this.dir, `${day}.ndjson`);
  }

  _readLastT() {
    const days = listDays(this.dir);
    for (let i = days.length - 1; i >= 0; i -= 1) {
      const { items, torn } = readNdjson(this.fileFor(days[i]));
      if (torn) this._torn.add(days[i]);
      const valid = items.filter(validBucket);
      if (valid.length) return valid.reduce((max, b) => (b.t > max ? b.t : max), -Infinity);
    }
    return -Infinity;
  }

  _enqueue(fn) {
    this._queue = this._queue.then(fn).catch((err) => this.log(`[rollup] falha ao gravar: ${err.message}`));
    return this._queue;
  }

  /**
   * Fecha os baldes de 5 min anteriores ao balde de `refMs` que ainda não foram gravados,
   * a partir das amostras brutas.
   */
  close(rawSamples, refMs) {
    if (!Number.isFinite(refMs)) return this._queue;
    const current = bucketStart(refMs);
    const pending = rawSamples.filter((s) => {
      const t = bucketStart(Date.parse(s.ts));
      return t > this.lastT && t < current;
    });
    if (!pending.length) return this._queue;
    const buckets = aggregate(pending, ROLLUP_STEP_MS);
    this.lastT = buckets[buckets.length - 1].t;
    const byDay = new Map();
    for (const b of buckets) {
      const day = dayOf(b.t);
      byDay.set(day, `${byDay.get(day) || ''}${JSON.stringify(b)}\n`);
    }
    return this._enqueue(async () => {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      for (const [day, lines] of byDay) {
        const prefix = this._torn.delete(day) ? '\n' : '';
        await fsp.appendFile(this.fileFor(day), prefix + lines, { mode: 0o600 });
      }
      const lastDay = dayOf(this.lastT);
      if (this._prunedFor !== lastDay) {
        this._prunedFor = lastDay;
        await this.prune(this.lastT);
      }
    });
  }

  /** Apaga os dias que saíram da janela de retenção (padrão 90 dias). */
  async prune(refMs) {
    const firstKeep = dayOf(refMs - this.retentionDays * DAY_MS);
    for (const day of listDays(this.dir)) {
      if (day >= firstKeep) break;
      await fsp.rm(this.fileFor(day), { force: true });
    }
  }

  /** Início (ms) do balde mais antigo guardado, ou null. */
  firstT() {
    for (const day of listDays(this.dir)) {
      const first = readNdjson(this.fileFor(day)).items.find(validBucket);
      if (first) return first.t;
    }
    return null;
  }

  /** Baldes de 5 min com início em [fromMs, toMs], em ordem, sem duplicatas. */
  query(fromMs, toMs) {
    const firstDay = dayOf(Math.max(fromMs, 0));
    const lastDay = dayOf(toMs);
    const byT = new Map();
    for (const day of listDays(this.dir)) {
      if (day < firstDay || day > lastDay) continue;
      for (const b of readNdjson(this.fileFor(day)).items) {
        if (validBucket(b) && b.t >= fromMs && b.t <= toMs) byT.set(b.t, b);
      }
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }

  /** Grava baldes prontos (migração): mescla com o que já existe, por `t`. */
  writeBucketsSync(buckets, writeFile) {
    const byDay = new Map();
    for (const b of buckets) {
      const day = dayOf(b.t);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(b);
    }
    for (const [day, list] of byDay) {
      const merged = new Map();
      for (const b of readNdjson(this.fileFor(day)).items) if (validBucket(b)) merged.set(b.t, b);
      for (const b of list) merged.set(b.t, b);
      const lines = [...merged.values()].sort((a, b) => a.t - b.t).map((b) => JSON.stringify(b)).join('\n');
      writeFile(this.fileFor(day), `${lines}\n`);
    }
    for (const b of buckets) if (b.t > this.lastT) this.lastT = b.t;
  }

  async flush() {
    await this._queue;
  }

  /** Bytes ocupados pelos agregados (para a tela de configuração/diagnóstico). */
  sizeBytes() {
    return listDays(this.dir).reduce((n, d) => {
      try { return n + fs.statSync(this.fileFor(d)).size; } catch { return n; }
    }, 0);
  }
}
