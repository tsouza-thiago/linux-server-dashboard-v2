// Autocomplete do bash (F5, ADR 0029): o comportamento de scripts/completar.bash, com
// COMP_WORDS simulado num bash de verdade; a sincronia dele com o código; e a instalação do
// link e do bloco no ~/.bashrc. Tudo numa pasta pessoal temporária: nada toca a sua.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_NAMES } from '../../server/cli/index.js';
import { parseFlags } from '../../server/cli/instalar.js';
import { makeOutput, mostrarComando } from '../../server/cli/saida.js';
import {
  criarAutocomplete, editarArquivoDeLogin, prepararComando, removerAutocomplete, removerBlocoDoLogin,
  situacaoDoAutocomplete, situacaoDoComando, situacaoDoPath,
} from '../../server/setup/local.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'completar.bash');
const fonte = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function casa(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-tab-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Roda _dashboard num bash limpo, como se o Tab viesse depois das palavras dadas. */
function completar(palavras, { home = os.tmpdir(), cwd = ROOT } = {}) {
  const lista = palavras.map((p) => `'${p}'`).join(' ');
  const code = `source "$1"; COMP_WORDS=(${lista}); COMP_CWORD=${palavras.length - 1}; _dashboard; printf '%s\\n' "\${COMPREPLY[@]}"`;
  const r = spawnSync('bash', ['--noprofile', '--norc', '-c', code, 'bash', SCRIPT], { cwd, env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout.split('\n').filter(Boolean);
}

// ---------------- comportamento ----------------

test('completar: 1ª palavra são os comandos, com o prefixo digitado', () => {
  assert.deepEqual(completar(['dashboard', 'atu']), ['atualizar']);
  assert.deepEqual(completar(['./dashboard', 'de']), ['desinstalar']);
  assert.ok(!completar(['dashboard', '']).includes('help'), 'sem os apelidos');
});

test('completar: depois do comando, só as opções dele', () => {
  assert.deepEqual(completar(['dashboard', 'atualizar', '--']), ['--pre']);
  assert.deepEqual(completar(['dashboard', 'desinstalar', '--a']), ['--apagar-historico']);
  assert.ok(completar(['dashboard', 'instalar', '--sem-interface', '--sem-']).includes('--sem-link'));
  assert.deepEqual(completar(['dashboard', 'reconfigurar', '--ter']), ['--terminal']);
  assert.deepEqual(completar(['dashboard', 'status', '--']), []);
});

test('completar: --pos-atualizacao é interna e não aparece', () => {
  assert.ok(!completar(['dashboard', 'atualizar', '']).includes('--pos-atualizacao'));
});

test('completar: --modo só oferece manual', () => {
  assert.deepEqual(completar(['dashboard', 'instalar', '--modo', '']), ['manual']);
  assert.deepEqual(completar(['dashboard', 'instalar', '--modo', 'x']), []);
});

test('completar: --importar-v1 oferece pastas, não arquivos', (t) => {
  const home = casa(t);
  fs.mkdirSync(path.join(home, 'painel antigo'));
  fs.writeFileSync(path.join(home, 'painel.txt'), '');
  assert.deepEqual(completar(['dashboard', 'instalar', '--importar-v1', 'pai'], { cwd: home }), ['painel antigo']);
});

test('completar: --chave-ssh lê os apelidos do ~/.ssh/config, sem curingas', (t) => {
  const home = casa(t);
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'config'), [
    '# Host comentado', 'Host casa nas.local # e um comentário', 'host Minusculo', 'HOST=igual',
    'Host *', 'Host web-? !fora', 'Host "aspas com espaco"', 'Host -opcao', '  HostName 192.0.2.10', '  User maria', 'Host ultimo-sem-fim-de-linha',
  ].join('\n'));
  const o = { home };
  assert.deepEqual(completar(['dashboard', 'instalar', '--chave-ssh', ''], o), ['casa', 'nas.local', 'Minusculo', 'igual', 'ultimo-sem-fim-de-linha']);
  assert.deepEqual(completar(['dashboard', 'desinstalar', '--chave-ssh', 'ca'], o), ['casa']);
});

test('completar: sem ~/.ssh/config, --chave-ssh não sugere nada', (t) => {
  assert.deepEqual(completar(['dashboard', 'instalar', '--chave-ssh', ''], { home: casa(t) }), []);
});

test('completar: nada do ~/.ssh/config é executado nem colado na linha', (t) => {
  const home = casa(t);
  const marca = path.join(home, 'rodou');
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'config'), `Host $(touch${'${IFS}'}${marca}) \`touch${'${IFS}'}${marca}\` a;b segura\n`);
  assert.deepEqual(completar(['dashboard', 'instalar', '--chave-ssh', ''], { home }), ['segura']);
  assert.equal(fs.existsSync(marca), false);
});

