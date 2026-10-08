import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect as collectV2, describeError, smartDue } from '../../server/collector/index.js';
import { normalizeTargets, targetsHash } from '../../server/collector/builder.js';
import { collect, computeAlerts, buildCommand } from '../../server/poller.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'coleta-v2');
const REAL = fs.readFileSync(path.join(FIX, 'debian13-real.txt'), 'utf8');
const TARGETS = { netIf: 'enp0s7', mounts: ['/', '/mnt/sdb1', '/mnt/sdc1', '/mnt/sdc2'], devs: ['sda', 'sdb', 'sdc'], services: ['smbd'] };
const NOW = Date.parse('2026-10-07T13:51:00.000Z');
const ok = (stdout) => async () => ({ stdout, stderr: '', code: 0, timedOut: false });

test('collect: 1 única chamada ao SSH por coleta (I1), com host e comando', async () => {
  const calls = [];
  const res = await collectV2({
    host: 'meu-servidor', targets: TARGETS, now: NOW,
    runner: async (host, command) => { calls.push({ host, command }); return { stdout: REAL, stderr: '', code: 0 }; },
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'meu-servidor');
  assert.match(calls[0].command, /^LC_ALL=C;/);
});

test('collect: amostra completa, hash confere com a configuração', async () => {
  const res = await collectV2({ host: 'h', targets: TARGETS, now: NOW, runner: ok(REAL) });
  assert.equal(res.sample.host, 'servidor-exemplo');
  assert.equal(res.sample.ts, new Date(NOW).toISOString());
  assert.equal(res.sample.collector.expectedHash, targetsHash(TARGETS));
  assert.equal(res.sample.collector.hashMismatch, false);
  assert.equal(res.sample.collector.outputBytes, Buffer.byteLength(REAL), 'tamanho da saída do SSH');
  assert.ok(Number.isInteger(res.sample.collector.durationMs) && res.sample.collector.durationMs >= 0, 'tempo do SSH');
});

test('collect: hash diferente (authorized_keys desatualizado) continua coletando e sinaliza (Q10)', async () => {
  const res = await collectV2({ host: 'h', targets: { ...TARGETS, services: ['smbd', 'nmbd'] }, now: NOW, runner: ok(REAL) });
  assert.equal(res.ok, true);
  assert.equal(res.sample.collector.hashMismatch, true);
});

test('SMART 1x por hora: pede na 1ª coleta, pula na seguinte, pede de novo após 1 h', () => {
  const t = normalizeTargets(TARGETS);
  assert.equal(smartDue(t, null, NOW), true);
  assert.equal(smartDue(t, { smartAt: new Date(NOW - 59 * 60e3).toISOString() }, NOW), false);
  assert.equal(smartDue(t, { smartAt: new Date(NOW - 60 * 60e3).toISOString() }, NOW), true);
  assert.equal(smartDue(normalizeTargets({ ...TARGETS, devs: [] }), null, NOW), false, 'sem discos, sem SMART');
});

test('collect: modo vai no comando e o SMART anterior é mantido quando pulado', async () => {
  let command = '';
  const runner = async (_h, c) => { command = c; return { stdout: REAL.replace(/===SMART===[\s\S]*?===SERVICES===/, '===SMART===\npulado\n===SERVICES==='), stderr: '', code: 0 }; };
  const prev = { ts: new Date(NOW - 60e3).toISOString(), smart: [{ dev: 'sda', status: 'PASSED' }], smartAt: new Date(NOW - 10 * 60e3).toISOString() };
  const res = await collectV2({ host: 'h', targets: TARGETS, prev, now: NOW, runner });
  assert.match(command, /SSH_ORIGINAL_COMMAND:-basico/);
  assert.deepEqual(res.sample.smart, prev.smart);
  assert.equal(res.sample.smartAt, prev.smartAt);
});

test('collect: falhas do SSH viram mensagens claras', async () => {
  const fail = (r) => collectV2({ host: 'h', targets: TARGETS, now: NOW, runner: async () => ({ stdout: '', stderr: '', ...r }) });
  assert.equal((await fail({ code: 255, stderr: 'Connection refused' })).error, describeError({ code: 255 }));
  assert.equal((await fail({ code: null, timedOut: true })).error, describeError({ timedOut: true }));
  const noMarker = await collectV2({ host: 'h', targets: TARGETS, now: NOW, runner: ok('sem marcação') });
  assert.equal(noMarker.ok, false);
});

test('describeError converte falhas SSH em mensagens amigáveis', () => {
  assert.equal(describeError({ timedOut: true }), 'timeout — servidor não respondeu (rede/servidor fora do ar?)');
  assert.ok(describeError({ stderr: 'Host key verification failed.' }).includes('dashboard reconfigurar'));
  assert.equal(describeError({ code: 255 }), 'SSH falhou (exit 255) — host não encontrado ou chave inválida');
  assert.equal(describeError({ code: 1 }), 'SSH falhou (exit 1)');
  assert.equal(describeError({ error: 'spawn ssh ENOENT' }), 'spawn ssh ENOENT');
  assert.equal(describeError({}), 'sem resposta');
});

test('computeAlerts: limiares da V1 continuam valendo', () => {
  const alerts = computeAlerts({
    disks: [{ mount: '/', pct: 92 }], ram: { total: 1000, used: 950 }, tempC: 65,
    smart: [{ dev: 'sda', status: 'PASSED' }], services: { smbd: 'active' },
  });
  assert.ok(alerts.some((a) => a.level === 'warning' && a.message.includes('Disco')));
  assert.ok(alerts.some((a) => a.level === 'warning' && a.message.includes('RAM')));
  assert.ok(alerts.some((a) => a.level === 'warning' && a.message.includes('Temperatura')));
  assert.deepEqual(computeAlerts({
    disks: [{ mount: '/', pct: 20 }], ram: { total: 1000, used: 300 }, tempC: 40,
    smart: [{ dev: 'sda', status: 'PASSED' }], services: { smbd: 'active' },
  }), []);
});

test('computeAlerts: SMART só alerta em FAILED; serviço só quando parado de verdade', () => {
  const alerts = computeAlerts({
    disks: [], ram: null, tempC: null,
    smart: [{ dev: 'sda', status: 'SEM_PERMISSAO' }, { dev: 'sdb', status: 'FAILED' }, { dev: 'sdc', status: 'DESCONHECIDO' }],
    services: { a: 'active', b: 'failed', c: 'inactive', d: 'desconhecido', e: 'activating' },
  });
  assert.deepEqual(alerts.map((a) => a.message), ['SMART /dev/sdb: FAILED', 'Serviço b failed', 'Serviço c inactive']);
  assert.ok(alerts.every((a) => a.level === 'critical'));
  assert.deepEqual(computeAlerts({ disks: [{ mount: '/', pct: null }], smart: null, services: {} }), [], 'sem dado não alerta');
});

test('fachada collect usa os alvos do .env e aceita runner da V1', async () => {
  const res = await collect({ host: 'h', prev: null, runner: async () => ({ stdout: REAL, stderr: '', code: 0 }) });
  assert.equal(res.ok, true);
  assert.equal(res.sample.host, 'servidor-exemplo');
  assert.ok(Array.isArray(res.alerts));
});

test('fachada buildCommand aceita os nomes de override da V1', () => {
  const cmd = buildCommand({ netIf: 'enp0s7', diskMounts: ['/', '/mnt/x'], diskDevs: ['sda'], services: ['smbd'] });
  assert.ok(cmd.includes(' / /mnt/x 2>/dev/null'));
  assert.ok(cmd.includes('$3=="sda"'));
  assert.ok(cmd.includes('for s in smbd;'));
  assert.ok(buildCommand({}, 'smart').includes(':-smart}'));
});
