// Limiar inválido no .env vira aviso no log do painel, sem ecoar o valor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Só o texto das mensagens: o horário de cada linha pode conter o valor recusado por acaso
// (`.999Z`), e isso não é vazamento (#135).
const semHorario = (saida) => saida.replace(/^\[[^\]]*\] /gm, '');

test('semHorario: tira o horário de cada linha e mantém o número da mensagem', () => {
  const saida = '[2026-11-01T17:14:56.999Z] primeira\n[2026-11-01T17:14:56.999Z] valor 999\n';
  assert.equal(semHorario(saida), 'primeira\nvalor 999\n');
});

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
  const mensagens = semHorario(out);
  assert.match(mensagens, /AVISO de configuração: ALERT_TEMP_C inválido \(aceita 30–110\); usando 60/);
  assert.ok(!mensagens.includes('999'), 'valor recusado não aparece no log');
  assert.ok(!mensagens.includes('ALERT_DISK_PCT'), 'valor válido não gera aviso');
});
