// TUI reserva e modo sem interface: os mesmos passos do assistente, dirigidos por
// teclas num terminal falso e por opções, com servidor/ssh/systemd falsos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runTui, Screen } from '../../server/setup/tui.js';
import { runHeadless, HEADLESS_HELP } from '../../server/setup/sem-interface.js';
import { makeOutput } from '../../server/cli/saida.js';
import { makeInstalacao, detectionWithSudo } from '../../test-support/instalacao-fake.js';
import { esperarAte } from '../../test-support/esperar.js';
import { loadEnvFile } from '../../server/config.js';
import fs from 'node:fs';
import path from 'node:path';

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
    'Enter', // 2 entra com senha (o padrão)
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

test('TUI: desmarcar "Iniciar com o computador" vale (o serviço não é habilitado)', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const term = terminal();
  const o = memOut();
  const running = runTui({ out: o.out, inst: fake.inst, input: term.input, output: term.output });
  term.keys(
    'Enter', 'Enter', '192.0.2.10', 'Enter', 'maria', 'Enter', 'Enter', 's', 'certa', 'Enter',
    'Enter', 'Enter', 'Enter', 'Enter',
    'space', 'Enter', // 6: desmarca a 1ª caixa (iniciar com o computador) e conclui
  );
  assert.equal(await running, 0, o.text());
  assert.match(term.screens.join(''), /\[ \] Iniciar com o computador/);
  // Sem a unidade instalada e sem "iniciar com o computador", o painel sobe em segundo
  // plano: nenhum serviço é instalado (antes, a TUI ignorava a escolha e habilitava).
  assert.deepEqual(fake.services, []);
  assert.match(o.text(), /painel rodando em segundo plano/);
});

test('TUI: passo 6 oferece o comando no PATH e o arquivo de login só muda com o sim', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const term = terminal();
  const o = memOut();
  const running = runTui({ out: o.out, inst: fake.inst, input: term.input, output: term.output });
  term.keys(
    'Enter', 'Enter', '192.0.2.10', 'Enter', 'maria', 'Enter', 'Enter', 's', 'certa', 'Enter',
    'Enter', 'Enter', 'Enter', 'Enter',
    'down', 'down', 'down', 'space', 'Enter', // 6: marca a 4ª caixa (pôr no PATH) e conclui
  );
  assert.equal(await running, 0, o.text());
  const telas = term.screens.join('');
  assert.match(telas, /\[x\] Comando dashboard no terminal \(roda de qualquer pasta, sem o \.\/\)/);
  assert.match(telas, /\[x\] Pôr ~\/\.local\/bin no PATH/);
  assert.match(fs.readFileSync(path.join(fake.home, '.profile'), 'utf8'), /server-dashboard/);
  assert.match(o.text(), /✓ comando dashboard pronto/);
  assert.match(o.text(), /✓ PATH acrescentado em ~\/\.profile \(arquivo novo\)/);
});

test('TUI: --sem-link deixa a caixa travada e não cria o comando', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  fake.inst.semLink = true;
  const term = terminal();
  const o = memOut();
  const running = runTui({ out: o.out, inst: fake.inst, input: term.input, output: term.output });
  term.keys('Enter', 'Enter', '192.0.2.10', 'Enter', 'maria', 'Enter', 'Enter', 's', 'certa', 'Enter', 'Enter', 'Enter', 'Enter', 'Enter', 'down', 'down', 'space', 'Enter');
  assert.equal(await running, 0, o.text());
  assert.match(term.screens.join(''), /\[ \] Comando dashboard no terminal \(pulado pela opção --sem-link\)/);
  assert.doesNotMatch(term.screens.join(''), /\[x\] Comando dashboard/, 'a caixa travada não muda');
  assert.equal(fs.existsSync(path.join(fake.home, '.local', 'bin', 'dashboard')), false);
  assert.doesNotMatch(o.text(), /comando dashboard/);
});