// ---------------- sincronia com o código ----------------

// Os nomes `--x` que o trecho lê de `flags`, mais os limiares do laço do sem-interface.
function opcoesLidas(...arquivos) {
  const nomes = new Set();
  for (const f of arquivos) {
    const texto = fonte(f);
    for (const [, n] of texto.matchAll(/flags\['([a-z0-9-]+)'\]/g)) nomes.add(n);
    for (const [, n] of texto.matchAll(/flags\.([a-z]+)/g)) nomes.add(n);
    for (const [, n] of texto.matchAll(/\['[a-zA-Z]+', '([a-z]+)'\]/g)) nomes.add(n);
  }
  nomes.delete('help'); // sinônimo de --ajuda, fora da lista de propósito
  nomes.delete('pos-atualizacao'); // interna
  return [...nomes].map((n) => `--${n}`).sort();
}

const opcoesDe = (comando) => completar(['dashboard', comando, '--']).sort();

test('sincronia: os comandos são os do código', () => {
  assert.deepEqual(completar(['dashboard', '']).sort(), [...COMMAND_NAMES].sort());
});

test('sincronia: instalar e reconfigurar oferecem toda opção que o código lê', () => {
  const lidas = opcoesLidas('server/cli/instalar.js', 'server/setup/sem-interface.js');
  assert.deepEqual(opcoesDe('instalar'), lidas);
  assert.deepEqual(opcoesDe('reconfigurar'), lidas);
});

test('sincronia: desinstalar e atualizar oferecem toda opção que o código lê', () => {
  assert.deepEqual(opcoesDe('desinstalar'), opcoesLidas('server/cli/desinstalar.js'));
  assert.deepEqual(opcoesDe('atualizar'), opcoesLidas('server/cli/atualizar.js'));
});

test('sincronia: opção que recebe valor não sugere outra opção no lugar dele', () => {
  const opcoes = new Set(opcoesDe('instalar'));
  for (const opcao of opcoes) {
    const nome = opcao.slice(2);
    const recebeValor = parseFlags([opcao, 'valor'])[nome] === 'valor';
    const sugere = completar(['dashboard', 'instalar', opcao, '']).filter((s) => opcoes.has(s));
    assert.deepEqual(sugere.length > 0, !recebeValor, opcao);
  }
});

test('sincronia: scripts/check.mjs e scripts/seguranca.mjs conferem o arquivo', () => {
  for (const f of ['scripts/check.mjs', 'scripts/seguranca.mjs']) assert.match(fonte(f), /SHELL_SCRIPTS = \[.*'scripts\/completar\.bash'/);
});

// ---------------- instalação ----------------

/** Pasta pessoal e pasta do painel, temporárias. `pacote`: a lista com o bash-completion. */
function cenario(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-tab-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'casa');
  fs.mkdirSync(home);
  const painel = (nome) => {
    const root = path.join(base, nome);
    fs.mkdirSync(path.join(root, 'server', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'server', 'cli', 'index.js'), '');
    fs.writeFileSync(path.join(root, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'scripts', 'completar.bash'), '# teste\n');
    return root;
  };
  const pacote = path.join(base, 'bash_completion');
  fs.writeFileSync(pacote, '');
  const link = path.join(home, '.local', 'share', 'bash-completion', 'completions', 'dashboard');
  return { base, home, painel, root: painel('painel'), link, comPacote: [pacote], semPacote: [], env: { PATH: '/usr/bin' }, bashrc: path.join(home, '.bashrc') };
}

const opcoes = (c, extra = {}) => ({ root: c.root, home: c.home, env: c.env, pacotes: c.semPacote, ...extra });

test('instalação: cria o link na pasta do bash-completion, sem editar nada', (t) => {
  const c = cenario(t);
  assert.equal(situacaoDoAutocomplete(opcoes(c)).estado, 'ausente');
  const r = criarAutocomplete(opcoes(c, { pacotes: c.comPacote }));
  assert.equal(r.estado, 'criado');
  assert.equal(r.carrega, true);
  assert.equal(fs.readlinkSync(c.link), path.join(c.root, 'scripts', 'completar.bash'));
  assert.equal(fs.existsSync(c.bashrc), false);
  assert.equal(criarAutocomplete(opcoes(c, { pacotes: c.comPacote })).estado, 'pronto', 'rodar de novo não refaz');
  assert.equal(situacaoDoAutocomplete(opcoes(c)).estado, 'este');
});

