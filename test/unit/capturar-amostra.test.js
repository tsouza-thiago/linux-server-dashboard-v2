import test from 'node:test';
import assert from 'node:assert/strict';
import { anonymize } from '../../scripts/capturar-amostra.mjs';

const RAW = [
  '===HOST===',
  'casa-nas',
  '===OS===',
  '6.12.0-1-amd64',
  'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"',
  '===NET===',
  '  enp3s0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0',
  '===PS===',
  'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
  'root           1  0.0  0.6 168000 12000 ?       Ss   set13   0:05 /sbin/init',
  'maria       1093  1.8  7.1 900000 142000 ?      Ssl  set13  12:00 /usr/bin/app --host casa-nas --bind 10.0.0.42 --mac aa:bb:cc:dd:ee:ff',
  'maria       1094  0.1  0.2  10000  4000 ?       S    set13   0:00 /usr/bin/helper',
].join('\n');

test('anonymize troca hostname, IPs, MACs e usuários por marcadores', () => {
  const { text, replaced } = anonymize(RAW, { sshHost: 'maria@casa-nas' });
  assert.doesNotMatch(text, /casa-nas/);
  assert.doesNotMatch(text, /10\.0\.0\.42/);
  assert.doesNotMatch(text, /aa:bb:cc:dd:ee:ff/i);
  assert.doesNotMatch(text, /\bmaria\b/);
  assert.match(text, /^servidor-exemplo$/m);
  assert.match(text, /192\.0\.2\.1/);
  assert.match(text, /02:00:00:00:00:01/);
  assert.ok(replaced >= 4);
});

test('anonymize preserva o que o parser precisa (seções, métricas, dispositivos, root)', () => {
  const { text } = anonymize(RAW, { sshHost: 'casa-nas' });
  for (const marker of ['===HOST===', '===NET===', '===PS===', 'enp3s0: 1000', 'Debian GNU/Linux 13']) {
    assert.ok(text.includes(marker), `sumiu: ${marker}`);
  }
  assert.match(text, /^root\s+1\s/m);
  assert.equal(text.split('\n').length, RAW.split('\n').length);
});

test('anonymize é estável: o mesmo valor vira sempre o mesmo marcador', () => {
  const { text } = anonymize(RAW, { sshHost: 'casa-nas' });
  const users = text.split('\n').filter((l) => /^usuario\d/.test(l)).map((l) => l.split(/\s+/)[0]);
  assert.deepEqual(users, ['usuario1', 'usuario1']);
});

test('anonymize mantém 127.0.0.1', () => {
  const { text } = anonymize('===HOST===\nx\n===PS===\nUSER\nroot 1 0 0 0 0 ? S 0 0 nc 127.0.0.1');
  assert.match(text, /127\.0\.0\.1/);
});
