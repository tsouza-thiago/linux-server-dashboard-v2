// Registro de quedas (ADR 0006): transições online/offline em data/outages.ndjson, separado
// dos alertas. Na V1 as quedas eram deduzidas dos alertas, cujo limite de 500 (inflado por
// B3) apagava as antigas (B9); aqui cada queda são 2 linhas pequenas e ficam 90 dias.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readNdjson, writeFileAtomicSync, DAY_MS } from './ndjson.js';

const validEvent = (e) => e && (e.ev === 'off' || e.ev === 'on') && Number.isFinite(Date.parse(e.ts));

export class OutageLog {
  constructor({ file, retentionDays = 90, now = () => Date.now(), log = (m) => console.warn(m) } = {}) {
    this.file = file;
    this.retentionDays = retentionDays;
    this.now = now;
    this.log = log;
    this._queue = Promise.resolve();
    this.events = [];
    this.load();
  }

  load() {
    const { items, bad, torn } = readNdjson(this.file);
    if (bad) this.log(`[quedas] ${bad} linha(s) inválida(s) ignorada(s) em ${path.basename(this.file)}`);
    const events = items.filter(validEvent).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    // Normaliza a sequência (off, on, off, on...) descartando repetidas.
    const clean = [];
    for (const e of events) if ((clean.at(-1)?.ev ?? 'on') !== e.ev) clean.push(e);
    // Quedas encerradas antes da janela de retenção saem do arquivo (reescrita rara).
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    let drop = 0;
    while (drop + 1 < clean.length && clean[drop].ev === 'off' && Date.parse(clean[drop + 1].ts) < cutoff) drop += 2;
    this.events = clean.slice(drop);
    if (drop || bad || torn || clean.length !== items.length) {
      if (this.events.length || items.length) {
        writeFileAtomicSync(this.file, this.events.map((e) => `${JSON.stringify(e)}\n`).join(''));
      }
    }
  }

  /** Há uma queda em andamento (último evento é "off"). */
  get isOpen() {
    return this.events.at(-1)?.ev === 'off';
  }

  _append(event) {
    this.events.push(event);
    const line = `${JSON.stringify(event)}\n`;
    this._queue = this._queue
      .then(async () => {
        await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await fsp.appendFile(this.file, line, { mode: 0o600 });
      })
      .catch((err) => this.log(`[quedas] falha ao gravar: ${err.message}`));
    return this._queue;
  }

  /** Abre uma queda em `ts` (o instante da 1ª falha), se não houver uma aberta. */
  start(ts, reason = '') {
    if (this.isOpen) return null;
    const event = { ts: new Date(ts).toISOString(), ev: 'off', reason: String(reason).slice(0, 200) };
    this._append(event);
    return event;
  }

  /** Fecha a queda aberta em `ts` (servidor respondeu de novo). */
  end(ts) {
    if (!this.isOpen) return null;
    // Relógio da amostra atrás do instante da falha: a queda nunca termina antes de começar.
    const endMs = Math.max(new Date(ts).getTime(), Date.parse(this.events.at(-1).ts));
    const event = { ts: new Date(endMs).toISOString(), ev: 'on' };
    this._append(event);
    return event;
  }

  /** Quedas que tocam [fromMs, toMs], da mais recente para a mais antiga. */
  list({ fromMs = -Infinity, toMs = this.now() } = {}) {
    const out = [];
    for (let i = 0; i < this.events.length; i += 1) {
      const e = this.events[i];
      if (e.ev !== 'off') continue;
      const end = this.events[i + 1];
      const fromT = Date.parse(e.ts);
      const toT = end ? Date.parse(end.ts) : null;
      if (fromT > toMs || (toT !== null && toT < fromMs)) continue;
      out.push({
        from: e.ts,
        to: end ? end.ts : null,
        durationSec: Math.round(((toT ?? this.now()) - fromT) / 1000),
        ongoing: !end,
        reason: e.reason || '',
      });
    }
    return out.reverse();
  }

  /**
   * Disponibilidade em [fromMs, toMs]. `sinceMs` é o início do monitoramento (1º dado
   * conhecido): antes dele não há como saber, então a janela começa ali.
   */
  uptime({ fromMs, toMs = this.now(), sinceMs = -Infinity }) {
    const start = Math.max(fromMs, sinceMs);
    const windowMs = Math.max(0, toMs - start);
    let offlineMs = 0;
    for (const o of this.list({ fromMs: start, toMs })) {
      const a = Math.max(Date.parse(o.from), start);
      const b = Math.min(o.to ? Date.parse(o.to) : this.now(), toMs);
      if (b > a) offlineMs += b - a;
    }
    const uptimePct = windowMs > 0 ? Math.max(0, 100 - (offlineMs / windowMs) * 100) : null;
    return {
      from: new Date(Number.isFinite(start) ? start : toMs).toISOString(),
      to: new Date(toMs).toISOString(),
      windowMs,
      offlineMs,
      uptimePct: uptimePct === null ? null : Math.round(uptimePct * 1000) / 1000,
    };
  }

  async flush() {
    await this._queue;
  }
}
