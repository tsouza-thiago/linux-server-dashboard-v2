import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlertsStore } from '../../server/stores.js';
import { OutageLog } from '../../server/storage/outages.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-alert-'));
const MIN = 60000;
const BASE = Date.UTC(2026, 9, 7, 12, 0);
const clock = (start = BASE) => { let t = start; const now = () => t; now.add = (ms) => { t += ms; }; return now; };
const temp = (v) => ({ key: 'temp:cpu', level: 'warning', message: `Temperatura CPU ${v}°C`, value: v });

test('reconcile por chave: condição que persiste atualiza o MESMO alerta (B3)', () => {
  const now = clock();
  const s = new AlertsStore({ file: path.join(tmp(), 'alerts.json'), now });
  for (const v of [61.2, 61.5, 62, 61.8]) { s.reconcile([temp(v)]); now.add(MIN); }
  assert.equal(s.data.length, 1);
  const [a] = s.active;
  assert.equal(a.message, 'Temperatura CPU 61.8°C');
  assert.equal(a.value, 61.8);
  assert.equal(a.ts, new Date(BASE).toISOString(), 'início do alerta não muda');
  assert.equal(a.lastSeenAt, new Date(BASE + 3 * MIN).toISOString());
});

test('reconcile: reconhecido continua reconhecido; resolvido que volta é uma nova ocorrência', () => {
  const s = new AlertsStore({ file: path.join(tmp(), 'alerts.json') });
  s.reconcile([temp(61)]);
  s.setStatus(s.active[0].id, 'ack');
  s.reconcile([temp(62)]);
  assert.equal(s.active[0].status, 'ack');
  s.reconcile([]);
  assert.equal(s.active.length, 0);
  s.reconcile([temp(63)]);
  assert.equal(s.data.length, 2);
  assert.equal(s.active[0].status, 'new');
});

test('reconcile: keep mantém aberto o que não foi medido; "all" mantém tudo (servidor offline)', () => {
  const s = new AlertsStore({ file: path.join(tmp(), 'alerts.json') });
  s.reconcile([temp(61), { key: 'disk:/:usage', level: 'warning', message: 'Disco / com 91% usado', value: 91 }]);
  s.reconcile([], { keep: new Set(['temp:cpu']) });
  assert.deepEqual(s.active.map((a) => a.key), ['temp:cpu']);
  s.reconcile([{ key: 'servidor-inacessivel', level: 'critical', message: 'Servidor inacessível: timeout' }], { keep: 'all' });
  assert.deepEqual(s.active.map((a) => a.key).sort(), ['servidor-inacessivel', 'temp:cpu']);
});

test('reconcile: alerta antigo da V1 (sem chave) é resolvido e reaberto com chave estável', () => {
  const s = new AlertsStore({ file: path.join(tmp(), 'alerts.json') });
  s.data.push({ id: 'v1', ts: new Date(BASE).toISOString(), level: 'warning', message: 'Temperatura CPU 61.2°C', status: 'new' });
  s.reconcile([temp(61.5)]);
  assert.equal(s.data.find((a) => a.id === 'v1').status, 'resolved');
  assert.equal(s.active.length, 1);
  assert.equal(s.active[0].key, 'temp:cpu');
});

test('só o valor mudou: não regrava o arquivo a cada coleta (no máximo a cada 10 min) e o flush grava', async () => {
  const now = clock();
  const file = path.join(tmp(), 'alerts.json');
  const s = new AlertsStore({ file, now });
  s.reconcile([temp(61)]);
  await s.flush();
  const writes = [];
  const save = s.save.bind(s);
  s.save = () => { writes.push(now()); return save(); };
  for (let i = 1; i <= 15; i++) { now.add(MIN); s.reconcile([temp(61 + i / 10)]); }
  assert.equal(writes.length, 1, '15 coletas com valor novo → 1 gravação (aos 10 min)');
  assert.equal(writes[0], BASE + 10 * MIN);
  await s.flush();
  assert.equal(writes.length, 2, 'flush grava o valor pendente');
  assert.match(fs.readFileSync(file, 'utf8'), /Temperatura CPU 62.5°C/);
  await s.flush();
  assert.equal(writes.length, 2, 'nada pendente, nada a gravar');
});

