import path from 'node:path';
import { createRouter, jsonBody } from './http/router.js';
import { serveStatic } from './http/static.js';
import { SseHub, lastEventId, sampleId, MAX_BACKFILL } from './http/sse.js';
import { SessionStore, SESSION_COOKIE, sessionCookie, clearSessionCookie, safeEqual } from './http/session.js';
import { consumeLoginCode } from './http/entrar.js';
import { History, RAW_RETENTION_MS, ROLLUP_DAYS } from './storage/index.js';
import { migrateV1 } from './storage/migrate-v1.js';
import { AlertsStore, AnnotationsStore } from './stores.js';
import { OutageLog } from './storage/outages.js';
import { AlertEngine } from './alerts/engine.js';
import { collect, configTargets } from './poller.js';
import { VERSION } from './version.js';
import { config, configWarnings, ROOT, isPlaceholderHost } from './config.js';
import { hostCheck, csrfCheck, securityHeaders, makeRequireAuth, issueCsrfCookie, makeRateLimit, parseCookies } from './security.js';
import { toCSV } from './csv.js';
import { createLogFile } from './logfile.js';

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
  // Tentativas de login: limite próprio, bem menor (força bruta no token).
  const loginRateLimit = makeRateLimit({ windowMs: 60000, max: deps.loginRateMax ?? 10 });
  const sessions = deps.sessions || new SessionStore({
    file: deps.sessionsFile ?? path.join(path.dirname(alertsStore.file), 'sessions.json'),
    log,
  });

  const sse = deps.sse || new SseHub({ maxClients: deps.sseMaxClients ?? 20 });

  function broadcast(event, data, id) {
    sse.send(event, data, id);
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
        broadcast('sample', { sample: res.sample, alerts: alertsStore.active, health: engine.health(res.sample) }, sampleId(res.sample));
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

  // ---- Sessão (ADR 0007): estas rotas ficam antes da exigência de autenticação ----
  app.get('/api/session', (req, res) => {
    const sid = DASH_TOKEN ? parseCookies(req.headers.cookie)[SESSION_COOKIE] : null;
    const s = sid ? sessions.touch(sid) : null;
    res.json({
      authRequired: Boolean(DASH_TOKEN),
      authenticated: !DASH_TOKEN || Boolean(s),
      expiresAt: s ? new Date(s.expiresAt).toISOString() : null,
    });
  });

  app.post('/api/login', loginRateLimit, (req, res) => {
    if (!DASH_TOKEN) return res.json({ ok: true, authRequired: false });
    const token = req.body && req.body.token;
    if (typeof token !== 'string' || !safeEqual(token.trim(), DASH_TOKEN)) {
      log('login recusado: token incorreto');
      return res.status(401).json({ error: 'Token incorreto' });
    }
    const id = sessions.create();
    // "Manter conectado por 30 dias" desmarcado: cookie some ao fechar o navegador.
    res.appendHeader('Set-Cookie', sessionCookie(id, req.body.remember === false ? null : undefined));
    log(`login OK (${sessions.count} sessão(ões) ativa(s))`);
    res.json({ ok: true });
  });

  // Link de uso único de `dashboard abrir` e do fim da instalação: entra sem digitar o token.
  app.get('/entrar', loginRateLimit, (req, res) => {
    if (DASH_TOKEN && consumeLoginCode(DATA_DIR, req.query.codigo)) {
      res.appendHeader('Set-Cookie', sessionCookie(sessions.create()));
      log(`login OK pelo link de uso único (${sessions.count} sessão(ões) ativa(s))`);
    } else if (DASH_TOKEN) {
      log('link de entrada recusado: código inválido, usado ou vencido');
    }
    res.statusCode = 302;
    res.setHeader('Location', '/');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  });

  app.post('/api/logout', (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) sessions.revoke(sid);
    res.appendHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
  });

  app.use('/api', makeRequireAuth(DASH_TOKEN, sessions));

  app.post('/api/logout-all', (req, res) => {
    const revoked = sessions.revokeAll();
    res.appendHeader('Set-Cookie', clearSessionCookie());
    log(`todas as sessões encerradas (${revoked})`);
    res.json({ ok: true, revoked });
  });

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

  // Configuração ativa para a Ajuda: só leitura e sem segredos (nada de DASH_TOKEN).
  app.get('/api/config', (req, res) => {
    const latest = store.getLatest();
    res.json({
      version: VERSION,
      sshHost: SSH_HOST,
      sshAccess: deps.sshAccess ?? config.SSH_ACESSO,
      pollIntervalMs: POLL_INTERVAL,
      targets: deps.targets ?? configTargets(),
      thresholds,
      historyLimit: store.limit,
      retention: { rawHours: RAW_RETENTION_MS / HOUR_MS, rollupDays: ROLLUP_DAYS },
      runtime: { node: process.versions.node },
      collector: latest?.collector ?? null,
    });
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
    const initial = [];
    // Reconexão: reenvia as amostras perdidas (depois do último id que o navegador viu).
    const since = lastEventId(req);
    if (since !== null) {
      const missed = (store.samples || []).filter((s) => sampleId(s) > since).slice(-MAX_BACKFILL);
      for (const sample of missed) initial.push(['sample', { sample, alerts: alertsStore.active, backfill: true }, sampleId(sample)]);
    }
    // O hello leva o id da amostra mais recente: assim até uma tela que ainda não recebeu
    // nenhuma amostra ao vivo sabe de onde retomar se a conexão cair.
    const payload = statusPayload();
    initial.push(['hello', payload, sampleId(payload.sample)]);
    initial.push(['annotations', { annotations: annotationsStore.data.slice(-500).reverse() }]);
    sse.open(req, res, initial);
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

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log(`ERRO não tratado: ${err.stack || err.message}`);
    else log(`requisição recusada (${status}): ${err.message}`);
    res.status(status).json({ error: status >= 500 ? 'erro interno do servidor' : 'requisição inválida' });
  });

  /** Grava tudo o que está pendente (histórico, alertas, anotações) antes de sair (B11). */
  async function shutdown() {
    sse.closeAll();
    await Promise.all([store.flush?.(), alertsStore.flush?.(), annotationsStore.flush?.(), outages.flush(), sessions.flush()]);
  }

  return { app, state, store, alertsStore, annotationsStore, outages, engine, sessions, broadcast, runPoll, parseRange, statusPayload, sse, shutdown };
}

export function startServer() {
  const SSH_HOST = config.SSH_HOST;
  const POLL_INTERVAL = config.POLL_INTERVAL;
  const PORT = config.PORT;
  const LOG_FILE = config.LOG_FILE;

  const logFile = createLogFile(LOG_FILE);
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logFile.write(line);
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
    console.warn('       Rode ./dashboard instalar para configurar o acesso ao servidor.');
  }
  startServer();
}