// TUI reserva e modo sem interface (F7): os mesmos passos do assistente, dirigidos por
// teclas num terminal falso e por opções, com servidor/ssh/systemd falsos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runTui, Screen } from '../../server/setup/tui.js';
import { runHeadless, HEADLESS_HELP } from '../../server/setup/sem-interface.js';
import { makeOutput } from '../../server/cli/saida.js';
import { makeInstalacao } from '../../test-support/instalacao-fake.js';

function memOut() {
  const chunks = [];
  const out = makeOutput({ stream: { isTTY: false, write: (s) => { chunks.push(s); return true; } }, env: {} });
  return { out, text: () => chunks.join('') };
}

/** Terminal falso: as teclas entram em fila, na ordem em que a pessoa apertaria. */
function terminal() {
  const input = new EventEmitter();
  const screens = [];
  const output = { write: (s) => { screens.push(s); return true; } };
  const keys = (...seq) => {
    for (const k of seq) {
      if (k === 'Enter') input.emit('keypress', '\r', { name: 'return' });
      else if (k === 'Esc') input.emit('keypress', '\x1b', { name: 'escape' });
      else if (['up', 'down', 'tab', 'space', 'backspace'].includes(k)) input.emit('keypress', k === 'space' ? ' ' : '', { name: k });
      else if (k === 'CtrlC') input.emit('keypress', '\x03', { name: 'c', ctrl: true });
      else for (const ch of k) input.emit('keypress', ch, { name: ch, sequence: ch });
    }
  };
  return { input, output, screens, keys, last: () => screens.at(-1) || '' };
}

test('TUI: os 6 passos no terminal até o painel ligado, sem cores', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const term = terminal();
  const o = memOut();
  // A TUI começa a escutar o teclado assim que é chamada; as teclas vêm depois.
  const running = runTui({ out: o.out, inst: fake.inst, input: term.input, output: term.output });
  term.keys(
    'Enter', // 1 boas-vindas
    '192.0.2.10', 'Enter', 'maria', 'Enter', 'Enter', // 2 servidor (porta 22 padrão)
    's', 'certa', 'Enter', // 3 identidade confirmada + senha
    'Enter', 'Enter', // 4 recomendado + resumo
    'Enter', 'Enter', // 5 assistido + "Continuar"
    't', 'Enter', // 6 token + concluir
  );
  const code = await running;
  assert.equal(code, 0, o.text());
  const all = term.screens.join('');
  assert.match(all, /╭─ Server Dashboard · configuração inicial/);
  assert.match(all, /✓ Boas-vindas {2}✓ Servidor {2}✓ Conectar {2}● 4 O que monitorar/);
  assert.match(all, /\[ 8oOm \] \[ 2IqG \]/);
  assert.match(all, /Senha de maria no servidor: •••••/);
  assert.match(all, /❯ \[x\] \/ +sda/);
  assert.match(all, /\[x\] SMART/);
  assert.match(all, /\(•\) enp3s0/);
  assert.match(all, /command="…coleta v2 · [0-9a-f]{6}…"/);
  assert.match(all, /Servidor pronto\./);
  assert.doesNotMatch(all, /\x1b\[3\dm/, 'sem cores fora de um terminal colorido');
  assert.match(o.text(), /✓ configuração concluída/);
  assert.match(o.text(), /Token de reserva \(aparece só agora\): \S{40,}/);
  assert.match(o.text(), /http:\/\/127\.0\.0\.1:3999\/entrar\?codigo=/);
  assert.equal(fake.inst.temSenha, false);
  assert.equal(fake.services[0].enable, true);
});

test('TUI: Esc volta um passo, erro aparece na tela e Ctrl+C cancela sem gravar', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const term = terminal();
  const o = memOut();
  const running = runTui({ out: o.out, inst: fake.inst, input: term.input, output: term.output });
  term.keys('Enter', '192.0.2.99', 'Enter', 'maria', 'Enter', 'Enter');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(term.last(), /✗ Ninguém respondeu nesse endereço/);
  term.keys('Esc');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(term.last(), /Vamos ligar o painel ao seu servidor/);
  term.keys('CtrlC');
  assert.equal(await running, 1);
  assert.match(o.text(), /▲ configuração cancelada/);
});