test('TUI modo chave (#61): apelido conferido, ssh-add quando falta e a senha do sudo à parte', async (t) => {
  const fake = makeInstalacao({ detection: detectionWithSudo('pede-senha') });
  t.after(fake.cleanup);
  fake.srv.agentHasKey = false;
  const term = terminal();
  const o = memOut();
  const running = runTui({ out: o.out, inst: fake.inst, input: term.input, output: term.output });
  term.keys('Enter', 's', 'meu-servidor', 'Enter');
  await esperarAte(() => /O apelido meu-servidor diz:/.test(term.last()));
  assert.match(term.last(), /Chave \(IdentityFile\) +\/home\/maria\/\.ssh\/chave_admin/);
  term.keys('s', 's');
  await esperarAte(() => /ssh-add -t 15m ~\/\.ssh\/chave_admin/.test(term.last()));
  assert.match(term.last(), /a passphrase é digitada lá, nunca aqui/);
  fake.srv.agentHasKey = true;
  term.keys('Enter'); // tentar de novo
  await esperarAte(() => /O que monitorar/.test(term.last()));
  term.keys('Enter', 'Enter', 'Enter');
  await esperarAte(() => /Senha de maria para o sudo/.test(term.last()));
  assert.match(term.last(), /não a passphrase da chave/);
  term.keys('certa', 'Enter', 'Enter', 't', 'Enter');
  assert.equal(await running, 0, o.text());
  const admin = fake.srv.calls.filter((c) => c.kind === 'admin');
  assert.ok(admin.every((c) => c.password === '' && c.identityFile === '/home/maria/.ssh/chave_admin'), 'só a chave do apelido');
  assert.match(admin.at(-1).script, /^P='certa'$/m, 'a senha do sudo foi no script');
});