test('instalação: respeita BASH_COMPLETION_USER_DIR e XDG_DATA_HOME', (t) => {
  const c = cenario(t);
  const xdg = path.join(c.base, 'xdg');
  const dir = path.join(c.base, 'proprio');
  criarAutocomplete(opcoes(c, { env: { XDG_DATA_HOME: xdg } }));
  assert.ok(fs.lstatSync(path.join(xdg, 'bash-completion', 'completions', 'dashboard')));
  criarAutocomplete(opcoes(c, { env: { XDG_DATA_HOME: xdg, BASH_COMPLETION_USER_DIR: `${dir}:/outra` } }));
  assert.ok(fs.lstatSync(path.join(dir, 'completions', 'dashboard')));
  assert.equal(fs.existsSync(c.link), false);
});

test('instalação: não sobrescreve outro arquivo nem troca outra pasta sem o sim', (t) => {
  const c = cenario(t);
  fs.mkdirSync(path.dirname(c.link), { recursive: true });
  fs.writeFileSync(c.link, 'do usuário');
  assert.equal(criarAutocomplete(opcoes(c, { trocar: true })).estado, 'outro-programa');
  assert.equal(fs.readFileSync(c.link, 'utf8'), 'do usuário');

  fs.rmSync(c.link);
  const outra = c.painel('outra');
  criarAutocomplete(opcoes(c, { root: outra }));
  assert.equal(criarAutocomplete(opcoes(c)).estado, 'outra-pasta');
  assert.equal(fs.realpathSync(c.link), path.join(outra, 'scripts', 'completar.bash'));
  assert.equal(criarAutocomplete(opcoes(c, { trocar: true })).estado, 'trocado');
  assert.equal(fs.realpathSync(c.link), path.join(c.root, 'scripts', 'completar.bash'));
});

test('instalação: sem o pacote e sem o sim, o ~/.bashrc fica como está', (t) => {
  const c = cenario(t);
  const r = criarAutocomplete(opcoes(c));
  assert.equal(r.carrega, false);
  assert.equal(r.linha, 'source "$HOME/.local/share/bash-completion/completions/dashboard"');
  assert.equal(fs.existsSync(c.bashrc), false);
});

test('instalação: com o pacote, o sim não edita o ~/.bashrc', (t) => {
  const c = cenario(t);
  assert.equal(criarAutocomplete(opcoes(c, { pacotes: c.comPacote, editar: true })).edicao, undefined);
  assert.equal(fs.existsSync(c.bashrc), false);
});

