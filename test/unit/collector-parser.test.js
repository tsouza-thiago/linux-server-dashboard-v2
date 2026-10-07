import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOutput, splitSections, humanBytes, SCHEMA_VERSION } from '../../server/collector/parser.js';
import { normalizeTargets } from '../../server/collector/builder.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'coleta-v2');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const TS = '2026-10-07T13:51:00.000Z';

const REAL_TARGETS = normalizeTargets({
  netIf: 'enp0s7', mounts: ['/', '/mnt/sdb1', '/mnt/sdc1', '/mnt/sdc2'], devs: ['sda', 'sdb', 'sdc'], services: ['smbd'],
});
const EDGE_TARGETS = normalizeTargets({
  netIf: 'eth0', mounts: ['/', '/mnt/dados', '/mnt/nao-existe'], devs: ['nvme0n1', 'sdb', 'sdc'], services: ['smbd', 'nmbd', 'jellyfin', 'docker'],
});

const sectionOnly = (body) => parseOutput(`===HOST===\nsrv\n${body}\n===FIM===\n`, TS, {});

test('golden: amostra real do Debian 13 (1 núcleo, 3 discos) no formato V2', () => {
  const s = parseOutput(read('debian13-1nucleo.txt'), TS, { targets: REAL_TARGETS });
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(s.collector, { version: 2, hash: '73cebb436c7c', mode: 'smart', complete: true, expectedVersion: 2 });
  assert.equal(s.host, 'servidor-exemplo');
  assert.deepEqual(s.os, { kernel: '6.12.111+deb13-amd64', name: 'Debian GNU/Linux 13 (trixie)' });
  assert.equal(s.cores, 1);
  assert.equal(s.uptimeSec, 12937.03);
  assert.equal(s.bootAt, new Date(Date.parse(TS) - 12937030).toISOString());
  assert.deepEqual(s.load, [0.08, 0.02, 0.01]);
  assert.equal(s.cpuTicks.total, 102345 + 120 + 45678 + 1234567 + 8901 + 1234);
  assert.equal(s.cpu, null, 'CPU % só existe a partir da 2ª coleta');
  assert.deepEqual(s.ram, { total: 840, used: 406, free: 120, cache: 479, avail: 434, swapTotal: 885, swapUsed: 24, dirty: 0, writeback: 0 });

  assert.equal(s.disks.length, 4);
  assert.deepEqual(s.disks[0], {
    mount: '/', source: '/dev/sda2', dev: 'sda', size: '145G', used: '2.5G', avail: '135G', pct: 2,
    sizeBytes: 155475050496, usedBytes: 2626056192, availBytes: 144876724224, inodesPct: 3,
  });
  assert.deepEqual(s.disks.map((d) => [d.mount, d.dev, d.size, d.used, d.avail, d.pct]), [
    ['/', 'sda', '145G', '2.5G', '135G', 2],
    ['/mnt/sdb1', 'sdb', '1.8T', '472G', '1.3T', 28],
    ['/mnt/sdc1', 'sdc', '1.8T', '472G', '1.3T', 28],
    ['/mnt/sdc2', 'sdc', '3.6T', '5.4G', '3.4T', 1],
  ], 'tamanhos legíveis iguais aos do df -h real');
  assert.deepEqual(s.missingMounts, []);

  assert.deepEqual(s.net, {
    iface: 'enp0s7', rxBytes: 1752505, rxErrors: 0, rxDrops: 0, txBytes: 771648, txErrors: 0, txDrops: 0, rxMbps: null, txMbps: null,
  });
  assert.deepEqual(s.io.map((d) => d.dev), ['sda', 'sdb', 'sdc']);
  assert.deepEqual(s.io[0], {
    dev: 'sda', readIos: 15783, sectorsRead: 1156426, readTicksMs: 136971, writeIos: 3699, sectorsWrite: 118552,
    writeTicksMs: 19880, ioTicksMs: 91540, readMBps: null, writeMBps: null, utilPct: null, latencyMs: null,
  });
  assert.equal(s.psi, null, 'kernel sem /proc/pressure → sem dado');
  assert.deepEqual(s.temps, [{ type: 'acpitz', c: 32 }]);
  assert.equal(s.tempC, 32);
  assert.equal(s.tempSensor, 'acpitz');
  assert.deepEqual(s.smart, [{ dev: 'sda', status: 'PASSED' }, { dev: 'sdb', status: 'PASSED' }, { dev: 'sdc', status: 'PASSED' }]);
  assert.equal(s.smartAt, TS);
  assert.deepEqual(s.services, { smbd: 'active' });
  assert.equal(s.topProcs.length, 7);
  assert.deepEqual(s.topProcs[0], {
    user: 'root', pid: 990, cpu: 0, mem: 11.4, rssKB: 98520, etimesSec: 12880,
    cmd: '/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock',
  });
});