test('TUI: modo manual testa bloco por bloco; sem terminal interativo, explica', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const term = terminal();
  const o = memOut();
  const running = runTui({ out: o.out, inst: fake.inst, input: term.input, output: term.output });
  term.keys('Enter', '192.0.2.10', 'Enter', 'maria', 'Enter', 'Enter', 's', 'certa', 'Enter', 'Enter', 'Enter');
  // passo 5: desce até "Prefiro fazer à mão", marca e confirma
  term.keys('down', 'space', 'Enter');
  await new Promise((r) => setTimeout(r, 80));
  assert.match(term.last(), /Preparar o servidor à mão · Criar o usuário dashmon/);
  assert.match(term.last(), /sudo id dashmon/);
  term.keys('Enter');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(term.last(), /▲ O usuário dashmon ainda não existe/);
  fake.srv.dashmon = true;
  term.keys('Enter', 'Enter', 'Enter', 'Enter', 'Enter');
  term.keys('Enter');
  assert.equal(await running, 0, o.text());

  const notty = memOut();
  const stdinLike = process.stdin;
  if (!stdinLike.isTTY) {
    assert.equal(await runTui({ out: notty.out, inst: fake.inst }), 2);
    assert.match(notty.text(), /--sem-interface/);
  }
});

test('TUI: formulário com Tab, números e cores num terminal colorido', async () => {
  const term = terminal();
  const sc = new Screen({ input: term.input, output: term.output, color: true });
  const state = { a: false, n: 90 };
  const done = sc.form({
    title: 'teste',
    groups: [
      { label: 'G1', rows: [{ type: 'check', label: 'a', get: () => state.a, toggle: () => { state.a = !state.a; } }] },
      { label: 'G2', rows: [{ type: 'number', label: 'n', unit: '%', get: () => state.n, type_: (d) => { state.n = Number(`${state.n}${d}`.slice(-3)); }, back: () => { state.n = Number(String(state.n).slice(0, -1)); } }] },
    ],
  });
  term.keys('space', 'tab', 'backspace', 'backspace', '8', '5', 'Enter');
  assert.equal(await done, true);
  assert.deepEqual(state, { a: true, n: 85 });
  assert.match(term.screens.join(''), /\x1b\[36m❯/);
  sc.close();
});

test('sem interface: exige identidade conferida, lê a senha do stdin e conclui', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const help = memOut();
  assert.equal(await runHeadless({ out: help.out, inst: fake.inst, flags: { ajuda: true } }), 0);
  assert.match(help.text(), /--identidade <SHA256:…>/);
  assert.ok(HEADLESS_HELP.includes('--senha-stdin'));
  const a = memOut();
  assert.equal(await runHeadless({ out: a.out, inst: fake.inst, flags: { servidor: '192.0.2.10', usuario: 'maria' } }), 2);
  assert.match(a.text(), /falta --identidade/);
  const b = memOut();
  assert.equal(await runHeadless({ out: b.out, inst: fake.inst, flags: { servidor: '192.0.2.10', usuario: 'maria', identidade: 'SHA256:outra' } }), 2);
  assert.match(b.text(), /não a informada/);
  const c = memOut();
  const code = await runHeadless({
    out: c.out, inst: fake.inst, stdin: Readable.from(['certa\n']),
    flags: { servidor: '192.0.2.10', usuario: 'maria', identidade: 'SHA256:8oOm2IqGGSLMQ94IC6SBJJ/EIGqCSF6BhAsYUkBWlXw', 'senha-stdin': true, smart: 'sda', rede: 'nenhuma', servicos: 'smbd', disco: '85', 'sem-atalho': true },
  });
  assert.equal(code, 0, c.text());
  assert.match(c.text(), /✓ identidade do servidor confere/);
  assert.match(c.text(), /SMART sda · rede — · serviços smbd/);
  assert.match(c.text(), /✓ servidor preparado \(usuário dashmon · chave restrita · sudo só para smartctl -H\)/);
  assert.match(c.text(), /link de entrada \(uso único, 2 min\): http:\/\/127\.0\.0\.1:3999\/entrar\?codigo=/);
});

test('sem interface: modo manual mostra os blocos; --ja-preparado testa e conclui', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const base = { servidor: '192.0.2.10', usuario: 'maria', identidade: 'SHA256:8oOm2IqGGSLMQ94IC6SBJJ/EIGqCSF6BhAsYUkBWlXw' };
  const m = memOut();
  assert.equal(await runHeadless({ out: m.out, inst: fake.inst, flags: { ...base, modo: 'manual', 'sem-origem': true } }), 3);
  assert.match(m.text(), /# Criar o usuário dashmon/);
  assert.match(m.text(), /restrict,command=/, 'sem from= com --sem-origem');
  const fake2 = makeInstalacao();
  t.after(fake2.cleanup);
  fake2.srv.dashmon = true;
  const r = memOut();
  assert.equal(await runHeadless({ out: r.out, inst: fake2.inst, flags: { ...base, 'ja-preparado': true } }), 0, r.text());
  assert.match(r.text(), /✓ Pronto no servidor \(conferido\)/);
  const fake3 = makeInstalacao({ sudoOk: false });
  t.after(fake3.cleanup);
  const e = memOut();
  assert.equal(await runHeadless({ out: e.out, inst: fake3.inst, flags: { ...base } }), 2);
  assert.match(e.text(), /recusou a senha|precisa da senha|sudo/);
});
