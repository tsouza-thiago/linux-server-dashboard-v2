// Painel de teste dos testes no navegador (ADR 0019, #46): cada cenário grava os dados que
// promete, numa pasta temporária, sem SSH e sem tocar no data/ da instalação.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { semear, criarPainel, CENARIOS } from '../../scripts/painel-teste.mjs';
import { History } from '../../server/storage/index.js';
import { OutageLog } from '../../server/storage/outages.js';
import { listen, close, request } from '../../test-support/request.js';

const MIN = 60000;
const DAY = 1440 * MIN;
const AGORA = Date.parse('2026-10-20T15:00:00-03:00');
const pasta = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-painel-teste-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const abrir = (dir) => ({
  h: new History({ dataDir: dir, log: () => {} }),
  quedas: new OutageLog({ file: path.join(dir, 'outages.ndjson'), now: () => AGORA, log: () => {} }),
});

test('painel de teste: os 4 cenários existem e um nome errado é recusado', async (t) => {
  assert.deepEqual(CENARIOS, ['normal', 'lacunas', 'offline', 'vazio']);
  await assert.rejects(semear(pasta(t), 'nao-existe', { agora: AGORA }), /cenário desconhecido/);
});

test('painel de teste: normal tem coleta contínua, com taxas, e nenhuma queda', async (t) => {
  const dir = pasta(t);
  await semear(dir, 'normal', { agora: AGORA, horasBrutas: 2, diasAntigos: 1 });
  const { h, quedas } = abrir(dir);
  assert.equal(h.length, 120 + 12 * 24, '1 dia a cada 5 min + 2 h a cada minuto');
  const ultima = h.getLatest();
  assert.equal(typeof ultima.cpu?.pct, 'number', 'CPU calculada (contadores avançam)');
  assert.equal(ultima.disks.length, 4);
  assert.deepEqual(quedas.list({ fromMs: AGORA - 30 * DAY, toMs: AGORA }), []);
});

test('painel de teste: lacunas tem dias sem coleta e um dia inteiro em queda', async (t) => {
  const dir = pasta(t);
  await semear(dir, 'lacunas', { agora: AGORA });
  const { h, quedas } = abrir(dir);
  const lista = quedas.list({ fromMs: AGORA - 30 * DAY, toMs: AGORA });
  assert.equal(lista.length, 1);
  assert.ok(Date.parse(lista[0].to) - Date.parse(lista[0].from) > DAY, 'a queda atravessa um dia inteiro');
  const medido = h.monitored(AGORA - 7 * DAY, AGORA, quedas.spans({ fromMs: AGORA - 7 * DAY, toMs: AGORA }));
  const dias = new Set(medido.flatMap(([a, b]) => [new Date(a).toDateString(), new Date(b - 1).toDateString()]));
  assert.ok(!dias.has(new Date(AGORA - 5 * DAY).toDateString()), 'há dia sem nenhum tempo medido');
});

test('painel de teste: offline termina 10 min antes de agora; vazio não grava nada', async (t) => {
  const off = pasta(t);
  await semear(off, 'offline', { agora: AGORA });
  const { h } = abrir(off);
  assert.equal(h.getLatest().ts, new Date(AGORA - 11 * MIN).toISOString());
  const vazio = pasta(t);
  await semear(vazio, 'vazio', { agora: AGORA });
  assert.equal(abrir(vazio).h.length, 0);
});

test('painel de teste: /api/config tem os discos com SMART, como a instalação sem SMART_DEVS (#57)', async (t) => {
  const dir = pasta(t);
  const { coletar } = await semear(dir, 'vazio', { agora: AGORA });
  const { app, shutdown } = criarPainel(dir, 'vazio', coletar);
  const { server, port } = await listen(app);
  t.after(async () => { await close(server); await shutdown(); });
  const r = await request(port, { path: '/api/config' });
  assert.equal(r.status, 200);
  // Sem smartDevs, a Ajuda diria "nenhum disco em SMART_DEVS" ao lado do sudo liberado.
  assert.deepEqual(r.json.targets.smartDevs, ['sda', 'sdb', 'sdc']);
});
