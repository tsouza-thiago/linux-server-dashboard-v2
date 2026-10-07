import fs from 'node:fs';
import path from 'node:path';
import { createRouter, jsonBody } from './http/router.js';
import { serveStatic, sendFile } from './http/static.js';
import { History } from './storage/index.js';
import { migrateV1 } from './storage/migrate-v1.js';
import { AlertsStore, AnnotationsStore } from './stores.js';
import { OutageLog } from './storage/outages.js';
import { AlertEngine } from './alerts/engine.js';
import { collect } from './poller.js';
import { config, configWarnings, ROOT, isPlaceholderHost } from './config.js';
import { hostCheck, csrfCheck, securityHeaders, makeRequireAuth, issueCsrfCookie, makeRateLimit } from './security.js';
import { toCSV } from './csv.js';

export function createApp(deps = {}) {
  const SSH_HOST = deps.sshHost ?? config.SSH_HOST;
  const POLL_INTERVAL = deps.pollInterval ?? config.POLL_INTERVAL;
  const HISTORY_FILE = deps.historyFile ?? config.HISTORY_FILE;
  const LOG_FILE = deps.logFile ?? config.LOG_FILE;
  const DASH_TOKEN = deps.dashToken ?? config.DASH_TOKEN;
  const collectFn = deps.collect ?? collect;
  const log = deps.log || ((msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
  });

  // Histórico (ADR 0005) em data/: bruto em history/, agregados em rollup/. Na 1ª subida
  // depois da V1, o data/history.json antigo é migrado e guardado como backup.
  const DATA_DIR = deps.dataDir ?? path.dirname(HISTORY_FILE);
  let store = deps.store;
  if (!store) {
    const migration = migrateV1({ v1File: HISTORY_FILE, dataDir: DATA_DIR, log });
    if (migration.status === 'invalido') log(`[migração] histórico da V1 não migrado: ${migration.error}`);
    store = new History({ dataDir: DATA_DIR, limit: deps.historyLimit ?? config.HISTORY_LIMIT, log });
  }
  const alertsStore = deps.alertsStore || new AlertsStore({
    file: deps.alertsFile ?? path.join(ROOT, 'data/alerts.json'),
  });
  const annotationsStore = deps.annotationsStore || new AnnotationsStore({
    file: deps.annotationsFile ?? path.join(ROOT, 'data/annotations.json'),
  });
  const thresholds = deps.thresholds ?? config.ALERTS;
  const outages = deps.outages || new OutageLog({
    file: deps.outagesFile ?? path.join(path.dirname(alertsStore.file), 'outages.ndjson'),
    log,
  });
  const engine = new AlertEngine({ alerts: alertsStore, outages, thresholds });

  const state = {
    online: false,
    offlineSince: null,
    lastPollAt: null,
    nextPollAt: null,
    lastError: null,
    polling: false,
    lastManualPollAt: 0,
    failures: 0,
  };

  const apiRateLimit = makeRateLimit({ windowMs: 60000, max: deps.rateLimitMax ?? 120 });

  const sseClients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  }

  function broadcastAlerts() {
    broadcast('alerts', { alerts: alertsStore.active, all: alertsStore.list({ limit: 50 }) });
  }

  async function runPoll({ manual = false } = {}) {
    if (state.polling) return;
    state.polling = true;
    const started = Date.now();
    try {
      const res = await collectFn({ host: SSH_HOST, prev: store.getLatest() });
      state.lastPollAt = new Date().toISOString();
      state.nextPollAt = new Date(Date.now() + POLL_INTERVAL).toISOString();
      if (res.ok) {
        state.online = true;
        state.offlineSince = null;
        state.lastError = null;
        state.failures = 0;
        store.append(res.sample);
        engine.onSample(res.sample);
        log(`poll OK (${Date.now() - started}ms) — amostras: ${store.length}`);
        broadcast('sample', { sample: res.sample, alerts: alertsStore.active, health: engine.health(res.sample) });
        broadcastAlerts();
      } else {
        recordFailure(res.error);
      }
    } catch (err) {
      log(`poll ERRO: ${err.stack || err.message}`);
      recordFailure(err.message);
    } finally {
      state.polling = false;
    }
  }

  // Falha de coleta: o motor decide quando vira "servidor inacessível" (debounce). Até lá o
  // estado online não pisca; antes da 1ª coleta OK ele já começa como offline.
  function recordFailure(error) {
    state.lastError = error;
    const { offline, failures } = engine.onFailure(error);
    state.failures = failures;
    if (offline) {
      state.online = false;
      state.offlineSince = engine.offlineSince;
    }
    log(`poll FALHOU (${failures}x seguidas): ${error}`);
    broadcast('status', statusPayload());
    broadcastAlerts();
  }

  function statusPayload() {
    return {
      meta: {
        host: SSH_HOST,
        online: state.online,
        offlineSince: state.offlineSince,
        lastPollAt: state.lastPollAt,
        nextPollAt: state.nextPollAt,
        lastError: state.lastError,
        failures: state.failures,
        thresholds,
        pollIntervalMs: POLL_INTERVAL,
        historySize: store.length,
        historyLimit: store.limit,
        serverTime: new Date().toISOString(),
      },
      sample: store.getLatest(),
      alerts: alertsStore.active,
      health: engine.health(store.getLatest()),
    };
  }

  const HOUR_MS = 3600000;
  const MAX_RANGE_MS = 91 * 24 * HOUR_MS;

  /** Intervalo de `formato=baldes`: padrão últimas 24 h; null se inválido. */
  function parseBucketRange(req) {
    const latest = store.getLatest();
    const toMs = req.query.to ? Date.parse(req.query.to) : (latest ? Date.parse(latest.ts) : Date.now());
    const fromMs = req.query.from ? Date.parse(req.query.from) : toMs - 24 * HOUR_MS;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs || toMs - fromMs > MAX_RANGE_MS) return null;
    const maxPoints = Math.min(Math.max(parseInt(req.query.limit, 10) || 720, 1), 2000);
    return { fromMs, toMs, maxPoints };
  }

  function parseRange(req) {
    const from = req.query.from || undefined;
    const to = req.query.to || undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 720, 1), 2000);
    return { from, to, limit };
  }

  const app = createRouter();
  // Cabeçalhos de segurança primeiro: valem também para as respostas 403/401 das checagens.
  app.use(securityHeaders);
  app.use(hostCheck);
  app.use(csrfCheck);
  app.use(issueCsrfCookie);
  app.use(jsonBody({ limit: 50 * 1024 }));
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return apiRateLimit(req, res, next);
    next();
  });
  app.use('/api', makeRequireAuth(DASH_TOKEN));

  app.get('/api/status', (req, res) => {
    res.json(statusPayload());
  });

  app.get('/api/history', (req, res) => {
    if (req.query.formato === 'baldes') {
      const range = parseBucketRange(req);
      if (!range) return res.status(400).json({ error: 'intervalo inválido (from ≤ to, até 90 dias)' });
      if (typeof store.buckets !== 'function') return res.status(501).json({ error: 'histórico sem agregação' });
      return res.json({ ...store.buckets(range), count: store.length });
    }
    const { from, to, limit } = parseRange(req);
    res.json({ samples: store.getRange(from, to, limit), count: store.length });
  });

  // Quedas e disponibilidade (ADR 0006): ?days=1..90 (padrão 30).
  app.get('/api/outages', (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const toMs = Date.now();
    const fromMs = toMs - days * 24 * HOUR_MS;
    const since = typeof store.firstMs === 'function' ? store.firstMs() : null;
    res.json({
      days,
      outages: outages.list({ fromMs, toMs }),
      uptime: outages.uptime({ fromMs, toMs, sinceMs: since ?? toMs }),
    });
  });

  app.get('/api/alerts', (req, res) => {
    res.json({
      active: alertsStore.active,
      all: alertsStore.list({
        status: req.query.status || undefined,
        level: req.query.level || undefined,
        limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500),
      }),
    });
  });

  app.post('/api/alerts/:id/ack', (req, res) => {
    const a = alertsStore.setStatus(req.params.id, 'ack');
    if (!a) return res.status(404).json({ error: 'alerta não encontrado' });
    broadcastAlerts();
    res.json({ ok: true, alert: a });
  });

  app.post('/api/alerts/:id/resolve', (req, res) => {
    const a = alertsStore.setStatus(req.params.id, 'resolved');
    if (!a) return res.status(404).json({ error: 'alerta não encontrado' });
    broadcastAlerts();
    res.json({ ok: true, alert: a });
  });

  app.get('/api/annotations', (req, res) => {
    res.json({ annotations: annotationsStore.data.slice(-500).reverse() });
  });

  app.post('/api/annotations', (req, res) => {
    const { ts, text, label } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'texto obrigatório' });
    const validTs = !ts || !Number.isNaN(Date.parse(ts)) ? ts : undefined;
    const annotation = annotationsStore.add({ ts: validTs, text, label });
    broadcast('annotations', { annotations: annotationsStore.data.slice(-500).reverse() });
    res.json({ ok: true, annotation });
  });

  app.delete('/api/annotations/:id', (req, res) => {
    const ok = annotationsStore.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'anotação não encontrada' });
    broadcast('annotations', { annotations: annotationsStore.data.slice(-500).reverse() });
    res.json({ ok: true });
  });

  app.get('/api/export', (req, res) => {
    const { from, to } = parseRange(req);
    const samples = store.getRange(from, to, 5000);
    const fmt = req.query.format === 'json' ? 'json' : 'csv';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const hostName = String((store.getLatest() && store.getLatest().host) || SSH_HOST)
      .replace(/[^A-Za-z0-9._-]/g, '_');
    if (fmt === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${hostName}-${stamp}.json"`);
      return res.send(JSON.stringify({ exportedAt: new Date().toISOString(), count: samples.length, samples }));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${hostName}-${stamp}.csv"`);
    res.send(toCSV(samples));
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify(statusPayload())}\n\n`);
    res.write(`event: annotations\ndata: ${JSON.stringify({ annotations: annotationsStore.data.slice(-500).reverse() })}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 30000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  app.post('/api/poll', (req, res) => {
    if (state.polling) return res.status(409).json({ error: 'coleta em andamento' });
    if (Date.now() - state.lastManualPollAt < 5000) {
      return res.status(429).json({ error: 'aguarde alguns segundos entre coletas manuais' });
    }
    state.lastManualPollAt = Date.now();
    runPoll({ manual: true });
    res.json({ ok: true });
  });

  app.use(serveStatic(path.join(ROOT, 'public'), { maxAge: 3600 }));
  // Bibliotecas do frontend atual, servidas de node_modules por caminho fixo (saem na F5).
  const VENDOR = {
    '/vendor/chart.js': 'node_modules/chart.js/dist/chart.umd.js',
    '/vendor/zoom.js': 'node_modules/chartjs-plugin-zoom/dist/chartjs-plugin-zoom.min.js',
    '/vendor/annotation.js': 'node_modules/chartjs-plugin-annotation/dist/chartjs-plugin-annotation.min.js',
  };
  for (const [route, file] of Object.entries(VENDOR)) {
    app.get(route, (req, res) => sendFile(res, path.join(ROOT, file), { cacheControl: 'public, max-age=86400' }));
  }

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log(`ERRO não tratado: ${err.stack || err.message}`);
    else log(`requisição recusada (${status}): ${err.message}`);
    res.status(status).json({ error: status >= 500 ? 'erro interno do servidor' : 'requisição inválida' });
  });

  /** Grava tudo o que está pendente (histórico, alertas, anotações) antes de sair (B11). */
  async function shutdown() {
    for (const res of sseClients) res.end();
    sseClients.clear();
    await Promise.all([store.flush?.(), alertsStore.flush?.(), annotationsStore.flush?.(), outages.flush()]);
  }

  return { app, state, store, alertsStore, annotationsStore, outages, engine, broadcast, runPoll, parseRange, statusPayload, sseClients, shutdown };
}

