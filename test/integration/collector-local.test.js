// O comando V2 rodando de verdade num Linux (este computador faz o papel do servidor):
// um `ssh` falso no PATH executa o script recebido com `sh -c`, e o CLI do poller
// interpreta a saída real do kernel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScript, normalizeTargets } from '../../server/collector/builder.js';
import { parseOutput } from '../../server/collector/parser.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const linux = process.platform === 'linux' && fs.existsSync('/proc/stat');

test('o script passa no sh -n e roda com sh (POSIX) neste Linux, saída completa e interpretável', { skip: !linux && 'requer Linux' }, () => {
  const targets = normalizeTargets({ mounts: ['/'], devs: ['sda'], services: ['ssh'] });
  for (const mode of ['basico', 'smart']) {
    const { script } = buildScript(targets, mode);
    execFileSync('sh', ['-n', '-c', script]);
    const out = execFileSync('sh', ['-c', script], { encoding: 'utf8' });
    const s = parseOutput(out, new Date().toISOString(), { targets });
    assert.equal(s.collector.complete, true, `modo ${mode}`);
    assert.equal(s.collector.mode, mode);
    assert.ok(s.host, 'hostname');
    assert.ok(s.os.kernel, 'kernel');
    assert.ok(Array.isArray(s.load) && s.load.length === 3);
    assert.ok(s.cpuTicks && s.cpuTicks.total > 0);
    assert.ok(s.ram && s.ram.total > 0);
    assert.ok(s.disks.some((d) => d.mount === '/' && d.sizeBytes > 0));
    assert.ok(s.topProcs.length > 0);
    if (mode === 'smart') {
      assert.equal(s.smart.length, 1);
      assert.ok(['PASSED', 'FAILED', 'SEM_PERMISSAO', 'SEM_SMARTCTL', 'DESCONHECIDO'].includes(s.smart[0].status));
    } else {
      assert.equal(s.smart, null);
    }
  }
});

test('ponta a ponta: `node server/poller.js --once` com ssh falso executando o comando localmente', { skip: !linux && 'requer Linux' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-e2e-'));
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'chamadas.log');
  fs.mkdirSync(bin);
  // Ignora as opções do ssh, registra a chamada e executa o último argumento (o comando).
  fs.writeFileSync(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    `echo "$#" >> "${log}"`,
    'for last; do :; done',
    'exec sh -c "$last"',
  ].join('\n'), { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'poller.js'), '--once'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_HOST: 'servidor-local', DISK_MOUNTS: '/', NET_IF: 'lo', DISK_DEVS: '', SERVICES: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true);
  assert.equal(res.sample.schemaVersion, 2);
  assert.equal(res.sample.collector.complete, true);
  assert.equal(res.sample.collector.hashMismatch, false);
  assert.equal(res.sample.net.iface, 'lo');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'exatamente 1 conexão SSH');
});
