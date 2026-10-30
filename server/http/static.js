// Arquivos estáticos (ADR 0003): só a pasta indicada, só os tipos da lista, nada de
// arquivo oculto, pasta ou caminho que escape da raiz (path traversal).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Tipos servidos; arquivo de outra extensão (.md, .map, sem extensão) nunca sai.
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
// cabe no orçamento de 450 KB (AGENTS). As fontes .woff2 e as imagens já vêm comprimidas. Os
// arquivos são do próprio pacote, sem segredo nem dado do usuário (nada de BREACH).
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;
const MIN_GZIP_BYTES = 1024;
const gzipCache = new Map();

/**
 * Conteúdo em gzip, guardado em memória por arquivo (a chave muda se o arquivo mudar de
 * tamanho ou data, e a versão anterior sai do cache).
 */
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

// Validação do cache (#44): o ETag sai do tamanho e da data do arquivo, como nos
// servidores comuns. O `./dashboard atualizar` regrava os arquivos, e o ETag muda. É fraco
// (W/) porque a mesma versão sai em gzip ou não; a comparação do If-None-Match é fraca.
const etagOf = (stat) => `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
const opaque = (tag) => tag.trim().replace(/^W\//, '');

/** O navegador já tem esta versão? (If-None-Match: "*" ou uma lista de ETags, RFC 9110). */
function notModified(req, etag) {
  const header = String(req?.headers?.['if-none-match'] || '').trim();
  if (!header) return false;
  return header === '*' || header.split(',').some((tag) => opaque(tag) === opaque(etag));
}

/**
 * Envia um arquivo conhecido (tipo pela extensão, que precisa estar na lista). Sempre com
 * `no-cache` + ETag (#44): o navegador guarda o arquivo, mas confere a cada uso; sem
 * mudança, a resposta é um 304 sem corpo. Antes, o JS ficava 1 h em cache sem conferir, e
 * a tela misturava o HTML novo com o JS antigo depois de atualizar.
 */
export function sendFile(res, file, { req = null } = {}) {
  const type = MIME[path.extname(file).toLowerCase()];
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!type || !stat || !stat.isFile()) return res.status(404).json({ error: 'não encontrado' });
  const etag = etagOf(stat);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
  if (COMPRESSIBLE.test(type)) res.setHeader('Vary', 'Accept-Encoding');
  if (notModified(req, etag)) {
    res.statusCode = 304;
    res.end();
    return res;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  // gzip só para texto, acima de 1 KB e quando o navegador aceita; o resto sai como está.
  const acceptsGzip = /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] || ''));
  if (acceptsGzip && COMPRESSIBLE.test(type) && stat.size >= MIN_GZIP_BYTES) {
    let body;
    try { body = gzipped(file, stat); } catch { res.removeHeader('ETag'); return res.status(404).json({ error: 'não encontrado' }); }
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
export function serveStatic(root) {
  const base = path.resolve(root);
  return function staticFiles(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try {
      rel = decodeURIComponent(req.path);
    } catch {
      return res.status(400).json({ error: 'caminho inválido' });
    }
    // Byte nulo e barra invertida nunca são legítimos num caminho do painel (CWE-22).
    if (rel.includes('\0') || rel.includes('\\')) return res.status(400).json({ error: 'caminho inválido' });
    if (rel === '/' || rel === '') rel = '/index.html';
    // Proteção em 2 camadas contra path traversal (CWE-22): nenhum trecho pode começar com
    // "." (tira `..`, `.env`, `.git`), e o caminho final precisa ficar dentro da raiz.
    const segments = rel.split('/').filter(Boolean);
    if (segments.some((seg) => seg.startsWith('.'))) return res.status(404).json({ error: 'não encontrado' });
    const file = path.resolve(base, ...segments);
    if (file !== base && !file.startsWith(base + path.sep)) return res.status(404).json({ error: 'não encontrado' });
    if (!MIME[path.extname(file).toLowerCase()]) return next();
    let stat;
    try { stat = fs.statSync(file); } catch { return next(); }
    if (!stat.isFile()) return next();
    return sendFile(res, file, { req });
  };
}
