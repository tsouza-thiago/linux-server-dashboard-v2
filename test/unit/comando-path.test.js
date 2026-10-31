// Comando no PATH (F4, ADR 0028): o link ~/.local/bin/dashboard com as conferências de
// conflito, a edição do arquivo de login e como as mensagens citam o comando. Tudo numa
// pasta pessoal temporária: nada toca a sua.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { comandoDashboard, makeOutput, mostrarComando, primeiroNoPath } from '../../server/cli/saida.js';
import {
  LINHA_PATH, criarLinkNoPath, editarArquivoDeLogin, prepararComando, removerBlocoDoLogin, removerLinkDoPath,
  situacaoDoComando, situacaoDoLink, situacaoDoPath,
} from '../../server/setup/local.js';

/** Pasta pessoal e 1 pasta do painel, temporárias; `outra` cria uma 2ª pasta do painel. */
function cenario(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-path-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'casa');
  fs.mkdirSync(home);
  const painel = (nome) => {
    const root = path.join(base, nome);
    fs.mkdirSync(path.join(root, 'server', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server', 'cli', 'index.js'), '');
    fs.writeFileSync(path.join(root, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
    return root;
  };
  const bin = path.join(home, '.local', 'bin');
  return { base, home, bin, link: path.join(bin, 'dashboard'), root: painel('painel'), painel, env: { PATH: '/usr/bin' }, comBin: { PATH: `${bin}:/usr/bin` } };
}

// ---------------- link ----------------

test('link: sem nada no lugar, cria apontando para o caminho absoluto', (t) => {
  const c = cenario(t);
  assert.equal(situacaoDoLink(c).estado, 'ausente');
  assert.equal(criarLinkNoPath({ root: c.root, home: c.home, env: c.env }).estado, 'criado');
  assert.equal(fs.readlinkSync(c.link), path.join(c.root, 'dashboard'));
  assert.ok(path.isAbsolute(fs.readlinkSync(c.link)));
});

test('link: raiz relativa ainda vira caminho absoluto', (t) => {
  const c = cenario(t);
  criarLinkNoPath({ root: path.relative(process.cwd(), c.root), home: c.home, env: c.env });
  assert.equal(fs.readlinkSync(c.link), path.join(c.root, 'dashboard'));
});

test('link: já aponta para esta pasta, nada a fazer', (t) => {
  const c = cenario(t);
  criarLinkNoPath({ root: c.root, home: c.home, env: c.env });
  const antes = fs.lstatSync(c.link).ino;
  assert.equal(criarLinkNoPath({ root: c.root, home: c.home, env: c.env }).estado, 'pronto');
  assert.equal(fs.lstatSync(c.link).ino, antes, 'o link não foi refeito');
});

test('link: aponta para outra pasta do painel, só troca com o sim', (t) => {
  const c = cenario(t);
  const outra = c.painel('outra');
  criarLinkNoPath({ root: outra, home: c.home, env: c.env });
  const r = criarLinkNoPath({ root: c.root, home: c.home, env: c.env });
  assert.deepEqual([r.estado, r.alvo], ['outra-pasta', path.join(fs.realpathSync(outra), 'dashboard')]);
  assert.equal(fs.readlinkSync(c.link), path.join(outra, 'dashboard'), 'sem o sim, fica como está');
  assert.equal(criarLinkNoPath({ root: c.root, home: c.home, env: c.env, trocar: true }).estado, 'trocado');
  assert.equal(fs.readlinkSync(c.link), path.join(c.root, 'dashboard'));
});

test('link: outro programa nunca é sobrescrito, nem com trocar', (t) => {
  const c = cenario(t);
  fs.mkdirSync(c.bin, { recursive: true });
  fs.writeFileSync(c.link, 'meu programa\n', { mode: 0o755 });
  assert.equal(criarLinkNoPath({ root: c.root, home: c.home, env: c.env, trocar: true }).estado, 'outro-programa');
  assert.equal(fs.readFileSync(c.link, 'utf8'), 'meu programa\n');
  fs.rmSync(c.link);
  // Link para outro arquivo, que não é um painel.
  const alheio = path.join(c.base, 'alheio');
  fs.mkdirSync(alheio);
  fs.writeFileSync(path.join(alheio, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(path.join(alheio, 'dashboard'), c.link);
  assert.equal(criarLinkNoPath({ root: c.root, home: c.home, env: c.env, trocar: true }).estado, 'outro-programa');
  assert.equal(fs.readlinkSync(c.link), path.join(alheio, 'dashboard'));
});

test('link: link quebrado de painel é refeito; o de outro nome, não', (t) => {
  const c = cenario(t);
  fs.mkdirSync(c.bin, { recursive: true });
  fs.symlinkSync(path.join(c.base, 'apagada', 'dashboard'), c.link);
  assert.equal(situacaoDoLink(c).estado, 'quebrado');
  assert.equal(criarLinkNoPath({ root: c.root, home: c.home, env: c.env }).estado, 'trocado');
  fs.rmSync(c.link);
  fs.symlinkSync(path.join(c.base, 'apagada', 'outro'), c.link);
  assert.equal(criarLinkNoPath({ root: c.root, home: c.home, env: c.env }).estado, 'outro-programa');
});

test('link: outro dashboard antes no PATH é avisado', (t) => {
  const c = cenario(t);
  const antes = path.join(c.base, 'antes');
  fs.mkdirSync(antes);
  fs.writeFileSync(path.join(antes, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
  const r = criarLinkNoPath({ root: c.root, home: c.home, env: { PATH: `${antes}:${c.bin}` } });
  assert.deepEqual([r.estado, r.outroAntes], ['criado', path.join(antes, 'dashboard')]);
  assert.equal(criarLinkNoPath({ root: c.root, home: c.home, env: c.comBin }).outroAntes, null);
});

test('link: sem poder criar a pasta, não derruba a instalação', (t) => {
  const c = cenario(t);
  fs.writeFileSync(path.join(c.home, '.local'), 'arquivo no lugar da pasta');
  const r = prepararComando({ root: c.root, home: c.home, env: c.env, editar: true });
  assert.equal(r.estado, 'outro-programa');
  assert.equal(r.edicao, undefined);
});

test('removerLinkDoPath: só apaga o link desta pasta', (t) => {
  const c = cenario(t);
  const outra = c.painel('outra');
  criarLinkNoPath({ root: outra, home: c.home, env: c.env });
  assert.deepEqual([removerLinkDoPath(c).removido, removerLinkDoPath(c).estado], [false, 'outra-pasta']);
  assert.ok(fs.lstatSync(c.link));
  criarLinkNoPath({ root: c.root, home: c.home, env: c.env, trocar: true });
  assert.equal(removerLinkDoPath(c).removido, true);
  assert.equal(fs.existsSync(c.link), false);
  assert.ok(fs.existsSync(path.join(c.root, 'dashboard')), 'o script fica');
});

// ---------------- como as mensagens citam o comando ----------------

test('comandoDashboard: `dashboard` só quando esse nome roda esta pasta', (t) => {
  const c = cenario(t);
  const cmd = (env, root = c.root) => comandoDashboard({ root, env });
  assert.equal(cmd(c.comBin), './dashboard', 'sem link');
  criarLinkNoPath({ root: c.root, home: c.home, env: c.env });
  assert.equal(cmd(c.env), './dashboard', 'link fora do PATH');
  assert.equal(cmd(c.comBin), 'dashboard');
  assert.equal(cmd(c.comBin, c.painel('outra')), './dashboard', 'o link é de outra pasta');
  const antes = path.join(c.base, 'antes');
  fs.mkdirSync(antes);
  fs.writeFileSync(path.join(antes, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(cmd({ PATH: `${antes}:${c.bin}` }), './dashboard', 'outro programa vem antes');
  assert.equal(primeiroNoPath({ PATH: `:${antes}` }), path.join(antes, 'dashboard'), 'entrada vazia do PATH é ignorada');
});

test('primeiroNoPath: arquivo sem permissão de execução e pasta não contam', (t) => {
  const c = cenario(t);
  const sem = path.join(c.base, 'sem');
  fs.mkdirSync(path.join(sem, 'dashboard'), { recursive: true });
  const leitura = path.join(c.base, 'leitura');
  fs.mkdirSync(leitura);
  fs.writeFileSync(path.join(leitura, 'dashboard'), 'x', { mode: 0o644 });
  assert.equal(primeiroNoPath({ PATH: `${sem}:${leitura}` }), null);
  assert.equal(primeiroNoPath({}), null);
});

test('out.cmd muda quando o link passa a valer', (t) => {
  const c = cenario(t);
  const out = makeOutput({ stream: { write: () => true }, env: c.comBin, root: c.root });
  assert.equal(out.cmd, './dashboard');
  criarLinkNoPath({ root: c.root, home: c.home, env: c.env });
  assert.equal(out.cmd, 'dashboard');
});

// ---------------- arquivo de login ----------------

test('login: escolhe o 1º arquivo que o bash lê; sem nenhum, cria o ~/.profile', (t) => {
  const c = cenario(t);
  const e = () => editarArquivoDeLogin({ home: c.home, env: c.env });
  assert.equal(situacaoDoPath(c).arquivo, '.profile');
  fs.writeFileSync(path.join(c.home, '.profile'), '');
  fs.writeFileSync(path.join(c.home, '.bash_login'), 'b\n');
  assert.equal(situacaoDoPath(c).arquivo, '.bash_login');
  fs.writeFileSync(path.join(c.home, '.bash_profile'), 'a\n');
  assert.equal(situacaoDoPath(c).arquivo, '.bash_profile');
  assert.deepEqual(e(), { estado: 'editado', arquivo: '.bash_profile', copia: '.bash_profile.dashboard-bak' });
  assert.equal(fs.readFileSync(path.join(c.home, '.bash_login'), 'utf8'), 'b\n', 'o bash não leria este');

  const d = cenario(t);
  assert.deepEqual(editarArquivoDeLogin({ home: d.home, env: d.env }), { estado: 'editado', arquivo: '.profile', copia: null });
  assert.match(fs.readFileSync(path.join(d.home, '.profile'), 'utf8'), /^# >>> server-dashboard >>>\n/);
  assert.equal(fs.existsSync(path.join(d.home, '.profile.dashboard-bak')), false, 'sem arquivo, sem cópia');
});

test('login: cópia feita antes e bloco acrescentado 1 vez só', (t) => {
  const c = cenario(t);
  const file = path.join(c.home, '.profile');
  fs.writeFileSync(file, 'umask 022\n');
  editarArquivoDeLogin({ home: c.home, env: c.env });
  assert.equal(fs.readFileSync(`${file}.dashboard-bak`, 'utf8'), 'umask 022\n');
  const uma = fs.readFileSync(file, 'utf8');
  assert.equal(editarArquivoDeLogin({ home: c.home, env: c.env }).estado, 'ja-cuidado');
  assert.equal(fs.readFileSync(file, 'utf8'), uma, 'rodar de novo não duplica');
  assert.equal(uma.match(/>>> server-dashboard >>>/g).length, 1);
});

test('login: remoção tira só o bloco e devolve o arquivo como estava', (t) => {
  const c = cenario(t);
  const file = path.join(c.home, '.profile');
  for (const texto of ['umask 022\nexport A=1\n', 'sem-fim-de-linha\n', '']) {
    fs.writeFileSync(file, texto);
    editarArquivoDeLogin({ home: c.home, env: c.env });
    assert.deepEqual(removerBlocoDoLogin({ home: c.home }), { removidos: ['.profile'], falhas: [] });
    assert.equal(fs.readFileSync(file, 'utf8'), texto);
  }
  assert.deepEqual(removerBlocoDoLogin({ home: c.home }), { removidos: [], falhas: [] }, 'sem bloco, não toca');
});

test('login: o texto em volta do bloco fica intacto na remoção', (t) => {
  const c = cenario(t);
  const file = path.join(c.home, '.profile');
  fs.writeFileSync(file, 'antes\n');
  editarArquivoDeLogin({ home: c.home, env: c.env });
  fs.appendFileSync(file, 'depois\n');
  removerBlocoDoLogin({ home: c.home });
  assert.equal(fs.readFileSync(file, 'utf8'), 'antes\ndepois\n');
});

test('login: arquivo sem escrita não é editado e a tela mostra a linha', { skip: process.getuid?.() === 0 && 'root ignora a permissão' }, (t) => {
  const c = cenario(t);
  const file = path.join(c.home, '.profile');
  fs.writeFileSync(file, 'umask 022\n', { mode: 0o444 });
  assert.equal(editarArquivoDeLogin({ home: c.home, env: c.env }).estado, 'sem-permissao');
  assert.equal(fs.readFileSync(file, 'utf8'), 'umask 022\n');
  const r = prepararComando({ root: c.root, home: c.home, env: c.env, editar: true });
  assert.equal(r.edicao.estado, 'sem-permissao');
  const { out, texto } = saida();
  mostrarComando(out, r);
  assert.ok(texto().includes(`acrescente esta linha no ~/.profile: ${LINHA_PATH}`), texto());
});

test('login: arquivo que já cita $HOME/.local/bin não é editado', (t) => {
  for (const linha of ['PATH="$HOME/.local/bin:$PATH"', 'PATH="${HOME}/.local/bin:$PATH"', 'PATH=~/.local/bin:$PATH']) {
    const c = cenario(t);
    const file = path.join(c.home, '.profile');
    fs.writeFileSync(file, `if true; then\n  ${linha}\nfi\n`);
    assert.equal(editarArquivoDeLogin({ home: c.home, env: c.env }).estado, 'ja-cuidado', linha);
    assert.equal(fs.existsSync(`${file}.dashboard-bak`), false);
  }
  const c = cenario(t);
  fs.writeFileSync(path.join(c.home, '.profile'), `PATH="${c.bin}:$PATH"\n`);
  assert.equal(situacaoDoPath(c).cuidadoPor, '.profile', 'o caminho escrito por extenso também conta');
});

test('login: o .bashrc do Fedora conta; comentário e arquivo que o bash não leria, não', (t) => {
  const c = cenario(t);
  fs.writeFileSync(path.join(c.home, '.bashrc'), 'PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal(situacaoDoPath(c).cuidadoPor, '.bashrc');
  const d = cenario(t);
  fs.writeFileSync(path.join(d.home, '.profile'), '# PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal(situacaoDoPath(d).cuidadoPor, null, 'comentário não põe nada no PATH');
  fs.writeFileSync(path.join(d.home, '.bash_profile'), 'true\n');
  fs.writeFileSync(path.join(d.home, '.profile'), 'PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal(situacaoDoPath(d).cuidadoPor, null, 'com .bash_profile, o bash não lê o .profile');
});

test('login: o bloco funciona no sh e só age se a pasta faltar no PATH', (t) => {
  const c = cenario(t);
  editarArquivoDeLogin({ home: c.home, env: c.env });
  const roda = (PATH) => spawnSync('/bin/sh', ['-c', '. "$HOME/.profile"; . "$HOME/.profile"; printf %s "$PATH"'], { env: { HOME: c.home, PATH }, encoding: 'utf8' }).stdout;
  assert.equal(roda('/usr/bin:/bin'), `${c.bin}:/usr/bin:/bin`, 'lido 2 vezes, entra 1 vez');
  assert.equal(roda(`/usr/bin:${c.bin}:/bin`), `/usr/bin:${c.bin}:/bin`, 'já estava: fica onde está');
});

test('situacaoDoPath: reconhece a pasta no PATH, com barra no fim', (t) => {
  const c = cenario(t);
  assert.equal(situacaoDoPath({ home: c.home, env: { PATH: `/usr/bin:${c.bin}/` } }).noPath, true);
  assert.equal(situacaoDoPath({ home: c.home, env: { PATH: `${c.bin}/sub` } }).noPath, false);
  assert.equal(situacaoDoPath({ home: c.home, env: {} }).noPath, false);
});

// ---------------- instalação e o que as telas mostram ----------------

function saida() {
  const chunks = [];
  const out = makeOutput({ stream: { write: (s) => { chunks.push(s); return true; } }, env: {} });
  return { out, texto: () => chunks.join('') };
}

test('prepararComando: só edita com o sim, e nunca quando o PATH já resolve', (t) => {
  const c = cenario(t);
  const profile = path.join(c.home, '.profile');
  assert.equal(prepararComando({ root: c.root, home: c.home, env: c.env }).edicao, undefined);
  assert.equal(fs.existsSync(profile), false, 'sem o sim, nada muda');
  assert.equal(prepararComando({ root: c.root, home: c.home, env: c.comBin, editar: true }).edicao, undefined);
  assert.equal(fs.existsSync(profile), false, 'a pasta já está no PATH');
  assert.equal(prepararComando({ root: c.root, home: c.home, env: c.env, editar: true }).edicao.estado, 'editado');
  assert.equal(prepararComando({ root: c.root, home: c.home, env: c.env, editar: true }).edicao, undefined, 'o bloco já cuida');
});

test('prepararComando: sem link, não edita o arquivo de login', (t) => {
  const c = cenario(t);
  fs.mkdirSync(c.bin, { recursive: true });
  fs.writeFileSync(c.link, 'outro\n');
  prepararComando({ root: c.root, home: c.home, env: c.env, editar: true });
  assert.equal(fs.existsSync(path.join(c.home, '.profile')), false);
  const d = cenario(t);
  criarLinkNoPath({ root: d.painel('outra'), home: d.home, env: d.env });
  prepararComando({ root: d.root, home: d.home, env: d.env, editar: true });
  assert.equal(fs.existsSync(path.join(d.home, '.profile')), false);
});

test('situacaoDoComando: o que as telas oferecem em cada caso', (t) => {
  const c = cenario(t);
  const s = (extra) => situacaoDoComando({ root: c.root, home: c.home, env: c.env, ...extra });
  assert.deepEqual([s().liga, s().trava, s().pedeEdicao], [true, false, true]);
  const semLink = s({ semLink: true });
  assert.deepEqual([semLink.liga, semLink.trava, semLink.pedeEdicao], [false, true, false]);
  assert.match(semLink.detalhe, /--sem-link/);
  assert.equal(s({ env: c.comBin }).pedeEdicao, false, 'a pasta já está no PATH');
  fs.writeFileSync(path.join(c.home, '.profile'), 'PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal(s().pedeEdicao, false, 'o arquivo de login já cuida');
  fs.rmSync(path.join(c.home, '.profile'));

  const outra = c.painel('outra');
  criarLinkNoPath({ root: outra, home: c.home, env: c.env });
  const o = s();
  assert.deepEqual([o.liga, o.trava], [false, false], 'a pergunta vem desligada e pode ser ligada');
  assert.ok(o.detalhe.includes(fs.realpathSync(outra)));
  criarLinkNoPath({ root: c.root, home: c.home, env: c.env, trocar: true });
  assert.deepEqual([s().liga, s().trava, s().estado], [true, true, 'este']);
  fs.rmSync(c.link);
  fs.writeFileSync(c.link, 'outro\n');
  assert.deepEqual([s().liga, s().trava, s().pedeEdicao], [false, true, false]);
});

test('mostrarComando: explica cada resultado', (t) => {
  const c = cenario(t);
  const fala = (r) => { const s = saida(); mostrarComando(s.out, r); return s.texto(); };
  assert.equal(fala(null), '');
  const base = { nome: '~/.local/bin/dashboard', caminho: c.link, linha: LINHA_PATH, arquivo: '.profile', cuidadoPor: null };
  assert.match(fala({ ...base, estado: 'outro-programa' }), /▲ o comando dashboard não foi criado/);
  assert.match(fala({ ...base, estado: 'outra-pasta', alvo: '/x/dashboard' }), /▲ o comando dashboard continua na outra pasta \(\/x\/dashboard\)/);
  assert.match(fala({ ...base, estado: 'falhou' }), /▲ não consegui criar/);
  const pronto = fala({ ...base, estado: 'criado', noPath: true });
  assert.match(pronto, /✓ comando dashboard pronto/);
  assert.doesNotMatch(pronto, /próximo login|não está no PATH/);
  assert.match(fala({ ...base, estado: 'trocado', noPath: true }), /✓ comando dashboard trocado/);
  assert.match(fala({ ...base, estado: 'criado', noPath: true, outroAntes: '/opt/dashboard' }), /▲ outro dashboard vem antes no PATH \(vai rodar \/opt\/dashboard\)/);
  const login = fala({ ...base, estado: 'criado', noPath: false, cuidadoPor: '.profile' });
  assert.ok(login.includes(`vale no próximo login. Neste terminal, use o caminho completo: ${c.link}`), login);
  const editado = fala({ ...base, estado: 'criado', noPath: false, edicao: { estado: 'editado', arquivo: '.profile', copia: '.profile.dashboard-bak' } });
  assert.match(editado, /✓ PATH acrescentado em ~\/\.profile \(cópia em ~\/\.profile\.dashboard-bak\)/);
  assert.match(editado, /próximo login/);
  const novo = fala({ ...base, estado: 'criado', noPath: false, edicao: { estado: 'editado', arquivo: '.profile', copia: null } });
  assert.match(novo, /arquivo novo/);
  const naoQuis = fala({ ...base, estado: 'criado', noPath: false });
  assert.ok(naoQuis.includes(`▲ ~/.local/bin não está no PATH (acrescente esta linha no ~/.profile: ${LINHA_PATH})`), naoQuis);
});