test('OutageLog: abre e fecha quedas, ignora repetição e sobrevive a reinício', async () => {
  const file = path.join(tmp(), 'outages.ndjson');
  const log = new OutageLog({ file, now: () => BASE + 60 * MIN });
  assert.equal(log.isOpen, false);
  log.start(BASE, 'Tempo esgotado');
  assert.equal(log.start(BASE + MIN, 'outra'), null, 'queda já aberta');
  assert.equal(log.isOpen, true);
  log.end(BASE + 30 * MIN);
  assert.equal(log.end(BASE + 31 * MIN), null);
  const skew = new OutageLog({ file: path.join(tmp(), 's.ndjson') });
  skew.start(BASE + 10 * MIN, 'x');
  assert.equal(skew.end(BASE).ts, new Date(BASE + 10 * MIN).toISOString(), 'fim antes do início vira duração 0');
  log.start(BASE + 50 * MIN, 'x'.repeat(500));
  await log.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = new OutageLog({ file, now: () => BASE + 60 * MIN });
  assert.equal(again.isOpen, true);
  assert.deepEqual(again.list().map((o) => [o.from, o.to, o.durationSec, o.ongoing]), [
    [new Date(BASE + 50 * MIN).toISOString(), null, 600, true],
    [new Date(BASE).toISOString(), new Date(BASE + 30 * MIN).toISOString(), 1800, false],
  ]);
  assert.equal(again.list()[0].reason.length, 200);
});

test('OutageLog.uptime: janela começa no início do monitoramento; queda em andamento conta até agora', () => {
  const now = BASE + 10 * 60 * MIN;
  const log = new OutageLog({ file: path.join(tmp(), 'o.ndjson'), now: () => now });
  log.start(BASE + 60 * MIN, 'a');
  log.end(BASE + 90 * MIN);
  log.start(BASE + 9 * 60 * MIN, 'b');
  const u = log.uptime({ fromMs: now - 90 * 24 * 60 * MIN, toMs: now, sinceMs: BASE });
  assert.equal(u.windowMs, 10 * 60 * MIN);
  assert.equal(u.offlineMs, 90 * MIN);
  assert.equal(u.uptimePct, 85);
  assert.equal(u.from, new Date(BASE).toISOString());
  const part = log.uptime({ fromMs: BASE + 75 * MIN, toMs: BASE + 105 * MIN });
  assert.equal(part.offlineMs, 15 * MIN, 'queda cortada nas bordas da janela');
  assert.equal(log.uptime({ fromMs: now, toMs: now }).uptimePct, null, 'janela vazia');
});

test('OutageLog: linhas inválidas, eventos fora de ordem e quedas além de 90 dias são limpos', () => {
  const file = path.join(tmp(), 'o.ndjson');
  const now = BASE + 100 * 24 * 60 * MIN;
  const ev = (min, e) => JSON.stringify({ ts: new Date(BASE + min * MIN).toISOString(), ev: e });
  fs.writeFileSync(file, [ev(0, 'off'), ev(10, 'on'), 'lixo', ev(95 * 24 * 60, 'on'), ev(99 * 24 * 60, 'off'), ev(99 * 24 * 60 + 5, 'off'), ev(99 * 24 * 60 + 9, 'on'), '{"ts":'].join('\n'));
  const logs = [];
  const log = new OutageLog({ file, now: () => now, log: (m) => logs.push(m) });
  assert.match(logs.join(), /2 linha\(s\) inválida\(s\)/);
  assert.deepEqual(log.events.map((e) => e.ev), ['off', 'on'], 'queda antiga saiu; "on" solto e "off" repetido ignorados');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2, 'arquivo reescrito limpo');
  assert.equal(new OutageLog({ file: path.join(tmp(), 'nada.ndjson') }).list().length, 0);
});
