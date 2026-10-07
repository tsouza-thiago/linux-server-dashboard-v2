// SSE (Server-Sent Events) com backfill: cada amostra sai com `id:` = instante dela (ms).
// Quando a conexão cai, o navegador reconecta sozinho mandando `Last-Event-ID`, e o
// servidor reenvia as amostras que ficaram faltando antes de seguir ao vivo.
export const MAX_BACKFILL = 2000;

export function formatEvent(event, data, id) {
  return `${id !== undefined && id !== null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Último id recebido pelo navegador (ms), ou null. */
export function lastEventId(req) {
  const raw = req.headers['last-event-id'];
  if (raw === undefined) return null;
  const n = Number(String(raw).trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const sampleId = (sample) => {
  const ms = Date.parse(sample?.ts);
  return Number.isFinite(ms) ? ms : undefined;
};

export class SseHub {
  constructor({ maxClients = 20, heartbeatMs = 30000, retryMs = 5000 } = {}) {
    this.maxClients = maxClients;
    this.heartbeatMs = heartbeatMs;
    this.retryMs = retryMs;
    this.clients = new Set();
  }

  get size() {
    return this.clients.size;
  }

  /**
   * Abre a conexão. `initial` é a lista de [evento, dados, id?] enviada logo de início
   * (backfill + estado atual). Recusa com 503 acima do limite de conexões.
   */
  open(req, res, initial = []) {
    if (this.clients.size >= this.maxClients) {
      return res.status(503).json({ error: 'conexões demais com o painel — feche outras abas' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${this.retryMs}\n\n`);
    for (const [event, data, id] of initial) res.write(formatEvent(event, data, id));
    this.clients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), this.heartbeatMs);
    keepAlive.unref?.();
    req.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
    });
    return res;
  }

  send(event, data, id) {
    const payload = formatEvent(event, data, id);
    for (const res of this.clients) res.write(payload);
  }

  closeAll() {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
