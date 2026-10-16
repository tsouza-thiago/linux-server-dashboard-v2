// Listas guardadas em JSON em data/: alertas (data/alerts.json) e anotações
// (data/annotations.json). Tudo em memória, gravado em arquivo 0600 de forma atômica e em
// fila, sem perder a última versão se o painel cair no meio da gravação.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Lista em memória (`data`) espelhada num arquivo JSON. */
export class JsonStore {
  constructor({ file, defaults = [] }) {
    this.file = file;
    this.data = defaults;
    // `_pending`: a versão mais nova ainda não gravada; `_lastSave`: a gravação em curso.
    this._pending = null;
    this._lastSave = Promise.resolve();
    this.load();
  }

  /** Lê o arquivo; ausente começa vazio, ilegível avisa no log e começa vazio. */
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[store] falha ao carregar ${this.file}: ${err.message}`);
      }
    }
  }

  /** Grava via arquivo temporário + rename (atômico), pasta 0700 e arquivo 0600. */
  async _atomicWrite(data) {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, data, { mode: 0o600 });
      await fsp.rename(tmp, this.file);
    } catch (err) {
      console.error(`[store] falha ao gravar ${this.file}: ${err.message}`);
    }
  }

  /**
   * Pede uma gravação. Várias chamadas seguidas viram uma só (vale a versão mais nova), e
   * duas gravações nunca correm ao mesmo tempo.
   */
  save() {
    this._pending = JSON.stringify(this.data);
    const run = async () => {
      while (this._pending !== null) {
        const data = this._pending;
        this._pending = null;
        await this._atomicWrite(data);
      }
    };
    this._lastSave = this._lastSave.then(run, run);
    return this._lastSave;
  }

  /** Espera as gravações pendentes (encerramento do painel, B11). */
  async flush() {
    await this._lastSave;
  }
}

// Atualizar só o valor de um alerta aberto (ex.: temperatura 61,2 → 61,5) não regrava o
// arquivo a cada coleta: grava no máximo a cada 10 min, e sempre no encerramento.
const VALUE_SAVE_MS = 10 * 60000;

/**
 * Alertas com ciclo de vida `new` → `ack` (reconhecido) → `resolved`, até `max` (500); os
 * mais antigos saem primeiro.
 */
export class AlertsStore extends JsonStore {
  constructor({ file = 'data/alerts.json', max = 500, now = () => Date.now() } = {}) {
    super({ file });
    this.max = max;
    this.now = now;
    this._dirty = false;
    this._savedAt = 0;
  }

  // Toda gravação real zera a pendência de "só mudou o valor".
  save() {
    this._dirty = false;
    this._savedAt = this.now();
    return super.save();
  }

  // No encerramento, grava também a mudança de valor que estava esperando os 10 min.
  async flush() {
    if (this._dirty) this.save();
    await super.flush();
  }

  /** Abre um alerta novo (id aleatório, status `new`). */
  add({ level, message, key, value }) {
    const ts = new Date(this.now()).toISOString();
    const alert = { id: randomUUID(), ts, level, message, status: 'new' };
    if (key) alert.key = key;
    if (value !== undefined && value !== null) alert.value = value;
    alert.lastSeenAt = ts;
    this.data.push(alert);
    this.trim();
    this.save();
    return alert;
  }

  /** Muda o status (reconhecer ou resolver); id inexistente devolve null. */
  setStatus(id, status) {
    const a = this.data.find((x) => x.id === id);
    if (!a) return null;
    a.status = status;
    if (status === 'resolved') a.resolvedAt = new Date(this.now()).toISOString();
    this.save();
    return a;
  }

  /** Mantém só os `max` alertas mais recentes. */
  trim() {
    if (this.data.length > this.max) {
      this.data.splice(0, this.data.length - this.max);
    }
  }

  /** Alertas abertos (novos ou reconhecidos). */
  get active() {
    return this.data.filter((a) => a.status === 'new' || a.status === 'ack');
  }

  /** Os mais recentes primeiro, com filtro opcional de status e nível. */
  list({ status, level, limit = 100 } = {}) {
    let out = this.data;
    if (status) out = out.filter((a) => a.status === status);
    if (level) out = out.filter((a) => a.level === level);
    return out.slice(-limit).reverse();
  }

  /**
   * Sincroniza os alertas abertos com as condições atuais (ADR 0006). A chave estável da
   * condição identifica o alerta (corrige B3): condição que persiste atualiza mensagem e
   * valor do MESMO alerta; condição que sumiu é resolvida; nova condição abre um alerta.
   * @param {object[]} conditions [{ key, level, message, value }]
   * @param {{keep?: Set<string>|'all'}} [opts] chaves abertas a manter mesmo ausentes
   *   (estado desconhecido nesta coleta; 'all' = servidor inacessível, nada foi medido)
   */
  reconcile(conditions, { keep } = {}) {
    const keyOf = (c) => c.key || c.message;
    const keepKey = keep === 'all' ? () => true : (k) => Boolean(keep && keep.has(k));
    const nowIso = new Date(this.now()).toISOString();
    const wanted = new Map();
    for (const c of conditions) if (!wanted.has(keyOf(c))) wanted.set(keyOf(c), c);
    // `structural`: alerta abriu ou fechou (grava já); `valueChanged`: só o valor mudou.
    let structural = false;
    let valueChanged = false;
    for (const a of this.active) {
      const k = keyOf(a);
      const c = wanted.get(k);
      if (c) {
        wanted.delete(k);
        a.lastSeenAt = nowIso;
        if (a.message !== c.message || (c.value !== undefined && a.value !== c.value)) {
          a.message = c.message;
          if (c.value !== undefined && c.value !== null) a.value = c.value;
          valueChanged = true;
        }
      } else if (!keepKey(k)) {
        a.status = 'resolved';
        a.resolvedAt = nowIso;
        structural = true;
      }
    }
    for (const c of wanted.values()) {
      this.add(c);
      structural = true;
    }
    if (structural) this.save();
    else if (valueChanged) {
      if (this.now() - this._savedAt >= VALUE_SAVE_MS) this.save();
      else this._dirty = true;
    }
  }
}

/** Anotações da linha do tempo (texto até 500 caracteres, rótulo até 80). */
export class AnnotationsStore extends JsonStore {
  constructor({ file = 'data/annotations.json' } = {}) {
    super({ file });
  }

  add({ ts, text, label = '' }) {
    const annotation = {
      id: randomUUID(),
      ts: ts || new Date().toISOString(),
      text: String(text || '').slice(0, 500),
      label: String(label || '').slice(0, 80),
    };
    this.data.push(annotation);
    this.save();
    return annotation;
  }

  /** Remove a anotação; devolve se ela existia. */
  remove(id) {
    const before = this.data.length;
    this.data = this.data.filter((a) => a.id !== id);
    if (this.data.length !== before) this.save();
    return this.data.length !== before;
  }
}