test('golden: casos-limite (contador colado, sem permissão, PSI, vários sensores, mount ausente)', () => {
  const s = parseOutput(read('casos-limite.txt'), TS, { targets: EDGE_TARGETS });
  assert.equal(s.os.name, 'Debian GNU/Linux', 'só NAME= também serve');
  assert.equal(s.cores, 2);
  assert.equal(s.uptimeSec, 86400.5, 'uptime fracionado');
  assert.deepEqual(s.load, [2.5, 1.75, 1.1], 'vírgula decimal (locale) é aceita');
  assert.deepEqual(s.ram, { total: 2000, used: 1900, free: 50, cache: 100, avail: 100, swapTotal: 0, swapUsed: 0, dirty: 64, writeback: 4 });

  assert.deepEqual(s.disks.map((d) => [d.mount, d.dev, d.pct, d.inodesPct]), [['/', 'nvme0n1', 96, 99], ['/mnt/dados', 'sdb', 3, null]]);
  assert.deepEqual(s.missingMounts, ['/mnt/nao-existe']);

  assert.equal(s.net.iface, 'eth0');
  assert.equal(s.net.rxBytes, 123456789012, 'B2: contador colado ao nome');
  assert.equal(s.net.txBytes, 9876543210);
  assert.deepEqual([s.net.rxErrors, s.net.rxDrops, s.net.txErrors, s.net.txDrops], [1, 2, 3, 4]);

  assert.deepEqual(s.io.map((d) => [d.dev, d.ioTicksMs]), [['nvme0n1', 900], ['sdb', 5]], 'kernel antigo (14 campos) e novo (20)');
  assert.deepEqual(s.psi.cpu, { some10: 12.5, some60: 8.25, full10: 0, full60: 0 });
  assert.deepEqual(s.psi.io, { some10: 30, some60: 22, full10: 25, full60: 18 });

  assert.deepEqual(s.temps.map((t) => t.type), ['acpitz', 'pch_cannonlake', 'x86_pkg_temp'], 'sensor com 0 é ignorado');
  assert.equal(s.tempC, 61.5, 'prefere o sensor do pacote da CPU');
  assert.equal(s.tempSensor, 'x86_pkg_temp');

  assert.deepEqual(s.smart, [
    { dev: 'nvme0n1', status: 'SEM_PERMISSAO' }, { dev: 'sdb', status: 'FAILED' }, { dev: 'sdc', status: 'DESCONHECIDO' },
  ]);
  assert.deepEqual(s.services, { smbd: 'active', nmbd: 'failed', jellyfin: 'inactive', docker: 'desconhecido' });
  assert.deepEqual(s.topProcs.map((p) => p.cmd), ['/usr/bin/php-fpm: pool www', '/sbin/init'],
    'o próprio ps e linhas curtas são ignorados');
});

test('I5: amostra vazia ou só com HOST não inventa zeros', () => {
  for (const out of ['', '===HOST===\nsrv\n']) {
    const s = parseOutput(out, TS, {});
    assert.equal(s.load, null);
    assert.equal(s.ram, null);
    assert.equal(s.net, null);
    assert.equal(s.tempC, null);
    assert.equal(s.uptimeSec, null);
    assert.equal(s.cores, null);
    assert.equal(s.smart, null);
    assert.deepEqual(s.disks, []);
    assert.equal(s.collector.complete, false, 'sem ===FIM=== a saída é incompleta');
  }
});

