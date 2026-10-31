// O painel: servidor HTTP (só em 127.0.0.1), API REST, SSE em tempo real e o laço de
// coleta (1 SSH por intervalo). Rotas e formatos: AGENTS, seção "API".
//
// createApp(deps) monta tudo com dependências injetáveis (coletor, arquivos, limites): os
// testes sobem o app de verdade com dados falsos. startServer() é o painel em produção
// (`npm start`, o serviço de usuário): log em arquivo, timer da coleta e encerramento limpo.
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
import { spansToIso } from './storage/coverage.js';
import { AlertEngine } from './alerts/engine.js';
import { collect, configTargets } from './poller.js';
import { VERSION } from './version.js';
import { config, configWarnings, ROOT, isPlaceholderHost } from './config.js';
import { hostCheck, csrfCheck, securityHeaders, makeRequireAuth, issueCsrfCookie, makeRateLimit, parseCookies } from './security.js';
import { toCSV } from './csv.js';
import { createLogFile } from './logfile.js';
import { Atualizacao, procurarEmProcesso } from './atualizacao/index.js';
import { executarForaDoServico, modoDoExecutor } from './atualizacao/executor.js';
import { bloqueioDaPasta } from './atualizacao/procurar.js';

/**
 * Monta o painel: stores, motor de alertas, sessões, SSE e o roteador com todas as rotas.
 * Devolve o app (função do http.Server) e as peças que os testes e o startServer usam.
 */
