// Tempo medido (ADR 0018, #24): faixas de 5 min com amostra + quedas. A disponibilidade não
// conta o tempo em que nenhum painel estava coletando.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeSpans, clipSpans, spansMs, spansToIso } from '../../server/storage/coverage.js';
import { RollupStore, ROLLUP_STEP_MS } from '../../server/storage/rollup.js';
import { History } from '../../server/storage/index.js';
import { OutageLog } from '../../server/storage/outages.js';
import { dayOf } from '../../server/storage/ndjson.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-cobertura-'));
const MIN = 60000;
const STEP = ROLLUP_STEP_MS;
const BASE = Date.UTC(2026, 9, 7, 0, 0);
const at = (min) => new Date(BASE + min * MIN).toISOString();
const sample = (min) => ({ ts: at(min), host: 'srv', tempC: 40, load: [0.1, 0.1, 0.1] });
const silent = () => {};

test('cobertura: junta intervalos que se tocam, corta na janela e soma', () => {
  const spans = mergeSpans([[30, 40], [0, 10], [10, 20], [5, 8], [50, 50], [NaN, 3]]);
  assert.deepEqual(spans, [[0, 20], [30, 40]], 'vazio e inválido saem; vizinhos viram um só');
  assert.deepEqual(clipSpans(spans, 15, 35), [[15, 20], [30, 35]]);
  assert.equal(spansMs(spans), 30);
  assert.deepEqual(spansToIso([[BASE, BASE + STEP]]), [{ from: at(0), to: at(5) }]);
  const entrada = [[0, 10], [5, 20]];
  mergeSpans(entrada);
  assert.deepEqual(entrada, [[0, 10], [5, 20]], 'não altera a lista recebida');
});

test('History.monitored: 2 períodos de coleta separados por uma lacuna de 2 dias', async () => {
  const dir = tmp();
  const h = new History({ dataDir: dir, log: silent });
  // 30 min de coleta, 2 dias sem painel, mais 30 min.
  const gap = 2 * 1440;
  for (let i = 0; i < 30; i += 1) h.append(sample(i));
  for (let i = 0; i < 30; i += 1) h.append(sample(gap + i));
  await h.flush();
  const toMs = BASE + (gap + 30) * MIN;
  const spans = h.monitored(BASE - 3 * 1440 * MIN, toMs);
  assert.deepEqual(spans, [[BASE, BASE + 30 * MIN], [BASE + gap * MIN, toMs]], 'a lacuna fica de fora');
  assert.equal(spansMs(spans), 60 * MIN);
  // Uma queda conta como tempo medido (o painel estava rodando e tentando).
  const comQueda = h.monitored(BASE - 3 * 1440 * MIN, toMs, [[BASE + 40 * MIN, BASE + 50 * MIN]]);
  assert.equal(spansMs(comQueda), 70 * MIN);

  // Reiniciado, o painel lê a cobertura do disco (agregados) e chega ao mesmo resultado.
  const again = new History({ dataDir: dir, log: silent });
  assert.deepEqual(again.monitored(BASE - 3 * 1440 * MIN, toMs), spans);
});

test('RollupStore.coverage: lê só t e n do disco, ignora balde vazio e acompanha o que fecha', async () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dayOf(BASE)}.ndjson`);
  fs.writeFileSync(file, [
    JSON.stringify({ t: BASE, n: 5, m: {} }),
    JSON.stringify({ n: 3, t: BASE + STEP, m: {} }), // outra ordem: lido pelo JSON
    JSON.stringify({ t: BASE + 2 * STEP, n: 0, m: {} }), // sem amostra: não é tempo medido
    'lixo',
    '',
  ].join('\n'));
  const r = new RollupStore({ dir, log: silent });
  assert.deepEqual(r.coverage(), [[BASE, BASE + 2 * STEP]]);
  const raw = [];
  for (let i = 20; i < 31; i += 1) raw.push(sample(i));
  r.close(raw, Date.parse(at(30)));
  await r.flush();
  assert.deepEqual(r.coverage(), [[BASE, BASE + 2 * STEP], [BASE + 4 * STEP, BASE + 6 * STEP]], 'baldes 20–30 entram ao fechar');
});

test('OutageLog.uptime com tempo medido: a lacuna não conta, e sem medida é null', () => {
  const now = BASE + 10 * 1440 * MIN;
  const log = new OutageLog({ file: path.join(tmp(), 'o.ndjson'), now: () => now });
  log.start(BASE + 10 * MIN, 'caiu');
  log.end(BASE + 25 * MIN);
  // 1 h medida no dia 0 (com a queda de 15 min dentro) e nada nos 9 dias seguintes.
  const monitored = [[BASE, BASE + 60 * MIN]];
  const u = log.uptime({ fromMs: now - 30 * 1440 * MIN, toMs: now, monitored });
  assert.equal(u.monitoredMs, 60 * MIN);
  assert.equal(u.offlineMs, 15 * MIN);
  assert.equal(u.uptimePct, 75, '15 min fora em 1 h medida, não em 10 dias');
  assert.equal(u.windowMs, 30 * 1440 * MIN, 'windowMs é o período pedido');
  assert.equal(u.from, at(0), 'from é o início do tempo medido');
  const nada = log.uptime({ fromMs: now - 1440 * MIN, toMs: now, monitored: [] });
  assert.equal(nada.uptimePct, null, 'sem tempo medido não vira 100%');
  assert.equal(nada.monitoredMs, 0);
});
