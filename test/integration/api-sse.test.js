// Tempo real (SSE): id por amostra, recuperação com Last-Event-ID e limite de conexões.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { listen, close, request, readSSE } from '../../test-support/request.js';
import { esperarAte } from '../../test-support/esperar.js';
import { formatEvent, lastEventId, sampleId, SseHub } from '../../server/http/sse.js';

const BASE = Date.UTC(2026, 9, 7, 12, 0);
const at = (min) => new Date(BASE + min * 60000).toISOString();

async function start(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sse-'));
  const queue = [];
  const app = createApp({
    historyFile: path.join(dir, 'history.json'),
    alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'),
    collect: async () => queue.shift() || { ok: false, error: 'fim' },
    log: () => {},
    ...extra,
  });
  const { server, port } = await listen(app.app);
  t.after(async () => { await app.shutdown(); await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...app, port, queue };
}

const events = (data) => data.split('\n\n').filter((b) => b.includes('event: ')).map((b) => ({
  event: /event: (.*)/.exec(b)[1],
  id: /id: (.*)/.exec(b)?.[1] ?? null,
  data: JSON.parse(/data: (.*)/.exec(b)[1]),
}));

test('SSE: cada amostra ao vivo sai com id = instante dela', async (t) => {
  const s = await start(t);
  // Teto folgado: a leitura termina assim que os 5 eventos chegam, e um teto curto (3 s)
  // podia vencer antes deles com a máquina carregada (#25).
  const live = readSSE(s.port, { until: 5, timeoutMs: 15000 });
  // Só coleta depois que a conexão SSE está registrada no hub. Uma espera fixa (50 ms)
  // perdia a amostra com a máquina carregada (ex.: suíte com cobertura).
  await esperarAte(() => s.sse.size >= 1);
  assert.equal(s.sse.size, 1, 'a conexão SSE entrou no hub');
  s.queue.push({ ok: true, sample: { ts: at(0), host: 'srv', disks: [] } });
  await s.runPoll();
  const r = await live;
  const sample = events(r.data).find((e) => e.event === 'sample');
  assert.equal(sample.id, String(BASE));
  assert.equal(sample.data.sample.ts, at(0));
});

test('SSE: reconexão com Last-Event-ID recebe só as amostras perdidas, em ordem, antes do hello', async (t) => {
  const s = await start(t);
  for (let i = 0; i < 5; i++) s.store.append({ ts: at(i), host: 'srv', disks: [] });
  const r = await readSSE(s.port, { headers: { 'Last-Event-ID': String(Date.parse(at(1))) }, until: 6 });
  const ev = events(r.data);
  assert.deepEqual(ev.map((e) => e.event), ['sample', 'sample', 'sample', 'hello', 'annotations']);
  assert.deepEqual(ev.slice(0, 3).map((e) => e.data.sample.ts), [at(2), at(3), at(4)]);
  assert.ok(ev.slice(0, 3).every((e) => e.data.backfill === true));
  assert.deepEqual(ev.slice(0, 3).map((e) => e.id), [at(2), at(3), at(4)].map((x) => String(Date.parse(x))));
});

test('SSE: sem Last-Event-ID (1ª conexão) ou com valor inválido não há backfill', async (t) => {
  const s = await start(t);
  s.store.append({ ts: at(0), host: 'srv', disks: [] });
  for (const headers of [{}, { 'Last-Event-ID': 'lixo' }, { 'Last-Event-ID': '-5' }]) {
    const r = await readSSE(s.port, { headers, until: 3 });
    assert.deepEqual(events(r.data).map((e) => e.event), ['hello', 'annotations'], JSON.stringify(headers));
  }
});

test('SSE: limite de conexões simultâneas responde 503', async (t) => {
  const s = await start(t, { sseMaxClients: 1 });
  // A 1ª conexão fica aberta até o teste a cortar. Antes ela fechava sozinha em 1,5 s: com a
  // máquina carregada, a 2ª chegava depois disso e recebia 200 em vez de 503 (#25).
  const fim = new AbortController();
  const first = readSSE(s.port, { until: 99, timeoutMs: 15000, signal: fim.signal });
  // A 1ª conexão precisa estar no hub antes da 2ª (espera fixa falhava com a máquina carregada).
  await esperarAte(() => s.sse.size >= 1);
  assert.equal(s.sse.size, 1, 'a 1ª conexão SSE entrou no hub');
  const second = await request(s.port, { path: '/api/stream' });
  fim.abort();
  assert.equal(second.status, 503);
  assert.match(second.json.error, /conexões demais/);
  assert.equal((await first).timeout, undefined, 'a 1ª conexão foi cortada pelo teste, não pelo tempo');
});

test('sse.js: formato do evento e leitura do Last-Event-ID', () => {
  assert.equal(formatEvent('x', { a: 1 }, 5), 'id: 5\nevent: x\ndata: {"a":1}\n\n');
  assert.equal(formatEvent('x', { a: 1 }), 'event: x\ndata: {"a":1}\n\n');
  assert.equal(lastEventId({ headers: { 'last-event-id': ' 123 ' } }), 123);
  assert.equal(lastEventId({ headers: {} }), null);
  assert.equal(lastEventId({ headers: { 'last-event-id': '1e400' } }), null);
  assert.equal(sampleId({ ts: 'x' }), undefined);
  assert.equal(new SseHub().size, 0);
});

test('SSE: o hello leva o id da amostra mais recente (tela sem amostra ao vivo também retoma)', async (t) => {
  const s = await start(t);
  const empty = events((await readSSE(s.port, { until: 3 })).data).find((e) => e.event === 'hello');
  assert.equal(empty.id, null, 'sem amostra, sem id');
  s.store.append({ ts: at(7), host: 'srv', disks: [] });
  const hello = events((await readSSE(s.port, { until: 3 })).data).find((e) => e.event === 'hello');
  assert.equal(hello.id, String(Date.parse(at(7))));
});