test('instalação: sem o pacote, o sim acrescenta o bloco com cópia, e sem duplicar', (t) => {
  const c = cenario(t);
  fs.writeFileSync(c.bashrc, 'alias l=ls');
  const r = criarAutocomplete(opcoes(c, { editar: true }));
  assert.deepEqual(r.edicao, { estado: 'editado', arquivo: '.bashrc', copia: '.bashrc.dashboard-bak' });
  assert.equal(fs.readFileSync(`${c.bashrc}.dashboard-bak`, 'utf8'), 'alias l=ls');
  assert.match(fs.readFileSync(c.bashrc, 'utf8'), /^alias l=ls\n\n# >>> server-dashboard >>>\n.*\n# <<< server-dashboard <<<\n$/);
  assert.equal(situacaoDoAutocomplete(opcoes(c)).carrega, true);
  assert.equal(criarAutocomplete(opcoes(c, { editar: true })).edicao, undefined);
  assert.equal(fs.readFileSync(c.bashrc, 'utf8').match(/>>> server-dashboard >>>/g).length, 1);
});

test('instalação: a linha do source à mão conta; a comentada, não', (t) => {
  const c = cenario(t);
  fs.writeFileSync(c.bashrc, '# source ~/.local/share/bash-completion/completions/dashboard\n');
  assert.equal(situacaoDoAutocomplete(opcoes(c)).carrega, false);
  fs.appendFileSync(c.bashrc, 'source ~/.local/share/bash-completion/completions/dashboard\n');
  assert.equal(situacaoDoAutocomplete(opcoes(c)).carrega, true);
});

test('instalação: ~/.bashrc sem permissão vira estado, não exceção', (t) => {
  const c = cenario(t);
  fs.mkdirSync(c.bashrc);
  assert.equal(criarAutocomplete(opcoes(c, { editar: true })).edicao.estado, 'sem-permissao');
});

test('instalação: o bloco carrega o autocomplete num bash sem o pacote', (t) => {
  const c = cenario(t);
  fs.copyFileSync(SCRIPT, path.join(c.root, 'scripts', 'completar.bash'));
  criarAutocomplete(opcoes(c, { editar: true }));
  const r = spawnSync('bash', ['--noprofile', '--norc', '-c', 'source "$HOME/.bashrc"; complete -p dashboard ./dashboard; echo "[${_dash_c-limpo}]"'], { env: { HOME: c.home, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.match(r.stdout, /complete -F _dashboard dashboard\ncomplete -F _dashboard \.\/dashboard\n\[limpo\]\n/);
});

test('instalação: o bloco do ~/.bashrc não confunde a conferência do PATH', (t) => {
  const c = cenario(t);
  criarAutocomplete(opcoes(c, { editar: true }));
  assert.equal(situacaoDoPath({ home: c.home, env: c.env }).cuidadoPor, null);
  assert.equal(editarArquivoDeLogin({ home: c.home, env: c.env }).estado, 'editado');
});

test('prepararComando: cria o link junto, mas nunca para outro programa', (t) => {
  const c = cenario(t);
  const r = prepararComando(opcoes(c, { pacotes: c.comPacote }));
  assert.equal(r.autocomplete.estado, 'criado');
  assert.equal(fs.existsSync(c.link), true);

  const d = cenario(t);
  fs.mkdirSync(path.join(d.home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d.home, '.local', 'bin', 'dashboard'), 'outro');
  assert.equal(prepararComando(opcoes(d, { pacotes: d.comPacote })).autocomplete, undefined);
  assert.equal(fs.existsSync(d.link), false);
});

test('prepararComando: editar e editarBashrc são respostas separadas', (t) => {
  const c = cenario(t);
  prepararComando(opcoes(c, { editar: true }));
  assert.equal(fs.existsSync(c.bashrc), false, 'o sim do PATH não vale para o ~/.bashrc');
  const d = cenario(t);
  prepararComando(opcoes(d, { editarBashrc: true }));
  assert.match(fs.readFileSync(d.bashrc, 'utf8'), /server-dashboard/);
  assert.equal(fs.existsSync(path.join(d.home, '.profile')), false, 'o sim do ~/.bashrc não vale para o PATH');
});

test('situacaoDoComando: pede o ~/.bashrc só quando ele resolve', (t) => {
  const c = cenario(t);
  const s = (extra) => situacaoDoComando(opcoes(c, extra)).pedeBashrc;
  assert.equal(s(), true);
  assert.equal(s({ pacotes: c.comPacote }), false, 'o pacote já carrega');
  assert.equal(s({ semLink: true }), false);
  fs.mkdirSync(path.dirname(c.link), { recursive: true });
  fs.writeFileSync(c.link, 'do usuário');
  assert.equal(s(), false, 'o link não pode ser criado');
  fs.rmSync(c.link);
  fs.writeFileSync(c.bashrc, 'source ~/.local/share/bash-completion/completions/dashboard\n');
  assert.equal(s(), false, 'o ~/.bashrc já carrega');
});

function memOut() {
  const linhas = [];
  return { out: makeOutput({ stream: { write: (t) => linhas.push(t) }, env: {} }), texto: () => linhas.join('\n') };
}

test('mostrarComando: conta o que houve com o autocomplete', (t) => {
  const c = cenario(t);
  const mostra = (a) => {
    const m = memOut();
    mostrarComando(m.out, { nome: 'n', estado: 'criado', noPath: true, autocomplete: a });
    return m.texto();
  };
  assert.match(mostra(criarAutocomplete(opcoes(c, { pacotes: c.comPacote }))), /✓ autocomplete com Tab pronto/);
  assert.match(mostra({ estado: 'pronto', carrega: false, linha: 'source "x"' }), /▲ falta o pacote bash-completion.*source "x"/);
  assert.match(mostra({ estado: 'pronto', carrega: false, edicao: { estado: 'editado', arquivo: '.bashrc', copia: null } }), /✓ autocomplete com Tab acrescentado em ~\/\.bashrc/);
  assert.match(mostra({ estado: 'outro-programa', nome: 'n' }), /▲ o autocomplete não foi criado/);
  assert.match(mostra({ estado: 'outra-pasta', alvo: '/x' }), /continua na outra pasta: \/x/);
  assert.match(mostra({ estado: 'falhou', nome: 'n' }), /▲ não consegui criar o autocomplete/);
});

test('remoção: tira só o link desta pasta', (t) => {
  const c = cenario(t);
  const outra = c.painel('outra');
  criarAutocomplete(opcoes(c, { root: outra }));
  assert.equal(removerAutocomplete(opcoes(c)).removido, false);
  assert.ok(fs.lstatSync(c.link), 'o da outra pasta fica');
  assert.equal(removerAutocomplete(opcoes(c, { root: outra })).removido, true);
  assert.equal(fs.existsSync(c.link), false);
});

test('remoção: tira só o bloco do ~/.bashrc', (t) => {
  const c = cenario(t);
  fs.writeFileSync(c.bashrc, 'alias l=ls\n');
  criarAutocomplete(opcoes(c, { editar: true }));
  assert.deepEqual(removerBlocoDoLogin({ home: c.home }).removidos, ['.bashrc']);
  assert.equal(fs.readFileSync(c.bashrc, 'utf8'), 'alias l=ls\n');
});
