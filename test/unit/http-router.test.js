import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRouter, jsonBody } from '../../server/http/router.js';
import { serveStatic, sendFile } from '../../server/http/static.js';
import { listen, close, request } from '../../test-support/request.js';

async function serve(t, build) {
  const app = createRouter();
  build(app);
  const { server, port } = await listen(app);
  t.after(() => close(server));
  return port;
}

test('rotas: método, parâmetros decodificados, query com 1ª ocorrência e 404 JSON', async (t) => {
  const port = await serve(t, (app) => {
    app.get('/api/x/:id/y', (req, res) => res.json({ id: req.params.id, q: req.query, path: req.path }));
    app.post('/api/x', (req, res) => res.status(201).json({ ok: true }));
  });
  const r = await request(port, { path: '/api/x/a%20b/y?limit=1&limit=2&z=' });
  assert.deepEqual(r.json, { id: 'a b', q: { limit: '1', z: '' }, path: '/api/x/a%20b/y' });
  assert.match(r.headers['content-type'], /application\/json; charset=utf-8/);
  assert.equal((await request(port, { method: 'POST', path: '/api/x' })).status, 201);
  const miss = await request(port, { method: 'DELETE', path: '/api/x' });
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.json, { error: 'não encontrado' });
  assert.equal((await request(port, { path: '/api/x/%E0%A4%A/y' })).json.id, '%E0%A4%A', 'parâmetro mal codificado fica cru');
});

test('HEAD segue a rota GET sem corpo; use() por prefixo e middlewares em ordem', async (t) => {
  const seen = [];
  const port = await serve(t, (app) => {
    app.use((req, res, next) => { seen.push('global'); next(); });
    app.use('/api', (req, res, next) => { seen.push('api'); next(); });
    app.get('/api/ping', (req, res) => res.json({ pong: true }));
    app.get('/apix', (req, res) => res.send('não é /api'));
  });
  const head = await request(port, { method: 'HEAD', path: '/api/ping' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  await request(port, { path: '/apix' });
  assert.deepEqual(seen, ['global', 'api', 'global'], '/apix não casa com o prefixo /api');
});

test('erros: exceção síncrona, promessa rejeitada e tratador de erro (4 argumentos)', async (t) => {
  const port = await serve(t, (app) => {
    app.get('/sync', () => { throw Object.assign(new Error('falhou'), { status: 418 }); });
    app.get('/async', async () => { throw new Error('assíncrono'); });
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  });
  assert.deepEqual((await request(port, { path: '/sync' })).json, { error: 'falhou' });
  const a = await request(port, { path: '/async' });
  assert.equal(a.status, 500);
  assert.equal(a.json.error, 'assíncrono');
  const bare = createRouter({ onError: (err, req, res) => res.status(599).json({ e: 1 }) });
  bare.get('/x', () => { throw new Error('y'); });
  const { server, port: p2 } = await listen(bare);
  t.after(() => close(server));
  assert.equal((await request(p2, { path: '/x' })).status, 599);
  const plain = createRouter();
  plain.get('/x', () => { throw new Error('y'); });
  const s3 = await listen(plain);
  t.after(() => close(s3.server));
  const r3 = await request(s3.port, { path: '/x' });
  assert.equal(r3.status, 500);
  assert.equal(r3.json.error, 'erro interno do servidor');
});

test('jsonBody: limite (declarado e em streaming), JSON inválido, tipo diferente e __proto__', async (t) => {
  const errors = [];
  const port = await serve(t, (app) => {
    app.use(jsonBody({ limit: 100 }));
    app.post('/b', (req, res) => res.json({ body: req.body, proto: Object.getPrototypeOf(req.body) === Object.prototype, polluted: ({}).hacked === true }));
    app.use((err, req, res, next) => { errors.push(err.status); res.status(err.status).json({ error: err.message }); });
  });
  const post = (body, headers = { 'Content-Type': 'application/json' }) => request(port, { method: 'POST', path: '/b', headers, body });
  assert.deepEqual((await post({ a: 1 })).json.body, { a: 1 });
  assert.equal((await post('x'.repeat(200))).status, 413, 'Content-Length acima do limite');
  assert.equal((await post('{nao')).status, 400);
  assert.deepEqual((await post('')).json.body, {});
  assert.deepEqual((await post('a=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).json.body, {}, 'só JSON é lido');
  const evil = await post('{"__proto__":{"hacked":true},"constructor":{"x":1},"ok":2}');
  assert.deepEqual(evil.json.body, { ok: 2 });
  assert.equal(evil.json.polluted, false);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/b', headers: { Host: 'localhost', 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    for (let i = 0; i < 10; i++) req.write('"xxxxxxxxxxxxxxxxxxxx"');
    req.end();
  });
  assert.equal(chunked, 413, 'limite vale também sem Content-Length');
  assert.deepEqual(errors, [413, 400, 413]);
});

test('serveStatic: index, tipos, cache, oculto, traversal, pasta, tipo fora da lista', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-static-'));
  fs.mkdirSync(path.join(root, 'js'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>oi</h1>');
  fs.writeFileSync(path.join(root, 'js', 'a.js'), 'x=1');
  fs.writeFileSync(path.join(root, '.env'), 'SEGREDO=1');
  fs.writeFileSync(path.join(root, 'notas.md'), '# não servir');
  fs.writeFileSync(path.join(root, '..', 'fora-lsd.txt'), 'fora');
  const port = await serve(t, (app) => {
    app.use(serveStatic(root, { maxAge: 60 }));
    app.get('/js/a.js/extra', (req, res) => res.send('rota depois'));
  });
  const idx = await request(port, { path: '/' });
  assert.equal(idx.text, '<h1>oi</h1>');
  assert.equal(idx.headers['cache-control'], 'no-cache');
  const js = await request(port, { path: '/js/a.js' });
  assert.match(js.headers['content-type'], /text\/javascript/);
  assert.equal(js.headers['cache-control'], 'public, max-age=60');
  for (const p of ['/.env', '/js/', '/notas.md', '/nada.js', '/js/a.js/extra']) {
    const r = await request(port, { path: p });
    assert.ok(!r.text.includes('SEGREDO') && !r.text.includes('não servir'), p);
  }
  assert.equal((await request(port, { path: '/.env' })).status, 404);
  assert.equal((await request(port, { path: '/js' })).status, 404, 'pasta não é listada');
  assert.equal((await request(port, { path: '/%E0%A4%A' })).status, 400);
  assert.equal((await request(port, { path: '/a%00.js' })).status, 400);
  assert.equal((await request(port, { path: '/js%5c..%5c..%5cfora-lsd.txt' })).status, 400, 'barra invertida recusada');
  assert.equal((await request(port, { method: 'POST', path: '/js/a.js' })).status, 404, 'só GET/HEAD');
  fs.rmSync(path.join(root, '..', 'fora-lsd.txt'), { force: true });
});

test('sendFile: arquivo inexistente ou de tipo fora da lista vira 404', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-send-'));
  fs.writeFileSync(path.join(dir, 'x.exe'), 'MZ');
  const port = await serve(t, (app) => {
    app.get('/exe', (req, res) => sendFile(res, path.join(dir, 'x.exe')));
    app.get('/nada', (req, res) => sendFile(res, path.join(dir, 'nada.js')));
  });
  assert.equal((await request(port, { path: '/exe' })).status, 404);
  assert.equal((await request(port, { path: '/nada' })).status, 404);
});
