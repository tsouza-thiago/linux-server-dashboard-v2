// Histórico bruto append-only (ADR 0005): 1 arquivo NDJSON por dia (UTC) em data/history/,
// 1 linha por amostra. Gravar uma amostra acrescenta ~4 KB ao arquivo do dia em vez de
// reescrever o histórico inteiro (corrige B7). As últimas 72 h ficam em memória.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { downsample } from './buckets.js';

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

/** Dia UTC (AAAA-MM-DD) de um timestamp ISO ou em ms. */
export const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * Lê um NDJSON tolerando linhas inválidas e a última linha cortada por uma queda no meio
 * da gravação. `torn` indica que o arquivo não termina em \n.
 */
export function readNdjson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { items: [], bad: 0, torn: false };
    throw err;
  }
  const items = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { items.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { items, bad, torn: raw.length > 0 && !raw.endsWith('\n') };
}

/** Dias (AAAA-MM-DD) com arquivo NDJSON na pasta, em ordem. */
export function listDays(dir) {
  try {
    return fs.readdirSync(dir).map((f) => FILE_RE.exec(f)?.[1]).filter(Boolean).sort();
  } catch {
    return [];
  }
}

/** Grava o arquivo inteiro de forma atômica (tmp + rename), 0600. */
export function writeFileAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const validTs = (s) => s && typeof s.ts === 'string' && Number.isFinite(Date.parse(s.ts));

export class RawStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir pasta dos arquivos diários (dentro de data/)
   * @param {number} [opts.limit] máximo de amostras em memória (HISTORY_LIMIT)
   * @param {number} [opts.retentionMs] janela bruta (padrão 72 h), contada a partir da amostra mais recente
   */
  constructor({ dir, limit = 4320, retentionMs = 72 * HOUR_MS, log = (m) => console.warn(m) } = {}) {
    this.dir = dir;
    this.limit = limit;
    this.retentionMs = retentionMs;
    this.log = log;
    this.samples = [];
    this._torn = new Set();
    this._queue = Promise.resolve();
    this._prunedFor = null;
    this.load();
  }

  fileFor(day) {
    return path.join(this.dir, `${day}.ndjson`);
  }

  load() {
    const days = listDays(this.dir);
    const list = [];
    // Só os últimos dias que podem conter a janela: a retenção conta a partir da amostra
    // mais recente, então lemos de trás para frente até passar da janela.
    const keepDays = Math.ceil(this.retentionMs / DAY_MS) + 1;
    for (const day of days.slice(-keepDays)) {
      const { items, bad, torn } = readNdjson(this.fileFor(day));
      if (bad) this.log(`[history] ${bad} linha(s) inválida(s) ignorada(s) em ${day}.ndjson`);
      if (torn) this._torn.add(day);
      for (const s of items) if (validTs(s)) list.push(s);
    }
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    this.samples = list;
    this._trim();
  }

  _trim() {
    const latest = this.getLatest();
    if (latest) {
      const cutoff = Date.parse(latest.ts) - this.retentionMs;
      let drop = 0;
      while (drop < this.samples.length && Date.parse(this.samples[drop].ts) < cutoff) drop += 1;
      if (drop) this.samples.splice(0, drop);
    }
    if (this.samples.length > this.limit) this.samples.splice(0, this.samples.length - this.limit);
  }

  _enqueue(fn) {
    this._queue = this._queue.then(fn).catch((err) => this.log(`[history] falha ao gravar: ${err.message}`));
    return this._queue;
  }

  /** Acrescenta 1 amostra (memória na hora; disco em fila, sem bloquear o poll). */
  append(sample) {
    if (!validTs(sample)) return this._queue;
    this.samples.push(sample);
    this._trim();
    const day = dayOf(sample.ts);
    const line = `${JSON.stringify(sample)}\n`;
    return this._enqueue(async () => {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      // Arquivo cortado por queda: fecha a linha quebrada antes de acrescentar.
      const prefix = this._torn.delete(day) ? '\n' : '';
      await fsp.appendFile(this.fileFor(day), prefix + line, { mode: 0o600 });
      if (this._prunedFor !== day) {
        this._prunedFor = day;
        await this.prune(Date.parse(sample.ts));
      }
    });
  }

  /** Apaga arquivos diários que já saíram inteiros da janela bruta. */
  async prune(refMs) {
    const firstKeep = dayOf(refMs - this.retentionMs);
    for (const day of listDays(this.dir)) {
      if (day >= firstKeep) break;
      await fsp.rm(this.fileFor(day), { force: true });
    }
  }

  async flush() {
    await this._queue;
  }

  getLatest() {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  getSamples(limit = 120) {
    return this.samples.slice(-limit);
  }

  /** Amostras no intervalo [from, to] (ISO), reduzidas preservando picos. */
  getRange(from, to, limit = 720) {
    const list = this.samples.filter((s) => (!from || s.ts >= from) && (!to || s.ts <= to));
    return downsample(list, limit);
  }

  get length() {
    return this.samples.length;
  }
}
