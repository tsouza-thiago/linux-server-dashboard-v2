// Modo sistema nos subcomandos (F9, etapa 3, ADR 0043): de qual pasta saem o .env e o data/,
// os caminhos do pacote, os comandos que recusam no pacote e a unidade systemd e o atalho do
// pacote. O modo clone continua igual: toda pasta que não é a do código que roda é um clone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, backupsDe, caminhosDoPacote, dataDe, envDe, pastasDaInstalacao, pastasDe } from '../../server/config.js';
import { recusaNoPacote } from '../../server/cli/index.js';
import { desktopEntryText, ensureDataDirs, unitText } from '../../server/setup/local.js';

// Pastas do modo sistema de uma pessoa fictícia, como o lançador as escolhe.
const CODIGO = '/opt/server-dashboard/versoes/v2.6.0';
const sistema = (home = '/home/ana') => pastasDaInstalacao({ ambiente: { SERVER_DASHBOARD_MODO: 'sistema' }, home, codigo: CODIGO });

test('pastasDe: a pasta do código que roda segue o modo; qualquer outra é um clone', () => {
  const pastas = sistema();
  const opcoes = { raiz: CODIGO, pastas };
  assert.equal(pastasDe(CODIGO, opcoes), pastas);
  assert.equal(envDe(CODIGO, opcoes), '/home/ana/.config/server-dashboard/.env');
  assert.equal(dataDe(CODIGO, opcoes), '/home/ana/.local/share/server-dashboard/data');
  assert.equal(backupsDe(CODIGO, opcoes), '/home/ana/.local/share/server-dashboard/.backups');
  // A pasta da V1 a importar, ou a de um teste: .env e data/ dentro dela, como sempre.
  assert.deepEqual(pastasDe('/tmp/outra', opcoes), { modo: 'clone', codigo: '/tmp/outra', config: '/tmp/outra', dados: '/tmp/outra' });
  assert.equal(envDe('/tmp/outra', opcoes), '/tmp/outra/.env');
  assert.equal(dataDe('/tmp/outra', opcoes), '/tmp/outra/data');
});

test('pastasDe: no modo clone (sem o sinal), a pasta do projeto guarda tudo, sem mudança', () => {
  assert.equal(pastasDe(ROOT).modo, 'clone');
  assert.equal(envDe(ROOT), path.join(ROOT, '.env'));
  assert.equal(dataDe(ROOT), path.join(ROOT, 'data'));
  assert.equal(backupsDe(ROOT), path.join(ROOT, '.backups'));
});

test('caminhosDoPacote: o link atual e o lançador saem do layout versoes/; fora dele, /opt', () => {
  assert.deepEqual(caminhosDoPacote('/srv/pacote/versoes/v2.6.0'), {
    base: '/srv/pacote', atual: '/srv/pacote/atual', lancador: '/srv/pacote/bin/dashboard',
  });
  assert.deepEqual(caminhosDoPacote('/home/ana/painel'), {
    base: '/opt/server-dashboard', atual: '/opt/server-dashboard/atual', lancador: '/opt/server-dashboard/bin/dashboard',
  });
});

test('recusaNoPacote: no modo clone, nenhum comando é recusado', () => {
  for (const [nome, args] of [['atualizar', []], ['desinstalar', []], ['reconfigurar', ['--pela-tela']], ['instalar', ['--importar-v1', '/x']]]) {
    assert.equal(recusaNoPacote(nome, args, 'clone'), null, nome);
  }
});

test('recusaNoPacote: no pacote, recusa atualizar, desinstalar, reconfigurar pela tela e importar a V1', () => {
  for (const [nome, args] of [['atualizar', []], ['atualizar', ['--terminal']], ['desinstalar', ['--apagar-historico']], ['reconfigurar', ['--pela-tela']], ['instalar', ['--importar-v1', '/x']]]) {
    const r = recusaNoPacote(nome, args, 'sistema');
    assert.ok(r?.texto && r?.oQueFazer, `${nome} ${args.join(' ')}`);
  }
  // O resto segue: instalação, reconfigurar no terminal, status, abrir, diagnosticar.
  for (const [nome, args] of [['instalar', []], ['instalar', ['--terminal']], ['reconfigurar', []], ['status', []], ['abrir', []], ['diagnosticar', []], ['versao', []]]) {
    assert.equal(recusaNoPacote(nome, args, 'sistema'), null, nome);
  }
});

test('unitText: no pacote, roda pelo link atual, com o sinal e as pastas XDG no ambiente', () => {
  const pastas = sistema();
  const unit = unitText({ root: '/srv/pacote/versoes/v2.6.0', nodeBin: '/srv/pacote/node/bin/node', pastas });
  assert.match(unit, /^WorkingDirectory=\/srv\/pacote\/atual$/m);
  assert.match(unit, /^Environment="SERVER_DASHBOARD_MODO=sistema" "XDG_CONFIG_HOME=\/home\/ana\/\.config" "XDG_DATA_HOME=\/home\/ana\/\.local\/share"$/m);
  assert.match(unit, /^ExecStart="\/srv\/pacote\/node\/bin\/node" .* "\/srv\/pacote\/atual\/server\/index\.js"$/m);
  assert.match(unit, /^ReadWritePaths="\/home\/ana\/\.local\/share\/server-dashboard\/data"$/m);
  // A versão fixa (versoes/v2.6.0) não entra: a versão nova vale no próximo reinício.
  assert.doesNotMatch(unit, /versoes/);
});

test('unitText: no modo clone, nada muda (sem Environment, código e data/ na pasta)', () => {
  const unit = unitText({ root: '/r', nodeBin: '/n' });
  assert.doesNotMatch(unit, /^Environment=/m);
  assert.match(unit, /^WorkingDirectory=\/r$/m);
  assert.match(unit, /^ReadWritePaths="\/r\/data"$/m);
});

test('unitText: quebra de linha numa pasta XDG não vira linha nova na unidade', () => {
  const pastas = { ...sistema(), config: '/home/ana/x\nExecStartPre=/bin/false/server-dashboard' };
  assert.throws(() => unitText({ root: CODIGO, nodeBin: '/usr/bin/node', pastas }), /caminho inválido/);
});

test('desktopEntryText: no pacote, abre pelo lançador e usa o ícone do link atual', () => {
  const texto = desktopEntryText({ root: '/srv/pacote/versoes/v2.6.0', pastas: sistema() });
  assert.match(texto, /^Exec="\/srv\/pacote\/bin\/dashboard" abrir$/m);
  assert.match(texto, /^Icon=\/srv\/pacote\/atual\/public\/icone\.svg$/m);
  assert.match(desktopEntryText({ root: '/r' }), /^Exec="\/r\/dashboard" abrir$/m);
});

test('ensureDataDirs: no pacote, cria as pastas pessoais e o data/ nelas, tudo 0700', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modo-sistema-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pastas = pastasDaInstalacao({ ambiente: { SERVER_DASHBOARD_MODO: 'sistema' }, home, codigo: CODIGO });
  const { data, ssh } = ensureDataDirs(CODIGO, pastas);
  assert.equal(data, path.join(home, '.local', 'share', 'server-dashboard', 'data'));
  for (const dir of [pastas.config, pastas.dados, data, ssh]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
  // Nada na pasta do código.
  assert.ok(!fs.existsSync(CODIGO));
});