test('saída cortada no meio (timeout) fica marcada como incompleta', () => {
  const full = read('debian13-1nucleo.txt');
  const cut = full.slice(0, full.indexOf('===PS==='));
  const s = parseOutput(cut, TS, { targets: REAL_TARGETS });
  assert.equal(s.collector.complete, false);
  assert.equal(s.host, 'servidor-exemplo');
  assert.deepEqual(s.topProcs, []);
});

test('SMART pulado (modo básico) fica null para a coleta reaproveitar o último', () => {
  const s = sectionOnly('===SMART===\npulado');
  assert.equal(s.smart, null);
  assert.equal(s.smartAt, null);
});

test('rede: sem interface configurada pega a primeira linha válida; com interface, só a exata', () => {
  const lines = '===NET===\n  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0\n veth0: 7 1 0 0 0 0 0 0 8 1 0 0 0 0 0 0';
  assert.equal(sectionOnly(lines).net.iface, 'eth0');
  const s = parseOutput(`${lines}\n`, TS, { targets: { netIf: 'veth0' } });
  assert.equal(s.net.rxBytes, 7);
  assert.equal(parseOutput(`${lines}\n`, TS, { targets: { netIf: 'wlan0' } }).net, null);
  assert.equal(sectionOnly('===NET===\neth0: 1 2 3').net, null, 'linha com campos faltando');
});

test('disco: cabeçalho ignorado, mount repetido (pasta que não é ponto de montagem) aparece 1 vez', () => {
  const s = parseOutput([
    '===DF===',
    'Filesystem Mounted on 1B-blocks Used Avail Use% IUse%',
    '/dev/vda / 1000 500 500 50% 2%',
    '/dev/vda / 1000 500 500 50% 2%',
    'tmpfs /run 100 1 99 1% 1%',
  ].join('\n'), TS, { targets: { mounts: ['/', '/tmp', '/run'] } });
  assert.deepEqual(s.disks.map((d) => [d.mount, d.dev]), [['/', 'vda'], ['/run', null]]);
  assert.deepEqual(s.missingMounts, ['/tmp']);
});

test('IO: só os dispositivos configurados', () => {
  const body = '===IO===\n 8 0 sda 1 0 2 3 4 0 5 6 0 7 8\n 8 16 sdb 1 0 2 3 4 0 5 6 0 7 8';
  assert.deepEqual(parseOutput(body, TS, { targets: { devs: ['sdb'] } }).io.map((d) => d.dev), ['sdb']);
  assert.deepEqual(parseOutput(body, TS, {}).io.map((d) => d.dev), ['sda', 'sdb'], 'sem filtro aceita todos');
});

test('memória sem MemTotal fica null; sem MemAvailable usa MemFree', () => {
  assert.equal(sectionOnly('===MEM===\nMemFree: 100 kB').ram, null);
  const s = sectionOnly('===MEM===\nMemTotal: 2048 kB\nMemFree: 1024 kB');
  assert.equal(s.ram.avail, 1);
  assert.equal(s.ram.used, 1);
});

test('seções desconhecidas e lixo antes do primeiro marcador são ignorados', () => {
  const s = parseOutput('Bem-vindo ao servidor!\n===HOST===\nsrv\n===NOVA===\nqualquer coisa\n===FIM===\n', TS, {});
  assert.equal(s.host, 'srv');
  assert.equal(s.collector.complete, true);
  assert.deepEqual(Object.keys(splitSections('lixo\n===A===\nx\n\n===B===\n')), ['A', 'B']);
});

test('humanBytes segue o df -h (base 1024, arredonda para cima)', () => {
  assert.equal(humanBytes(0), '0B');
  assert.equal(humanBytes(1536), '1.5K');
  assert.equal(humanBytes(10 * 1024 ** 3), '10G');
  assert.equal(humanBytes(5708095488), '5.4G');
  assert.equal(humanBytes(null), null);
  assert.equal(humanBytes(NaN), null);
});
