// Vários computadores no mesmo servidor (#60, ADR 0020): cada instalação troca só a sua
// linha do authorized_keys e o seu arquivo do sudoers. Os scripts de verdade rodam no
// servidor simulado (test-support/servidor-simulado.js), então o teste confere o que o shell
// deixa nos arquivos, não só o texto dos comandos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationPlan, removalScript, remainingLines, sudoersFile } from '../../server/setup/preparo.js';
import { authorizedKeysLine, installId, machineLabel, validLabel } from '../../server/setup/acesso.js';
import { simulatedServer } from '../../test-support/servidor-simulado.js';

// Chaves de mentira com base64 válido (o ID sai do SHA-256 dos bytes da chave).
const key = (c) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${c.repeat(43)}`;
const A = key('A');
const B = key('B');
const OLD = key('C');
const TARGETS = { mounts: ['/'], devs: ['sda', 'sdb'], services: ['smbd'], netIf: '' };
const plan = (publicKey, computer, smartDevs = ['sda']) => preparationPlan({ adminUser: 'maria', publicKey, computer, targets: TARGETS, smartDevs, from: '192.0.2.50' });

/** Roda e confere que o script terminou; devolve a saída. */
function ok(srv, script) {
  const r = srv.run(script);
  assert.equal(r.status, 0, `${r.stderr}\n${script.slice(0, 400)}`);
  return r.stdout;
}

/** Comentário (último campo) de cada linha do authorized_keys. */
const comments = (srv) => srv.keys().map((l) => l.split(' ').pop());

test('nomes da instalação: rótulo saneado e ID da chave (#60)', () => {
  assert.equal(machineLabel('NoteThiago.lan'), 'notethiago-lan', 'ponto vira hífen');
  assert.equal(machineLabel("x'; rm -rf / #"), 'x-rm-rf', 'nada de aspas, espaço ou barra');
  assert.equal(machineLabel('--Ç--'), 'computador', 'vazio depois de sanear');
  assert.equal(machineLabel('a'.repeat(40)).length, 24);
  assert.equal(machineLabel(`${'a'.repeat(23)}-b`), 'a'.repeat(23), 'sem hífen no fim depois de cortar');
  for (const n of ['NoteThiago.lan', "x'; rm -rf / #", '', 'ü.ß', 'a'.repeat(99), '-x-']) assert.ok(validLabel(machineLabel(n)), n);
  assert.match(installId(A), /^[0-9a-f]{8}$/);
  assert.notEqual(installId(A), installId(B));
  assert.throws(() => sudoersFile('nome.com.ponto', installId(A)), /inválido/);
  assert.throws(() => sudoersFile('ok', 'ZZZZZZZZ'), /inválido/);
  assert.throws(() => authorizedKeysLine({ publicKey: A, targets: TARGETS, comment: 'a b' }), /comentário/);
  assert.throws(() => authorizedKeysLine({ publicKey: A, targets: TARGETS, comment: 'x"\ncommand="sh' }), /comentário/);
});

test('preparo: um computador não apaga a linha nem o SMART do outro (#60)', (t) => {
  const srv = simulatedServer();
  t.after(srv.stop);
  // Como a 2.1.0 deixou o servidor: 1 linha sem ID e a regra de sudo única.
  srv.writeKeys([authorizedKeysLine({ publicKey: OLD, targets: TARGETS }).line]);
  srv.run("printf 'dashmon ALL=(root) NOPASSWD: /usr/sbin/smartctl -H /dev/sda\\n' > /etc/sudoers.d/dashboard");
  const [a, b, old] = [installId(A), installId(B), installId(OLD)];

  ok(srv, plan(A, 'note-a').rootScript);
  assert.deepEqual(comments(srv), ['server-dashboard', `dashboard@note-a:${a}`], 'a linha antiga fica');
  assert.deepEqual(srv.sudoers(), ['dashboard', `dashboard-note-a-${a}`], 'a regra antiga fica: o outro computador ainda depende dela');

  ok(srv, plan(B, 'Note B.lan', []).rootScript);
  assert.deepEqual(comments(srv), ['server-dashboard', `dashboard@note-a:${a}`, `dashboard@note-b-lan:${b}`]);
  assert.deepEqual(srv.sudoers(), ['dashboard', `dashboard-note-a-${a}`], 'sem SMART em B: a regra de A continua');

  // A reinstala com outro nome e mais discos: troca só a própria linha e o próprio arquivo.
  ok(srv, plan(A, 'note-a2', ['sda', 'sdb']).rootScript);
  assert.deepEqual(comments(srv), ['server-dashboard', `dashboard@note-b-lan:${b}`, `dashboard@note-a2:${a}`]);
  assert.deepEqual(srv.sudoers(), ['dashboard', `dashboard-note-a2-${a}`]);

  // O computador da 2.1.0 reconfigura com a mesma chave: a linha antiga vira a nova e a
  // regra única sai, porque ninguém mais depende dela.
  ok(srv, plan(OLD, 'velho').rootScript);
  assert.deepEqual(comments(srv), [`dashboard@note-b-lan:${b}`, `dashboard@note-a2:${a}`, `dashboard@velho:${old}`]);
  assert.deepEqual(srv.sudoers(), [`dashboard-note-a2-${a}`, `dashboard-velho-${old}`]);
  assert.equal(new Set(srv.keys()).size, 3, 'reinstalar não duplica');

  // Desinstalar tira só a parte de cada um; o usuário sai com a última linha.
  assert.equal(remainingLines(ok(srv, removalScript({ publicKey: A }))), 2);
  assert.deepEqual(comments(srv), [`dashboard@note-b-lan:${b}`, `dashboard@velho:${old}`]);
  assert.deepEqual(srv.sudoers(), [`dashboard-velho-${old}`]);
  assert.equal(srv.hasUser(), true);
  assert.equal(remainingLines(ok(srv, removalScript({ publicKey: B }))), 1);
  assert.equal(remainingLines(ok(srv, removalScript({ publicKey: OLD }))), 0);
  assert.equal(srv.hasUser(), false, 'sem nenhuma linha, o dashmon sai');
  assert.deepEqual(srv.sudoers(), []);
  assert.equal(remainingLines(ok(srv, removalScript({ publicKey: A }))), 0, 'rodar de novo não falha');
});

test('preparo: modo manual deixa o servidor igual ao assistido (#60)', (t) => {
  const auto = simulatedServer({ usuario: false });
  const manual = simulatedServer({ usuario: false });
  t.after(() => { auto.stop(); manual.stop(); });
  for (const [pub, name] of [[A, 'note-a'], [B, 'note-b'], [A, 'note-a']]) {
    const p = plan(pub, name);
    ok(auto, p.rootScript);
    for (const b of p.manualBlocks) ok(manual, b.codigo);
  }
  assert.deepEqual(manual.keys(), auto.keys());
  assert.deepEqual(manual.sudoers(), auto.sudoers());
  assert.equal(auto.keys().length, 2);
});

test('preparo: só a linha do mesmo ID ou da mesma chave sai, nunca uma parecida (#60)', (t) => {
  const srv = simulatedServer();
  t.after(srv.stop);
  const a = installId(A);
  // Linhas de fora do painel e uma com o ID de A no meio (não no fim) ficam.
  srv.writeKeys([
    `ssh-ed25519 ${'D'.repeat(68)} pessoa@outro`,
    `restrict,command="echo dashboard@x:${a} fim" ${key('E')} dashboard@x:00000000`,
  ]);
  ok(srv, plan(A, 'note-a').rootScript);
  assert.equal(srv.keys().length, 3);
  assert.equal(comments(srv)[2], `dashboard@note-a:${a}`);
});
