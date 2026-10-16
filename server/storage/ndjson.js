// Histórico bruto append-only (ADR 0005): 1 arquivo NDJSON por dia (UTC) em data/history/,
// 1 linha por amostra. Gravar uma amostra acrescenta ~4 KB ao arquivo do dia em vez de
// reescrever o histórico inteiro (corrige B7). As últimas 72 h ficam em memória; só a
// amostra mais recente guarda os processos (compactSample).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { downsample } from './buckets.js';

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
// Nome dos arquivos diários: AAAA-MM-DD.ndjson (qualquer outro arquivo da pasta é ignorado).
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

/** Dia UTC (AAAA-MM-DD) de um timestamp ISO ou em ms. */
export const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * Lê um NDJSON tolerando linhas inválidas e a última linha cortada por uma queda no meio
 * da gravação. `torn` indica que o arquivo não termina em \n. Lê em blocos de 1 MB (não o
 * arquivo inteiro de uma vez): ao reiniciar com 72 h no disco, o pico de memória é o de um
 * bloco, não o de ~17 MB de texto. `map` transforma cada item logo que ele é lido.
 */
export function readNdjson(file, { map = null } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { items: [], bad: 0, torn: false };
    throw err;
  }
  const items = [];
  let bad = 0;
  let rest = '';
  let lastByte = null;
  const decoder = new StringDecoder('utf8');
  // Uma linha → um item; linha vazia é pulada e JSON inválido só conta em `bad`.
  const take = (line) => {
    if (!line.trim()) return;
    let item;
    try { item = JSON.parse(line); } catch { bad += 1; return; }
    items.push(map ? map(item, items.length) : item);
  };
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      lastByte = buf[n - 1];
      // O StringDecoder não parte um caractere UTF-8 de vários bytes entre dois blocos, e o
      // pedaço depois do último \n (`rest`) espera o bloco seguinte.
      const text = rest + decoder.write(buf.subarray(0, n));
      const lines = text.split('\n');
      rest = lines.pop();
      for (const line of lines) take(line);
    }
    take(rest + decoder.end());
  } finally {
    fs.closeSync(fd);
  }
  return { items, bad, torn: lastByte !== null && lastByte !== 0x0a };
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

/** A amostra tem `ts` em texto que é uma data válida (as outras são descartadas). */
export const validTs = (s) => s && typeof s.ts === 'string' && Number.isFinite(Date.parse(s.ts));

/**
 * Forma compacta de uma amostra que deixou de ser a mais recente (orçamento de RAM do AGENTS).
 * Os processos (`topProcs`, ~35% da amostra) só servem para a amostra atual: as telas não
 * os leem do histórico. A ida e volta por JSON deixa o objeto igual ao lido do disco
 * (mesma forma que após reiniciar) e mais leve que o montado pelo coletor. O arquivo
 * NDJSON continua com a amostra inteira.
 */
function compactSample(sample) {
  const { topProcs, ...rest } = sample;
  return JSON.parse(JSON.stringify(rest));
}

/** As amostras brutas: em memória (as últimas 72 h) e nos arquivos diários de data/history/. */
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
    // Dias cujo arquivo terminou com linha cortada (a próxima gravação fecha a linha antes).
    this._torn = new Set();
    // Fila das gravações em disco (uma de cada vez, na ordem das coletas).
    this._queue = Promise.resolve();
    // Dia para o qual a limpeza de arquivos velhos já rodou (1 vez por dia basta).
    this._prunedFor = null;
    this.load();
  }

  /** Caminho do arquivo NDJSON de um dia. */
  fileFor(day) {
    return path.join(this.dir, `${day}.ndjson`);
  }

  /** Recarrega do disco as amostras da janela (ao iniciar o painel). */
  load() {
    const days = listDays(this.dir);
    const list = [];
    // Só os últimos dias que podem conter a janela: a retenção conta a partir da amostra
    // mais recente, então lemos de trás para frente até passar da janela.
    const keepDays = Math.ceil(this.retentionMs / DAY_MS) + 1;
    for (const day of days.slice(-keepDays)) {
      // Cada amostra perde os processos logo ao ser lida (compactSample); a mais recente
      // é a última linha do último dia, e os processos dela voltam abaixo.
      let last = null;
      const { items, bad, torn } = readNdjson(this.fileFor(day), {
        map: (s) => { last = s; const { topProcs, ...rest } = s; return rest; },
      });
      if (bad) this.log(`[history] ${bad} linha(s) inválida(s) ignorada(s) em ${day}.ndjson`);
      if (torn) this._torn.add(day);
      for (const s of items) if (validTs(s)) list.push(s);
      if (last && validTs(last) && list.length && list[list.length - 1].ts === last.ts) list[list.length - 1] = last;
    }
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    // Fora de ordem (relógio que voltou): só a mais recente fica com os processos.
    for (let i = 0; i < list.length - 1; i++) if (list[i].topProcs) list[i] = compactSample(list[i]);
    this.samples = list;
    this._trim();
  }

  /** Tira da memória o que saiu da janela de 72 h ou passou de `limit` amostras. */
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

  /** Põe uma gravação na fila; erro de disco vai para o log e não para as seguintes. */
  _enqueue(fn) {
    this._queue = this._queue.then(fn).catch((err) => this.log(`[history] falha ao gravar: ${err.message}`));
    return this._queue;
  }

  /** Acrescenta 1 amostra (memória na hora; disco em fila, sem bloquear o poll). */
  append(sample) {
    if (!validTs(sample)) return this._queue;
    const prev = this.samples.length - 1;
    if (prev >= 0) this.samples[prev] = compactSample(this.samples[prev]);
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

  /** Espera as gravações pendentes (encerramento do painel, B11). */
  async flush() {
    await this._queue;
  }

  /** A amostra mais recente (a única com os processos), ou null. */
  getLatest() {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  /** As `limit` amostras mais recentes, em ordem. */
  getSamples(limit = 120) {
    return this.samples.slice(-limit);
  }

  /** Amostras no intervalo [from, to] (ISO), reduzidas preservando picos. */
  getRange(from, to, limit = 720) {
    const list = this.samples.filter((s) => (!from || s.ts >= from) && (!to || s.ts <= to));
    return downsample(list, limit);
  }

  /** Quantas amostras estão em memória. */
  get length() {
    return this.samples.length;
  }
}
