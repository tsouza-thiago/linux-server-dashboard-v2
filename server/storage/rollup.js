// Agregados de 5 min por 90 dias (ADR 0005): 1 linha { t, n, m } por balde fechado, em
// arquivos NDJSON diários (UTC) em data/rollup/. Os baldes são calculados a partir das
// amostras brutas em memória, então fechar de novo um balde já gravado não faz nada
// (idempotente) e uma reinicialização retoma de onde parou.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { aggregate } from './buckets.js';
import { readNdjson, listDays, dayOf, DAY_MS } from './ndjson.js';
import { mergeSpans, clipSpans } from './coverage.js';

/** Tamanho de um balde agregado: 5 min. */
export const ROLLUP_STEP_MS = 5 * 60000;

// Início do balde de 5 min que contém `ms`; e se um balde lido do disco tem a forma certa.
const bucketStart = (ms) => Math.floor(ms / ROLLUP_STEP_MS) * ROLLUP_STEP_MS;
const validBucket = (b) => b && Number.isFinite(b.t) && Number.isFinite(b.n) && b.m && typeof b.m === 'object';

/** Os agregados de 5 min em data/rollup/ (gravação só por acréscimo, em fila). */
export class RollupStore {
  constructor({ dir, retentionDays = 90, log = (m) => console.warn(m) } = {}) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.log = log;
    this._queue = Promise.resolve();
    this._prunedFor = null;
    this._torn = new Set();
    // Início do último balde já gravado: tudo até ele está fechado.
    this.lastT = this._readLastT();
    // Faixas de 5 min com amostra (ADR 0018), lidas do disco no 1º pedido (coverage()).
    this._coverage = null;
  }

  /**
   * Faixas de 5 min com pelo menos 1 amostra guardadas nos agregados (ADR 0018), juntadas
   * em intervalos [início, fim) em ms. Ler os 90 dias com JSON.parse custaria ~29 MB de
   * objetos a cada pedido; aqui o disco é lido 1 vez, só o `t` e o `n` de cada linha, e a
   * lista curta que sobra fica em memória, atualizada a cada balde fechado.
   */
  coverage() {
    if (!this._coverage) this._coverage = mergeSpans(this._scanCoverage());
    return this._coverage;
  }

  /** Lê `t` e `n` de cada balde do disco (cada linha começa com {"t":…,"n":…). */
  _scanCoverage() {
    const spans = [];
    for (const day of listDays(this.dir)) {
      let text;
      try { text = fs.readFileSync(this.fileFor(day), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const m = /^\{"t":(\d+),"n":(\d+)[,}]/.exec(line);
        let t = m ? Number(m[1]) : NaN;
        let n = m ? Number(m[2]) : 0;
        // Linha em outra ordem (gravada à mão ou por versão futura): lê o JSON inteiro.
        if (!m && line.trim()) {
          try { const b = JSON.parse(line); if (validBucket(b)) { t = b.t; n = b.n; } } catch { /* linha inválida */ }
        }
        if (n > 0 && Number.isFinite(t)) spans.push([t, t + ROLLUP_STEP_MS]);
      }
    }
    return spans;
  }

  /** Acrescenta à cobertura em memória os baldes que acabaram de fechar. */
  _addCoverage(buckets) {
    if (!this._coverage) return;
    const fresh = buckets.filter((b) => b.n > 0).map((b) => [b.t, b.t + ROLLUP_STEP_MS]);
    this._coverage = mergeSpans([...this._coverage, ...fresh]);
  }

  /** Caminho do arquivo NDJSON de um dia. */
  fileFor(day) {
    return path.join(this.dir, `${day}.ndjson`);
  }

  /** Lê do disco o último balde gravado (do dia mais novo para trás); nenhum = -Infinity. */
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

  /** Põe uma gravação na fila; erro de disco vai para o log e não para as seguintes. */
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
    this._addCoverage(buckets);
    // Agrupa as linhas por arquivo diário para gravar cada dia de uma vez.
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
    // A cobertura em memória perde o mesmo que o disco (o dia mais antigo que ficou começa
    // à meia-noite UTC de firstKeep).
    if (this._coverage) this._coverage = clipSpans(this._coverage, Date.parse(`${firstKeep}T00:00:00.000Z`), Infinity);
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
    // Baldes gravados no meio do que já existia: a cobertura é relida no próximo pedido.
    this._coverage = null;
  }

  /** Espera as gravações pendentes. */
  async flush() {
    await this._queue;
  }

  /** Bytes ocupados pelos agregados em disco (conferido em test/unit/storage-rollup.test.js). */
  sizeBytes() {
    return listDays(this.dir).reduce((n, d) => {
      try { return n + fs.statSync(this.fileFor(d)).size; } catch { return n; }
    }, 0);
  }
}