export function createApp(deps = {}) {
  const SSH_HOST = deps.sshHost ?? config.SSH_HOST;
  const POLL_INTERVAL = deps.pollInterval ?? config.POLL_INTERVAL;
  const HISTORY_FILE = deps.historyFile ?? config.HISTORY_FILE;
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
  // Alertas, anotações e quedas: arquivos em data/ (os testes passam caminhos temporários).
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

  // Estado da coleta, mostrado na faixa de status e em /api/status.
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

  // Mutações da API: 120 por minuto por IP.
  const apiRateLimit = makeRateLimit({ windowMs: 60000, max: deps.rateLimitMax ?? 120 });
  // Tentativas de login: limite próprio, bem menor (força bruta no token).
  const loginRateLimit = makeRateLimit({ windowMs: 60000, max: deps.loginRateMax ?? 10 });
  const sessions = deps.sessions || new SessionStore({
    file: deps.sessionsFile ?? path.join(path.dirname(alertsStore.file), 'sessions.json'),
    log,
  });

  // Conexões SSE (uma por aba aberta), até 20.
  const sse = deps.sse || new SseHub({ maxClients: deps.sseMaxClients ?? 20 });

  /** Manda um evento para todas as telas abertas. */
  function broadcast(event, data, id) {
    sse.send(event, data, id);
  }

  // Versão nova (ADR 0030 e 0031). Quem procura e troca de verdade é o startServer: sem
  // `procurarVersao` e `executarAtualizacao`, os testes e o painel de teste nunca saem daqui.
  const atualizacao = deps.atualizacao || new Atualizacao({
    file: deps.atualizacaoFile ?? path.join(path.dirname(alertsStore.file), 'atualizacao.json'),
    instalada: `v${VERSION.app}`,
    loginExigido: Boolean(DASH_TOKEN),
    procurar: deps.procurarVersao ?? (async () => ({})),
    root: deps.pastaAtualizacao ?? ROOT,
    modo: deps.modoAtualizacao ?? null,
    executar: deps.executarAtualizacao ?? null,
    conferirPasta: deps.conferirPasta,
    procDir: deps.procDirAtualizacao,
    onChange: (estado) => broadcast('atualizacao', estado),
    log,
  });

  /** Alertas abertos + os 50 mais recentes, para as telas. */
  function broadcastAlerts() {
    broadcast('alerts', { alerts: alertsStore.active, all: alertsStore.list({ limit: 50 }) });
  }

  /**
   * Uma coleta. Nunca duas ao mesmo tempo (I1): se uma está em andamento, a nova chamada
   * não faz nada. Sucesso: guarda a amostra, reavalia os alertas e avisa as telas. Falha:
   * conta para o "servidor inacessível" (recordFailure).
   */
  async function runPoll() {
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

  /** O que /api/status, o "hello" do SSE e o evento "status" mandam: meta + amostra + saúde. */
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
  // Maior intervalo aceito em formato=baldes: os 90 dias dos agregados (+1 de folga).
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

  /** from/to (ISO, opcionais) e limit (padrão 720, de 1 a 2000) das amostras brutas. */
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
  // Limite de taxa só nas mutações da API (GET não muda nada e as telas fazem vários).
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

  // Daqui para baixo, toda rota de /api exige sessão ou Bearer (quando há DASH_TOKEN).
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
    // Formato das telas: baldes com mín/máx/média (até 90 dias). Sem ele: amostras reduzidas.
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

  // Versão nova (ADR 0030): só o estado.
  app.get('/api/atualizacao', (req, res) => {
    res.json(atualizacao.estado());
  });

  // "Procurar agora" espera a procura terminar: no máximo 1 por minuto (ela sai para a internet).
  app.post('/api/atualizacao/verificar', async (req, res) => {
    const procura = atualizacao.verificarAgora();
    if (!procura) return res.status(429).json({ error: 'aguarde 1 minuto entre as procuras' });
    res.json(await procura);
  });

  // O botão Atualizar (ADR 0031, I11): só a versão detectada; o texto do pedido não vira comando.
  app.post('/api/atualizacao/iniciar', async (req, res) => {
    const { status, corpo } = await atualizacao.trocarVersao(req.body?.versao);
    res.status(status).json(corpo);
  });

  // Tela de progresso: o pedaço do log depois de `desde` e o estado (lido a cada 1 s).
  app.get('/api/atualizacao/registro', (req, res) => {
    res.json(atualizacao.registro(Math.max(parseInt(req.query.desde, 10) || 0, 0)));
  });

  // Quedas e disponibilidade (ADR 0006 e 0018): ?days=1..90 (padrão 30).
  app.get('/api/outages', (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const toMs = Date.now();
    const fromMs = toMs - days * 24 * HOUR_MS;
    // Tempo medido (ADR 0018): faixas com amostra + quedas. A disponibilidade conta só ele.
    // Um store injetado sem monitored() (testes antigos) mede só pelas quedas.
    const quedas = outages.spans({ fromMs, toMs });
    const monitored = typeof store.monitored === 'function' ? store.monitored(fromMs, toMs, quedas) : quedas;
    res.json({
      days,
      outages: outages.list({ fromMs, toMs }),
      monitored: spansToIso(monitored),
      uptime: outages.uptime({ fromMs, toMs, monitored }),
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
    // Instante em ISO canônico; o que não é data (ou não é texto) vira "agora" no store.
    const quando = typeof ts === 'string' ? Date.parse(ts) : NaN;
    const validTs = Number.isNaN(quando) ? undefined : new Date(quando).toISOString();
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
    // Até 5000 amostras; o nome do arquivo usa só letras, números, ".", "_" e "-" (sem
    // aspas nem quebra de linha no cabeçalho Content-Disposition).
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
    initial.push(['atualizacao', atualizacao.estado()]);
    sse.open(req, res, initial);
  });

  app.post('/api/poll', (req, res) => {
    // "Coletar agora": nunca durante outra coleta e no máximo 1 a cada 5 s (o servidor é
    // modesto; I1).
    if (state.polling) return res.status(409).json({ error: 'coleta em andamento' });
    if (Date.now() - state.lastManualPollAt < 5000) {
      return res.status(429).json({ error: 'aguarde alguns segundos entre coletas manuais' });
    }
    state.lastManualPollAt = Date.now();
    runPoll();
    res.json({ ok: true });
  });

  // Arquivos da tela (public/), depois de todas as rotas da API.
  app.use(serveStatic(path.join(ROOT, 'public')));

  // Tratador de erro central: o detalhe vai para o log; a resposta é genérica, sem stack
  // nem caminho (SECURITY, ameaça 16).
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log(`ERRO não tratado: ${err.stack || err.message}`);
    else log(`requisição recusada (${status}): ${err.message}`);
    res.status(status).json({ error: status >= 500 ? 'erro interno do servidor' : 'requisição inválida' });
  });

  /** Grava tudo o que está pendente (histórico, alertas, anotações) antes de sair (B11). */
  async function shutdown() {
    sse.closeAll();
    await Promise.all([store.flush?.(), alertsStore.flush?.(), annotationsStore.flush?.(), outages.flush(), sessions.flush(), atualizacao.flush()]);
  }

  return { app, state, store, alertsStore, annotationsStore, outages, engine, sessions, atualizacao, broadcast, runPoll, parseRange, statusPayload, sse, shutdown };
}

/** O painel em produção: log em arquivo, escuta em 127.0.0.1, coleta a cada intervalo. */
function startServer() {
  const SSH_HOST = config.SSH_HOST;
  const POLL_INTERVAL = config.POLL_INTERVAL;
  const PORT = config.PORT;
  const LOG_FILE = config.LOG_FILE;

  // Log no terminal (journal do systemd) e em data/dashboard.log, com rotação.
  const logFile = createLogFile(LOG_FILE);
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logFile.write(line);
  };
  for (const w of configWarnings) log(`AVISO de configuração: ${w}`);

  const modo = modoDoExecutor();
  const { app, runPoll, atualizacao, shutdown: flushAll } = createApp({
    log,
    procurarVersao: procurarEmProcesso,
    modoAtualizacao: modo,
    executarAtualizacao: () => executarForaDoServico({ root: ROOT, modo }),
    conferirPasta: () => bloqueioDaPasta(ROOT),
  });

  // 1ª coleta assim que o servidor sobe; depois, uma por intervalo.
  let pollTimer = null;
  const server = app.listen(PORT, '127.0.0.1', () => {
    log(`dashboard em http://127.0.0.1:${PORT} — host: ${SSH_HOST}, intervalo: ${POLL_INTERVAL}ms`);
    runPoll();
    pollTimer = setInterval(runPoll, POLL_INTERVAL);
    atualizacao.iniciar();
  });

  /** SIGINT/SIGTERM: para a coleta, grava o pendente (B11) e sai; no máximo 5 s. */
  async function shutdown() {
    log('encerrando...');
    if (pollTimer) clearInterval(pollTimer);
    atualizacao.parar();
    setTimeout(() => process.exit(0), 5000).unref();
    server.close();
    try { await flushAll(); } catch (err) { log(`falha ao gravar no encerramento: ${err.message}`); }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Rodando direto (`node server/index.js`, `npm start`, o serviço)? Compara só o nome do
// arquivo: funciona também com a pasta atrás de um link simbólico.
const isCLI = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isCLI) {
  if (isPlaceholderHost(config.SSH_HOST)) {
    console.warn(`AVISO: SSH_HOST está com o valor padrão "${config.SSH_HOST}".`);
    console.warn('       Rode ./dashboard instalar para configurar o acesso ao servidor.');
  }
  startServer();
}