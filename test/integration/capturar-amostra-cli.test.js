import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'capturar-amostra.mjs');

// ssh falso: registra cada chamada e devolve uma saída de coleta mínima
function fakeSsh(dir, { exit = 0 } = {}) {
  const log = path.join(dir, 'chamadas.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${log}"`,
    `[ ${exit} -ne 0 ] && { echo 'Permission denied' >&2; exit ${exit}; }`,
    "printf '===HOST===\\ncasa-nas\\n===PS===\\nUSER PID\\nmaria 1 0.0 0.1 1 1 ? S 0 0 /bin/app 10.0.0.9\\n'",
  ].join('\n'), { mode: 0o755 });
  return { bin, log };
}

function run(dir, bin) {
  return spawnSync(process.execPath, [SCRIPT, `--saida=${path.join(dir, 'out')}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_HOST: 'meu-servidor' },
  });
}

test('capturar-amostra faz exatamente 1 conexão SSH, não interativa, e grava bruta + anonimizada (0600)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-cap-'));
  const { bin, log } = fakeSsh(dir);
  const r = run(dir, bin);
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /BatchMode=yes/);
  assert.match(calls[0], /ConnectTimeout=10/);
  assert.match(calls[0], /meu-servidor/);
  const raw = path.join(dir, 'out', 'amostra-bruta.txt');
  const anon = path.join(dir, 'out', 'amostra-anonima.txt');
  assert.match(fs.readFileSync(raw, 'utf8'), /casa-nas/);
  const anonText = fs.readFileSync(anon, 'utf8');
  assert.doesNotMatch(anonText, /casa-nas|maria|10\.0\.0\.9/);
  assert.equal(fs.statSync(raw).mode & 0o777, 0o600);
  assert.equal(fs.statSync(anon).mode & 0o777, 0o600);
});

test('capturar-amostra falha com mensagem clara e sem gravar nada quando o SSH falha', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsd-cap-'));
  const { bin } = fakeSsh(dir, { exit: 255 });
  const r = run(dir, bin);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a coleta falhou/);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});
