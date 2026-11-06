// Alertas e anotações guardados (ciclo de vida, reconcile, persistência), JsonStore (padrões, arquivo ausente ou
// inválido, gravação) e o histórico de alertas com as quedas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { AlertsStore, JsonStore, AnnotationsStore } from '../../server/stores.js';
import { OutageLog } from '../../server/storage/outages.js';

function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  const store = new AlertsStore({ file: path.join(dir, 'alerts.json') });
  return { store, dir };
}

test('AlertsStore: ciclo de vida new -> ack -> resolved', () => {
  const { store, dir } = tempStore();
  try {
    const a = store.add({ level: 'warning', message: 'Disco / em 92%' });
    assert.equal(a.status, 'new');
    assert.equal(store.active.length, 1);

    store.setStatus(a.id, 'ack');
    assert.equal(store.active.length, 1);
    assert.equal(store.active[0].status, 'ack');

    store.setStatus(a.id, 'resolved');
    assert.equal(store.active.length, 0);
    assert.equal(store.list({})[0].status, 'resolved');
    assert.ok(store.list({})[0].resolvedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.reconcile resolve o que sumiu e mantém o ativo', () => {
  const { store, dir } = tempStore();
  try {
    store.reconcile([{ level: 'warning', message: 'Disco / em 92%' }]);
    assert.equal(store.active.length, 1);

    store.reconcile([{ level: 'warning', message: 'Disco / em 92%' }]);
    assert.equal(store.active.length, 1, 'não duplica condição ativa');

    store.reconcile([]);
    assert.equal(store.active.length, 0, 'condição sumiu -> auto-resolve');
    assert.equal(store.list({})[0].status, 'resolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore persiste e recarrega', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-test-'));
  try {
    const file = path.join(dir, 'alerts.json');
    const a1 = new AlertsStore({ file });
    a1.add({ level: 'critical', message: 'SMART /dev/sda: FAILED' });
    await a1.flush();

    const a2 = new AlertsStore({ file });
    assert.equal(a2.active.length, 1);
    assert.equal(a2.active[0].message, 'SMART /dev/sda: FAILED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(name, content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-store-'));
  const file = path.join(dir, name);
  if (content !== undefined) writeFileSync(file, content);
  return { dir, file };
}

test('JsonStore: usa defaults quando arquivo ausente', () => {
  const { dir, file } = tempFile('s.json');
  try {
    const s = new JsonStore({ file, defaults: [1] });
    assert.deepEqual(s.data, [1], 'defaults mantidos quando arquivo ausente');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonStore: sobrescreve defaults com conteúdo do arquivo', () => {
  const { dir, file } = tempFile('s.json', JSON.stringify([{ a: 1 }]));
  try {
    const s = new JsonStore({ file, defaults: [999] });
    assert.equal(s.data.length, 1);
    assert.equal(s.data[0].a, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonStore: dados não-array viram lista vazia', () => {
  const { dir, file } = tempFile('s.json', JSON.stringify({ not: 'array' }));
  try {
    const s = new JsonStore({ file });
    assert.deepEqual(s.data, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonStore: save é atômico (sem .tmp residual)', async () => {
  const { dir, file } = tempFile('s.json');
  try {
    const s = new JsonStore({ file });
    s.data = [{ a: 1 }];
    await s.save();
    assert.ok(existsSync(file));
    assert.ok(!existsSync(`${file}.tmp`));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AnnotationsStore: adiciona, trunca e remove', () => {
  const { dir, file } = tempFile('annotations.json');
  try {
    const s = new AnnotationsStore({ file });
    const a = s.add({ ts: '2026-08-15T09:00:00.000Z', text: 'x'.repeat(600), label: 'y'.repeat(120) });
    assert.equal(a.text.length, 500);
    assert.equal(a.label.length, 80);
    assert.ok(a.id);

    assert.equal(s.remove(a.id), true);
    assert.equal(s.remove(a.id), false);
    assert.equal(s.data.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AnnotationsStore: persiste e recarrega', async () => {
  const { dir, file } = tempFile('annotations.json');
  try {
    const s1 = new AnnotationsStore({ file });
    s1.add({ ts: '2026-08-15T09:00:00.000Z', text: 'manutenção', label: 'manut' });
    await s1.flush();
    const s2 = new AnnotationsStore({ file });
    assert.equal(s2.data.length, 1);
    assert.equal(s2.data[0].text, 'manutenção');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.list filtra por status, level e limit', () => {
  const { dir, file } = tempFile('alerts.json');
  try {
    const s = new AlertsStore({ file });
    const w = s.add({ level: 'warning', message: 'Disco / em 90%' });
    const c = s.add({ level: 'critical', message: 'SMART FAILED' });
    s.setStatus(c.id, 'resolved');

    assert.equal(s.list({ status: 'warning' }).length, 0);
    assert.equal(s.list({ status: 'new' }).length, 1);
    assert.equal(s.list({ level: 'critical' }).length, 1);
    assert.equal(s.list({ limit: 1 }).length, 1);
    assert.equal(s.list({ limit: 1 })[0].message, 'SMART FAILED', 'mais recente primeiro');
    assert.equal(s.list({ status: 'resolved', level: 'critical' }).length, 1);
    assert.equal(w.message, 'Disco / em 90%');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.trim respeita o max', () => {
  const { dir, file } = tempFile('alerts.json');
  try {
    const s = new AlertsStore({ file, max: 3 });
    for (let i = 0; i < 6; i++) s.add({ level: 'warning', message: `alerta ${i}` });
    assert.equal(s.data.length, 3);
    assert.equal(s.data[0].message, 'alerta 3');
    assert.equal(s.data[2].message, 'alerta 5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.setStatus retorna null para id inexistente', () => {
  const { dir, file } = tempFile('alerts.json');
  try {
    const s = new AlertsStore({ file });
    assert.equal(s.setStatus('nao-existe', 'ack'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AlertsStore.reconcile deduplica por mensagem (mantém primeiro nível)', () => {
  const { dir, file } = tempFile('alerts.json');
  try {
    const s = new AlertsStore({ file });
    s.reconcile([{ level: 'warning', message: 'Mesma condição' }]);
    s.reconcile([{ level: 'critical', message: 'Mesma condição' }]);
    assert.equal(s.active.length, 1, 'mesma mensagem não duplica');
    assert.equal(s.active[0].level, 'warning');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