export function startServer() {
  const SSH_HOST = config.SSH_HOST;
  const POLL_INTERVAL = config.POLL_INTERVAL;
  const PORT = config.PORT;
  const LOG_FILE = config.LOG_FILE;

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', mode: 0o600 });
  try { fs.chmodSync(LOG_FILE, 0o600); } catch { /* best-effort */ }
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logStream.write(`${line}\n`);
  };
  for (const w of configWarnings) log(`AVISO de configuração: ${w}`);

  const { app, runPoll, shutdown: flushAll } = createApp({ log });

  let pollTimer = null;
  const server = app.listen(PORT, '127.0.0.1', () => {
    log(`dashboard em http://127.0.0.1:${PORT} — host: ${SSH_HOST}, intervalo: ${POLL_INTERVAL}ms`);
    runPoll();
    pollTimer = setInterval(runPoll, POLL_INTERVAL);
  });

  async function shutdown() {
    log('encerrando...');
    if (pollTimer) clearInterval(pollTimer);
    setTimeout(() => process.exit(0), 5000).unref();
    server.close();
    try { await flushAll(); } catch (err) { log(`falha ao gravar no encerramento: ${err.message}`); }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isCLI = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCLI) {
  if (isPlaceholderHost(config.SSH_HOST)) {
    console.warn(`AVISO: SSH_HOST está com o valor padrão "${config.SSH_HOST}".`);
    console.warn('       Rode ./install.sh para configurar o acesso SSH ao servidor.');
  }
  startServer();
}