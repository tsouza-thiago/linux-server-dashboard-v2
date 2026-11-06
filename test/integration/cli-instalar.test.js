// `dashboard instalar` (server/cli/instalar.js): conferências antes do assistente e o ciclo
// completo do assistente pela rede (abre, recebe o código, conclui, fecha, liga o painel).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyVendor, parseFlags, preflight, runWizard, instalar } from '../../server/cli/instalar.js';
import { garantirPasta, prepararRegistro } from '../../server/atualizacao/registro.js';
import { criarCodigoPelaTela } from '../../server/setup/pela-tela.js';
import { request } from '../../test-support/request.js';
import { makeInstalacao } from '../../test-support/instalacao-fake.js';
import { esperarAte } from '../../test-support/esperar.js';
import { memOut } from '../../test-support/saida.js';
import { freePort } from '../../test-support/rede.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function copyVendor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-pre-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, 'public', 'vendor'), path.join(root, 'public', 'vendor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public', 'fonts'), path.join(root, 'public', 'fonts'), { recursive: true });
  return root;
}

test('instalar: uPlot e fontes conferidos pelo SHA-256 do vendor.json', (t) => {
  const real = verifyVendor(ROOT);
  assert.equal(real.ok, true, real.bad.join(', '));
  assert.ok(real.count >= 6);
  const root = copyVendor(t);
  fs.appendFileSync(path.join(root, 'public', 'vendor', 'uplot', 'uPlot.iife.min.js'), '\n/* alterado */');
  assert.deepEqual(verifyVendor(root).bad, ['public/vendor/uplot/uPlot.iife.min.js']);
  assert.deepEqual(verifyVendor(path.join(root, 'nada')).bad, ['public/vendor/vendor.json']);
});

test('instalar: opções da linha de comando', () => {
  assert.deepEqual(parseFlags(['--terminal', '--servidor', '192.0.2.10', '--porta=2222', '--sem-assinatura', 'x']), {
    _: ['x'], terminal: true, servidor: '192.0.2.10', porta: '2222', 'sem-assinatura': true,
  });
});

test('instalar: sem assinatura conferida, recusa; com --sem-assinatura, avisa e segue', (t) => {
  const root = copyVendor(t);
  const noSsh = (cmd) => (cmd === 'ssh' ? { error: new Error('ENOENT') } : { status: 0, stdout: '' });
  const a = memOut();
  assert.equal(preflight({ out: a.out, root, flags: {} }), false);
  assert.match(a.text(), /✗ esta pasta não veio de um git clone/);
  assert.match(a.text(), /Como resolver: não use esta cópia/);
  const b = memOut();
  assert.equal(preflight({ out: b.out, root, flags: { 'sem-assinatura': true }, env: { DASHBOARD_NODE_ORIGEM: 'baixado' } }), true);
  assert.match(b.text(), /▲ esta pasta não veio de um git clone.*--sem-assinatura/);
  assert.match(b.text(), /✓ Node\.js 24 — baixado para \.runtime\/ e conferido \(SHA-256\)/);
  assert.match(b.text(), /✓ nada para instalar com npm/);
  assert.match(b.text(), /✓ pasta de dados data\/ criada \(só você lê · 0700\)/);
  assert.equal(fs.statSync(path.join(root, 'data')).mode & 0o777, 0o700);
  const c = memOut();
  assert.equal(preflight({ out: c.out, root, flags: { 'sem-assinatura': true }, run: noSsh }), false);
  assert.match(c.text(), /falta o SSH nesta máquina/);
  assert.match(c.text(), /sudo apt install openssh-client/);
  fs.writeFileSync(path.join(root, 'public', 'vendor', 'uplot', 'LICENSE.txt'), 'trocado');
  const d = memOut();
  assert.equal(preflight({ out: d.out, root, flags: { 'sem-assinatura': true } }), false);
  assert.match(d.text(), /arquivos de terceiros não conferem/);
});