test('TUI: Esc volta um passo, erro aparece na tela e Ctrl+C cancela sem gravar', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const term = terminal();
  const o = memOut();
  const running = runTui({ out: o.out, inst: fake.inst, input: term.input, output: term.output });
  term.keys('Enter', 'Enter', '192.0.2.99', 'Enter', 'maria', 'Enter', 'Enter');
  await esperarAte(() => /✗ Ninguém respondeu nesse endereço/.test(term.last()));
  assert.match(term.last(), /✗ Ninguém respondeu nesse endereço/);
  term.keys('Esc');
  await esperarAte(() => /Vamos ligar o painel ao seu servidor/.test(term.last()));
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
  term.keys('Enter', 'Enter', '192.0.2.10', 'Enter', 'maria', 'Enter', 'Enter', 's', 'certa', 'Enter', 'Enter', 'Enter');
  // passo 5: desce até "Prefiro fazer à mão", marca e confirma
  term.keys('down', 'space', 'Enter');
  await esperarAte(() => /Preparar o servidor à mão · Criar o usuário dashmon/.test(term.last()));
  assert.match(term.last(), /Preparar o servidor à mão · Criar o usuário dashmon/);
  assert.match(term.last(), /sudo id dashmon/);
  term.keys('Enter');
  await esperarAte(() => /▲ O usuário dashmon ainda não existe/.test(term.last()));
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

test('sem interface: --sem-link pula o comando; --editar-profile é a única edição do arquivo de login', async (t) => {
  const flags = { servidor: '192.0.2.10', usuario: 'maria', identidade: 'SHA256:8oOm2IqGGSLMQ94IC6SBJJ/EIGqCSF6BhAsYUkBWlXw', 'senha-stdin': true };
  const roda = async (extra) => {
    const fake = makeInstalacao();
    t.after(fake.cleanup);
    const o = memOut();
    const code = await runHeadless({ out: o.out, inst: fake.inst, stdin: Readable.from(['certa\n']), flags: { ...flags, ...extra } });
    assert.equal(code, 0, o.text());
    return { ...fake, texto: o.text(), link: path.join(fake.home, '.local', 'bin', 'dashboard'), profile: path.join(fake.home, '.profile') };
  };
  const padrao = await roda({});
  assert.ok(fs.lstatSync(padrao.link));
  assert.equal(fs.existsSync(padrao.profile), false, 'sem perguntas, o padrão é não editar');
  assert.match(padrao.texto, /▲ ~\/\.local\/bin não está no PATH/);
  const semLink = await roda({ 'sem-link': true, 'editar-profile': true });
  assert.equal(fs.existsSync(path.dirname(semLink.link)), false);
  assert.equal(fs.existsSync(semLink.profile), false);
  const editar = await roda({ 'editar-profile': true });
  assert.match(fs.readFileSync(editar.profile, 'utf8'), /server-dashboard/);
  assert.match(HEADLESS_HELP, /--sem-link[\s\S]*--editar-profile/);

  // Sem perguntas, o link de outra pasta fica como está: ninguém disse sim.
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const outra = path.join(fake.home, 'outra');
  fs.mkdirSync(path.join(outra, 'server', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(outra, 'server', 'cli', 'index.js'), '');
  fs.writeFileSync(path.join(outra, 'dashboard'), '#!/bin/sh\n');
  const link = path.join(fake.home, '.local', 'bin', 'dashboard');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(outra, 'dashboard'), link);
  const o = memOut();
  await runHeadless({ out: o.out, inst: fake.inst, stdin: Readable.from(['certa\n']), flags });
  assert.equal(fs.readlinkSync(link), path.join(outra, 'dashboard'));
  assert.match(o.text(), /▲ o comando dashboard continua na outra pasta/);
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

test('sem interface --chave-ssh (#61): apelido, ssh-add quando falta e --senha-stdin vira a senha do sudo', async (t) => {
  const fake = makeInstalacao({ detection: detectionWithSudo('pede-senha') });
  t.after(fake.cleanup);
  const flags = { 'chave-ssh': 'meu-servidor', identidade: 'SHA256:8oOm2IqGGSLMQ94IC6SBJJ/EIGqCSF6BhAsYUkBWlXw', 'senha-stdin': true, smart: 'nenhum', 'sem-atalho': true };
  const salto = memOut();
  assert.equal(await runHeadless({ out: salto.out, inst: fake.inst, flags: { ...flags, 'chave-ssh': 'com-salto' } }), 2);
  assert.match(salto.text(), /ProxyJump/);
  fake.srv.agentHasKey = false;
  const sem = memOut();
  assert.equal(await runHeadless({ out: sem.out, inst: fake.inst, stdin: Readable.from(['certa\n']), flags }), 2);
  assert.match(sem.text(), /rode no seu terminal: ssh-add -t 15m ~\/\.ssh\/chave_admin/);
  fake.srv.agentHasKey = true;
  const ok = memOut();
  assert.equal(await runHeadless({ out: ok.out, inst: fake.inst, stdin: Readable.from(['certa\n']), flags }), 0, ok.text());
  assert.match(ok.text(), /porta 2222 · apelido meu-servidor · usuário maria/);
  const admin = fake.srv.calls.filter((c) => c.kind === 'admin');
  assert.ok(admin.every((c) => c.password === ''), 'a senha lida nunca vai para a conexão SSH');
  assert.match(admin.at(-1).script, /^P='certa'$/m);
  assert.match(HEADLESS_HELP, /--chave-ssh <apelido>/);
});

test('sem interface: sem --disco/--memoria/--temperatura, mantém os limiares do .env', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  fs.writeFileSync(path.join(fake.root, '.env'), 'ALERT_RAM_PCT=80\nALERT_TEMP_C=70\n', { mode: 0o600 });
  const o = memOut();
  const code = await runHeadless({
    out: o.out, inst: fake.inst, stdin: Readable.from(['certa\n']),
    flags: { servidor: '192.0.2.10', usuario: 'maria', identidade: 'SHA256:8oOm2IqGGSLMQ94IC6SBJJ/EIGqCSF6BhAsYUkBWlXw', 'senha-stdin': true, disco: '85', 'sem-atalho': true },
  });
  assert.equal(code, 0, o.text());
  const env = loadEnvFile(path.join(fake.root, '.env'));
  // --disco vence; memória e temperatura ficam como estavam (antes voltavam a 90 e 60).
  assert.deepEqual([env.ALERT_DISK_PCT, env.ALERT_RAM_PCT, env.ALERT_TEMP_C], ['85', '80', '70']);
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
