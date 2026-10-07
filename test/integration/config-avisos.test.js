import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('servidor avisa no log quando um limiar do .env é recusado (sem ecoar o valor)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-avisos-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexit 255\n', { mode: 0o755 });
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true, mode: 0o700 });
  const logDir = fs.mkdtempSync(path.join(ROOT, 'data', 'teste-avisos-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(logDir, { recursive: true, force: true }); });
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_HOST: 'host-teste', PORT: '39871',
      ALERT_TEMP_C: '999', ALERT_DISK_PCT: '85', LOG_FILE: path.relative(ROOT, path.join(logDir, 'd.log')),
      HISTORY_FILE: path.relative(ROOT, path.join(logDir, 'history.json')),
    },
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sem aviso em 10 s:\n${out}`)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('dashboard em')) { clearTimeout(timer); resolve(); }
    });
  });
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  assert.match(out, /AVISO de configuração: ALERT_TEMP_C inválido \(aceita 30–110\); usando 60/);
  assert.ok(!out.includes('999'), 'valor recusado não aparece no log');
  assert.ok(!out.includes('ALERT_DISK_PCT'), 'valor válido não gera aviso');
});