test('instalar: assistente abre na porta, aceita o código, conclui, fecha e liga o painel', async (t) => {
  const fake = makeInstalacao({ systemd: false });
  t.after(fake.cleanup);
  const port = await freePort();
  const opened = [];
  const o = memOut();
  const running = runWizard({ out: o.out, root: fake.root, inst: fake.inst, port, open: (url) => { opened.push(url); return true; } });
  await esperarAte(() => /código de uso único: [A-Z0-9-]+/.test(o.text()) && opened.length > 0);
  const code = /código de uso único: ([A-Z0-9-]+)/.exec(o.text())[1];
  assert.match(opened[0], new RegExp(`^http://127\\.0\\.0\\.1:${port}/configurar#codigo=${code.replace('-', '')}$`));
  const page = await request(port, { path: '/configurar' });
  const csrf = [].concat(page.headers['set-cookie']).find((c) => c.startsWith('dash_csrf=')).split(';')[0];
  let cookie = csrf;
  const post = async (p, body) => {
    const r = await request(port, { method: 'POST', path: `/api/configurar/${p}`, body, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Cookie: cookie } });
    const set = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('dash_setup='));
    if (set) cookie = `${csrf}; ${set.split(';')[0]}`;
    return r;
  };
  assert.equal((await post('entrar', { codigo: code })).status, 200);
  await post('servidor', { host: '192.0.2.10', user: 'maria' });
  await post('identidade', {});
  await post('conectar', { senha: 'certa', confirmo: true });
  await post('escolhas', { mounts: ['/'], smart: [], netIf: '', services: [] });
  await post('plano', { from: false });
  assert.equal((await post('preparar', {})).json.ok, true);
  assert.equal((await post('concluir', { iniciarComComputador: true, atalho: false })).status, 200);
  assert.equal(await running, 0);
  assert.match(o.text(), /✓ assistente concluído e desligado/);
  assert.match(o.text(), /✓ comando dashboard pronto/);
  assert.ok(fs.lstatSync(path.join(fake.home, '.local', 'bin', 'dashboard')));
  assert.match(o.text(), /✓ painel rodando em segundo plano/);
  assert.match(o.text(), /Tudo pronto\. Pode fechar esta janela\./);
  await assert.rejects(() => request(port, { path: '/configurar' }), 'o assistente não existe mais');
});

test('instalar: assistente parado por 1 hora fecha sozinho', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const o = memOut();
  const code = await runWizard({ out: o.out, root: fake.root, inst: fake.inst, port: await freePort(), open: () => false, idleMs: 150 });
  assert.equal(code, 1);
  assert.match(o.text(), /Abra o endereço acima no navegador/);
  assert.match(o.text(), /assistente fechado depois de 1 hora parado/);
});

test('instalar: --sem-link vale para qualquer modo', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const root = copyVendor(t);
  fs.writeFileSync(path.join(root, '.env'), `PORT=${await freePort()}\n`);
  const o = memOut();
  const code = await instalar({ out: o.out, root, home: root, args: ['--sem-assinatura', '--sem-link', '--sem-interface', '--ajuda'], deps: { inst: fake.inst } });
  assert.equal(code, 0, o.text());
  assert.equal(fake.inst.semLink, true);
});

test('instalar: painel já rodando → sugere reconfigurar; porta ocupada → explica', async (t) => {
  const fake = makeInstalacao();
  t.after(fake.cleanup);
  const root = copyVendor(t);
  const port = await freePort();
  fs.writeFileSync(path.join(root, '.env'), `PORT=${port}\n`);
  const blocker = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  t.after(() => blocker.close());
  const o = memOut();
  const code = await instalar({ out: o.out, root, home: root, args: ['--sem-assinatura'], deps: { inst: fake.inst } });
  assert.equal(code, 1);
  assert.match(o.text(), new RegExp(`a porta ${port} está em uso por outro programa`));
});

