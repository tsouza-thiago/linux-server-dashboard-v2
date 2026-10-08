// Assistente no navegador (D10, passo 2 da seção 11): servidor temporário em 127.0.0.1,
// na porta do painel, que só existe até o fim da 1ª configuração. Entrar exige o código de
// uso único mostrado no terminal (trocado por um cookie HttpOnly + SameSite=Strict); valem
// as mesmas proteções do painel: Host check, CSRF, CSP sem 'unsafe-inline', limite de
// tentativas e erros sem detalhes internos.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, jsonBody } from '../http/router.js';
import { serveStatic, sendFile } from '../http/static.js';
import { safeEqual } from '../http/session.js';
import { hostCheck, csrfCheck, securityHeaders, issueCsrfCookie, makeRateLimit, parseCookies } from '../security.js';
import { InstallError, STEPS } from './instalacao.js';
import { createLoginCode } from '../http/entrar.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
export const SETUP_COOKIE = 'dash_setup';
export const CODE_TTL_MS = 30 * 60 * 1000;
const MAX_FAILURES = 20;
// Sem letras/números que se confundem (0/O, 1/I/L, 2/Z, 5/S, 8/B).
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';

/** Código de uso único para o terminal: 6 caracteres, mostrado como "7KQ-4MZ". */
export function makeSetupCode() {
  const bytes = crypto.randomBytes(6);
  const raw = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return { raw, shown: `${raw.slice(0, 3)}-${raw.slice(3)}` };
}

export const normalizeCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * @param {object} p
 * @param {import('./instalacao.js').Instalacao} p.inst os 6 passos
 * @param {string} p.code código de uso único (sem o hífen)
 * @param {Function} [p.onFinish] chamado depois que a resposta do "Abrir o painel" saiu
 * @param {Function} [p.onActivity] a cada requisição (para o tempo de inatividade)
 */
export function createWizardApp({ inst, code, onFinish = () => {}, onActivity = () => {}, log = () => {}, now = () => Date.now(), codeTtlMs = CODE_TTL_MS }) {
  const createdAt = now();
  let pendingCode = normalizeCode(code);
  let failures = 0;
  let sessionHash = null;
  const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

  const app = createRouter();
  app.use(securityHeaders);
  app.use(hostCheck);
  app.use(csrfCheck);
  app.use(issueCsrfCookie);
  app.use((req, res, next) => { onActivity(); next(); });
  app.use(jsonBody({ limit: 16 * 1024 }));
  const writes = makeRateLimit({ windowMs: 60000, max: 120 });
  app.use('/api', (req, res, next) => (req.method === 'POST' ? writes(req, res, next) : next()));

  app.get('/', (req, res) => {
    res.statusCode = 302;
    res.setHeader('Location', '/configurar');
    res.end();
  });
  app.get('/configurar', (req, res) => sendFile(res, path.join(PUBLIC, 'configurar.html')));

  const loginLimit = makeRateLimit({ windowMs: 60000, max: 10 });
  app.post('/api/configurar/entrar', loginLimit, (req, res) => {
    const given = normalizeCode(req.body && req.body.codigo);
    if (!pendingCode || failures >= MAX_FAILURES || now() - createdAt > codeTtlMs) {
      return res.status(410).json({ error: 'Este código não vale mais. Rode ./dashboard instalar de novo no terminal.' });
    }
    if (given.length !== pendingCode.length || !safeEqual(given, pendingCode)) {
      failures += 1;
      log('assistente: código de uso único incorreto');
      return res.status(401).json({ error: 'Código incorreto. Confira o que aparece no terminal.' });
    }
    pendingCode = null; // uso único: o mesmo código não entra de novo
    const sid = crypto.randomBytes(32).toString('base64url');
    sessionHash = hash(sid);
    res.appendHeader('Set-Cookie', `${SETUP_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict`);
    res.json({ ok: true });
  });

  app.use('/api/configurar', (req, res, next) => {
    const sid = parseCookies(req.headers.cookie)[SETUP_COOKIE];
    if (sessionHash && sid && safeEqual(hash(sid), sessionHash)) return next();
    return res.status(401).json({ error: 'Digite o código que aparece no terminal.', codigo: true });
  });

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req.body || {}, req));
    } catch (err) {
      if (err instanceof InstallError) return res.status(err.status).json({ error: err.message, field: err.field });
      log(`assistente: erro inesperado: ${err.stack || err.message}`);
      return res.status(500).json({ error: 'Algo deu errado aqui. Veja o terminal.' });
    }
  };

  app.get('/api/configurar/estado', handle(() => ({
    passos: STEPS,
    computador: inst.verificarComputador(),
    servidor: inst.servidor,
    identidade: inst.identidade ? { type: inst.identidade.type, fingerprint: inst.identidade.fingerprint } : null,
    conectado: Boolean(inst.deteccao),
    preparo: { concluido: inst.preparo.concluido, modo: inst.preparo.modo },
    teste: inst.resumoTeste(),
  })));
  app.post('/api/configurar/servidor', handle((b) => inst.definirServidor({ host: b.host, user: b.user, port: b.port })));
  app.post('/api/configurar/identidade', handle(() => inst.lerIdentidade()));
  app.post('/api/configurar/conectar', handle((b) => inst.conectar({ senha: b.senha ?? '', confirmo: b.confirmo === true })));
  app.get('/api/configurar/deteccao', handle(() => inst.resumoDeteccao()));
  app.post('/api/configurar/escolhas', handle((b) => inst.definirEscolhas(b)));
  app.post('/api/configurar/plano', handle((b) => inst.planoPreparo({ from: b.from !== false })));
  app.post('/api/configurar/preparar', handle((b) => inst.prepararAssistido({ senha: b.senha })));
  app.post('/api/configurar/testar', handle((b) => inst.testarBloco(String(b.bloco || ''))));
  app.post('/api/configurar/token', handle(() => ({ token: inst.tokenReserva() })));

  app.post('/api/configurar/concluir', async (req, res) => {
    try {
      const prefs = inst.concluir({ iniciarComComputador: req.body?.iniciarComComputador !== false, atalho: req.body?.atalho !== false });
      // Link de entrada criado antes de fechar: o painel o aceita assim que subir.
      const codigo = createLoginCode(path.join(inst.root, 'data'), { ttlMs: 10 * 60 * 1000 });
      res.on('finish', () => onFinish(prefs));
      res.json({ ok: true, url: `/entrar?codigo=${codigo}` });
    } catch (err) {
      if (err instanceof InstallError) return res.status(err.status).json({ error: err.message });
      log(`assistente: erro ao concluir: ${err.stack || err.message}`);
      return res.status(500).json({ error: 'Não consegui concluir. Veja o terminal.' });
    }
  });

  app.use(serveStatic(PUBLIC, { maxAge: 0 }));
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log(`assistente: erro: ${err.message}`);
    res.status(status).json({ error: status >= 500 ? 'erro interno' : 'requisição inválida' });
  });
  return app;
}
