// Arquivos estáticos (ADR 0003): só a pasta indicada, só os tipos da lista, nada de
// arquivo oculto, pasta ou caminho que escape da raiz (path traversal).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Texto (HTML, CSS, JS, JSON, SVG) vai em gzip quando o navegador aceita: a página inicial
// cabe no orçamento de 300 KB (Q17). As fontes .woff2 e as imagens já vêm comprimidas. Os
// arquivos são do próprio pacote, sem segredo nem dado do usuário (nada de BREACH).
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;
const MIN_GZIP_BYTES = 1024;
const gzipCache = new Map();

function gzipped(file, stat) {
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  let buf = gzipCache.get(key);
  if (!buf) {
    buf = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
    for (const k of gzipCache.keys()) if (k.startsWith(`${file}:`)) gzipCache.delete(k);
    gzipCache.set(key, buf);
  }
  return buf;
}

/** Envia um arquivo conhecido (tipo pela extensão, que precisa estar na lista). */
export function sendFile(res, file, { cacheControl = 'no-cache', req = null } = {}) {
  const type = MIME[path.extname(file).toLowerCase()];
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!type || !stat || !stat.isFile()) return res.status(404).json({ error: 'não encontrado' });
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cacheControl);
  if (COMPRESSIBLE.test(type)) res.setHeader('Vary', 'Accept-Encoding');
  const acceptsGzip = /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
  if (acceptsGzip && COMPRESSIBLE.test(type) && stat.size >= MIN_GZIP_BYTES) {
    let body;
    try { body = gzipped(file, stat); } catch { return res.status(404).json({ error: 'não encontrado' }); }
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.end(req.method === 'HEAD' ? undefined : body);
    return res;
  }
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return res;
}

/**
 * Middleware de estáticos para GET/HEAD. Devolve `next()` para caminhos que não são
 * arquivos da lista (a rota seguinte decide: normalmente 404).
 */
export function serveStatic(root, { maxAge = 3600 } = {}) {
  const base = path.resolve(root);
  return function staticFiles(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try {
      rel = decodeURIComponent(req.path);
    } catch {
      return res.status(400).json({ error: 'caminho inválido' });
    }
    if (rel.includes('\0') || rel.includes('\\')) return res.status(400).json({ error: 'caminho inválido' });
    if (rel === '/' || rel === '') rel = '/index.html';
    const segments = rel.split('/').filter(Boolean);
    if (segments.some((seg) => seg.startsWith('.'))) return res.status(404).json({ error: 'não encontrado' });
    const file = path.resolve(base, ...segments);
    if (file !== base && !file.startsWith(base + path.sep)) return res.status(404).json({ error: 'não encontrado' });
    if (!MIME[path.extname(file).toLowerCase()]) return next();
    let stat;
    try { stat = fs.statSync(file); } catch { return next(); }
    if (!stat.isFile()) return next();
    const cacheControl = file.endsWith('.html') ? 'no-cache' : `public, max-age=${maxAge}`;
    return sendFile(res, file, { cacheControl, req });
  };
}