// `--pela-tela` com o painel falso: o teste vê quando ele para e liga. O caminho de verdade, com o
// ./dashboard e o painel de pé, fica em test/integration/reconfigurar-ponta-a-ponta.test.js.
async function pelaTela(t, { codigo = true, deps = {}, args = ['--pela-tela'], reconfigurar = true, antes = () => {}, ligarPainel = null } = {}) {
  const fake = makeInstalacao({ systemd: false });
  t.after(fake.cleanup);
  if (ligarPainel) fake.inst.ligarPainel = ligarPainel;
  const port = await freePort();
  const dataDir = path.join(fake.root, 'data');
  fs.mkdirSync(path.join(dataDir, 'ssh'), { recursive: true });
  fs.writeFileSync(path.join(fake.root, '.env'), `PORT=${port}\nSSH_HOST=antigo\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'ssh', 'known_hosts'), 'antigo\n', { mode: 0o600 });
  const raw = codigo ? criarCodigoPelaTela(dataDir) : null;
  await antes(port, fake.root);
  const painel = [];
  const o = memOut();
  // Tempo parado curto: com um guarda quebrado, o assistente sobe e o teste não espera os 15 min reais.
  const ctx = { idleMs: 5000, root: fake.root, home: fake.home, inst: fake.inst, stopPanel: async () => { painel.push('parou'); return { ok: true }; }, startPanel: async () => { painel.push('ligou'); return { ok: true }; }, preflight: () => true, healthy: async () => true, ...deps };
  const rodando = instalar({ out: o.out, root: fake.root, home: fake.home, args, reconfigurar, deps: ctx });
  const log = () => fs.readFileSync(path.join(dataDir, 'reconfigurar.log'), 'utf8');
  return { ...fake, port, raw, painel, o, rodando, log, dataDir };
}

// Cliente do assistente: entra com o código e chama os passos.
async function entrarNoAssistente(port, codigo) {
  let page = null;
  await esperarAte(async () => {
    page = await request(port, { path: '/configurar' }).catch(() => null);
    return page;
  });
  const csrf = [].concat(page.headers['set-cookie']).find((c) => c.startsWith('dash_csrf=')).split(';')[0];
  let cookie = csrf;
  const post = async (p, body = {}) => {
    const r = await request(port, { method: 'POST', path: `/api/configurar/${p}`, body, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Cookie: cookie } });
    const set = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('dash_setup='));
    if (set) cookie = `${csrf}; ${set.split(';')[0]}`;
    return r;
  };
  assert.equal((await post('entrar', { codigo })).status, 200);
  return post;
}

// Vai até o teste de coleta do passo 5, que regrava o .env e o data/ssh antes do fim.
async function ateOPasso5(post) {
  await post('servidor', { host: '192.0.2.10', user: 'maria' });
  await post('identidade');
  await post('conectar', { senha: 'certa', confirmo: true });
  await post('escolhas', { mounts: ['/'], smart: [], netIf: '', services: [] });
  await post('plano', { from: false });
  assert.equal((await post('preparar')).json.ok, true);
}

function confereConfiguracaoAnterior(p) {
  assert.match(fs.readFileSync(path.join(p.root, '.env'), 'utf8'), /^SSH_HOST=antigo$/m);
  assert.equal(fs.readFileSync(path.join(p.dataDir, 'ssh', 'known_hosts'), 'utf8'), 'antigo\n');
  assert.equal(fs.existsSync(path.join(p.dataDir, 'ssh', 'config')), false);
}

test('--pela-tela: cancelar no passo 5 devolve a configuração anterior e religa o painel', async (t) => {
  const p = await pelaTela(t);
  const post = await entrarNoAssistente(p.port, p.raw);
  assert.deepEqual(p.painel, ['parou']);
  await ateOPasso5(post);
  assert.match(fs.readFileSync(path.join(p.root, '.env'), 'utf8'), /^SSH_HOST=servidor$/m, 'o passo 5 regravou o .env');
  assert.equal((await post('cancelar')).status, 200);
  assert.equal(await p.rodando, 0);
  assert.deepEqual(p.painel, ['parou', 'ligou']);
  confereConfiguracaoAnterior(p);
  assert.match(p.log(), /assistente cancelado/);
  assert.match(p.log(), /painel de volta com a configuração anterior/);
  assert.ok(!p.log().includes(p.raw), 'o log não traz o código');
  assert.equal(fs.statSync(path.join(p.dataDir, 'reconfigurar.log')).mode & 0o777, 0o600);
  assert.equal(p.o.text(), '', 'sem terminal: tudo vai para o log');
  await assert.rejects(() => request(p.port, { path: '/configurar' }), 'o assistente não existe mais');
});

test('--pela-tela: abandonar fecha o assistente e religa o painel', async (t) => {
  const p = await pelaTela(t, { deps: { idleMs: 150 } });
  assert.equal(await p.rodando, 0);
  assert.deepEqual(p.painel, ['parou', 'ligou']);
  assert.match(p.log(), /assistente fechado depois de 15 minutos parado/);
  confereConfiguracaoAnterior(p);
});

test('--pela-tela: terminar fica com a configuração nova e não religa a anterior', async (t) => {
  const p = await pelaTela(t);
  const post = await entrarNoAssistente(p.port, p.raw);
  await ateOPasso5(post);
  assert.equal((await post('concluir', { iniciarComComputador: false, atalho: false, link: false })).status, 200);
  assert.equal(await p.rodando, 0);
  assert.deepEqual(p.painel, ['parou'], 'quem liga agora é a instalação');
  assert.match(fs.readFileSync(path.join(p.root, '.env'), 'utf8'), /^SSH_HOST=servidor$/m);
});

// Até o fim do assistente, com o painel novo já escolhido.
async function terminarAssistente(p) {
  const post = await entrarNoAssistente(p.port, p.raw);
  await ateOPasso5(post);
  assert.equal((await post('concluir', { iniciarComComputador: false, atalho: false, link: false })).status, 200);
  return p.rodando;
}

test('--pela-tela: painel novo que não responde para, volta à configuração anterior e religa', async (t) => {
  const perguntas = [];
  const p = await pelaTela(t, { deps: { healthy: async (port) => { perguntas.push(port); return false; } } });
  assert.equal(await terminarAssistente(p), 1, 'a configuração nova não valeu');
  assert.deepEqual(perguntas, [p.port]);
  // A 2ª parada é a do painel novo: de pé e mudo, ligar de novo só diria "já está rodando".
  assert.deepEqual(p.painel, ['parou', 'parou', 'ligou']);
  confereConfiguracaoAnterior(p);
  assert.match(p.log(), /o painel não subiu com a configuração nova \(o painel não respondeu\)/);
  assert.match(p.log(), /painel de volta com a configuração anterior/);
  assert.ok(!p.log().includes('SSH_HOST'), 'o log não copia o .env');
});

test('--pela-tela: ligarPainel que falha ou lança volta à configuração anterior e guarda o motivo', async (t) => {
  for (const [ligarPainel, motivo] of [
    [async () => ({ ok: false, erro: 'a porta está em uso' }), /a porta está em uso/],
    [async () => { throw new Error('disco cheio'); }, /disco cheio/],
  ]) {
    const perguntas = [];
    const p = await pelaTela(t, { ligarPainel, deps: { healthy: async () => { perguntas.push(1); return true; } } });
    assert.equal(await terminarAssistente(p), 1);
    assert.deepEqual(p.painel, ['parou', 'parou', 'ligou']);
    assert.deepEqual(perguntas, [], 'sem painel, não há o que perguntar');
    confereConfiguracaoAnterior(p);
    assert.match(p.log(), motivo);
    assert.match(p.log(), /painel de volta com a configuração anterior/);
  }
});

test('--pela-tela: o painel novo que não para nem o anterior que não volta escondem a falha', async (t) => {
  let vezes = 0;
  const p = await pelaTela(t, {
    deps: {
      healthy: async () => false,
      stopPanel: async () => { vezes += 1; return { ok: vezes === 1 }; },
      startPanel: async () => ({ ok: false, error: 'o painel não respondeu' }),
    },
  });
  assert.equal(await terminarAssistente(p), 1);
  assert.match(p.log(), /não consegui parar o painel novo/);
  assert.match(p.log(), /o painel não voltou/);
  confereConfiguracaoAnterior(p);
});

test('--pela-tela: a volta devolve o "iniciar com o computador" de antes', async (t) => {
  for (const [enabled, esperado] of [[true, 'enable'], [false, 'disable']]) {
    const chamadas = [];
    const p = await pelaTela(t, { deps: { healthy: async () => false, panelStatus: () => ({ mode: 'servico', enabled }), systemctl: (args) => { chamadas.push(args); } } });
    assert.equal(await terminarAssistente(p), 1);
    assert.deepEqual(chamadas, [[esperado, 'server-dashboard.service']]);
  }
  const semServico = [];
  const p = await pelaTela(t, { deps: { healthy: async () => false, panelStatus: () => ({ mode: 'parado', enabled: false }), systemctl: (args) => { semServico.push(args); } } });
  assert.equal(await terminarAssistente(p), 1);
  assert.deepEqual(semServico, []);
});

test('--pela-tela: SIGTERM depois do assistente não mata a volta', async (t) => {
  const ouvintes = process.listenerCount('SIGTERM');
  let durante = null;
  const p = await pelaTela(t, { ligarPainel: async () => { durante = process.listenerCount('SIGTERM'); return { ok: false, erro: 'sem porta' }; } });
  assert.equal(await terminarAssistente(p), 1);
  assert.equal(durante, ouvintes + 1, 'alguém atende o sinal enquanto o painel novo sobe');
  assert.equal(process.listenerCount('SIGTERM'), ouvintes, 'o ouvinte sai no fim');
});

test('terminal: painel que não sobe fica com a configuração nova, sem volta', async (t) => {
  const fake = makeInstalacao({ systemd: false });
  t.after(fake.cleanup);
  fake.inst.ligarPainel = async () => ({ ok: false, erro: 'sem porta' });
  const port = await freePort();
  const o = memOut();
  const rodando = runWizard({ out: o.out, root: fake.root, inst: fake.inst, port, open: () => true });
  await esperarAte(() => /código de uso único: [A-Z0-9-]+/.test(o.text()));
  const post = await entrarNoAssistente(port, /código de uso único: ([A-Z0-9-]+)/.exec(o.text())[1]);
  await ateOPasso5(post);
  assert.equal((await post('concluir', { atalho: false, link: false })).status, 200);
  assert.equal(await rodando, 1);
  assert.match(o.text(), /a configuração foi salva, mas o painel não iniciou/);
  assert.match(fs.readFileSync(path.join(fake.root, '.env'), 'utf8'), /^SSH_HOST=servidor$/m);
});

test('--pela-tela: porta tomada na troca religa o painel e o log diz o motivo', async (t) => {
  const p = await pelaTela(t, {
    antes: async (port) => {
      const blocker = net.createServer().listen(port, '127.0.0.1');
      await new Promise((r) => blocker.once('listening', r));
      t.after(() => blocker.close());
    },
  });
  assert.equal(await p.rodando, 0);
  assert.deepEqual(p.painel, ['parou', 'ligou']);
  assert.match(p.log(), /o assistente não subiu/);
});

test('--pela-tela: sem código válido, o painel nem para', async (t) => {
  const p = await pelaTela(t, { codigo: false });
  assert.equal(await p.rodando, 1);
  assert.deepEqual(p.painel, []);
  assert.match(p.log(), /sem código válido da tela/);
});

test('--pela-tela: com uma atualização em andamento, o painel nem para e o código fica', async (t) => {
  const p = await pelaTela(t, { antes: (port, root) => { garantirPasta(root); prepararRegistro(root, { alvo: 'v2.90.0', de: 'v2.89.0' }); } });
  assert.equal(await p.rodando, 1);
  assert.deepEqual(p.painel, []);
  assert.match(p.log(), /há uma atualização em andamento/);
  assert.equal(fs.existsSync(path.join(p.dataDir, 'reconfigurar.json')), true);
});

test('--pela-tela: conferência reprovada ou painel que não para não sobem o assistente', async (t) => {
  const reprovada = await pelaTela(t, { deps: { preflight: () => false } });
  assert.equal(await reprovada.rodando, 1);
  assert.deepEqual(reprovada.painel, []);
  const preso = await pelaTela(t, { deps: { stopPanel: async () => ({ ok: false }) } });
  assert.equal(await preso.rodando, 1);
  assert.match(preso.log(), /não consegui parar o painel/);
  await assert.rejects(() => request(preso.port, { path: '/configurar' }), 'o assistente não subiu');
});

test('--pela-tela: painel que não volta aparece no log e sai com erro', async (t) => {
  const p = await pelaTela(t, { deps: { idleMs: 100, startPanel: async () => ({ ok: false, error: 'o painel não respondeu' }) } });
  assert.equal(await p.rodando, 1);
  assert.match(p.log(), /o painel não voltou \(o painel não respondeu\)/);
});

test('--pela-tela: só vale no reconfigurar e sem outro modo', async (t) => {
  for (const caso of [{ reconfigurar: false }, { args: ['--pela-tela', '--terminal'] }, { args: ['--pela-tela', '--sem-interface'] }, { args: ['--pela-tela', '--importar-v1', '/tmp/x'] }]) {
    const p = await pelaTela(t, caso);
    assert.equal(await p.rodando, 2, JSON.stringify(caso));
    assert.deepEqual(p.painel, []);
    assert.match(p.o.text(), /--pela-tela é interna do reconfigurar/);
  }
});
