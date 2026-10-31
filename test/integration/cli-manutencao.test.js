// Manutenção pelo comando `dashboard`: diagnosticar, atualizar (tags assinadas de
// verdade num repositório temporário, com volta atrás), upgrade V1→V2 e desinstalar.
import test from 'node:test';
import { installId } from '../../server/setup/acesso.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOutput } from '../../server/cli/saida.js';
import { diagnosticar, latestSample, permissionProblems, explainFailure, sshSettings } from '../../server/cli/diagnosticar.js';
import { atualizar, afterUpdate, backupData, restoreData } from '../../server/cli/atualizar.js';
import { importarV1, detectV1, v1Settings, v1Pid, stopV1 } from '../../server/cli/importar-v1.js';
import { desinstalar } from '../../server/cli/desinstalar.js';
import { LINHA_PATH, editarArquivoDeLogin, unitText } from '../../server/setup/local.js';
import { unitPath } from '../../server/cli/servico.js';
import { loadEnvFile } from '../../server/config.js';
import { esperarAte } from '../../test-support/esperar.js';

function memOut() {
  const chunks = [];
  const out = makeOutput({ stream: { isTTY: false, write: (s) => { chunks.push(s); return true; } }, env: {} });
  return { out, text: () => chunks.join('') };
}
const tmp = (t, p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// ---------------- diagnosticar ----------------

function installedRoot(t, { sample } = {}) {
  const root = tmp(t, 'dash-diag-');
  const home = tmp(t, 'dash-diag-home-');
  fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
  const key = path.join(home, '.ssh', 'dashboard_ed25519');
  fs.writeFileSync(key, 'k', { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'data', 'ssh'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, 'data'), 0o700);
  fs.writeFileSync(path.join(root, 'data', 'ssh', 'config'), `Host servidor\n  IdentityFile "${key}"\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'data', 'ssh', 'known_hosts'), 'x\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=servidor\nSSH_ACESSO=restrito\nSSH_CONFIG=data/ssh/config\nDISK_MOUNTS=/\nDISK_DEVS=sda sdc\n', { mode: 0o600 });
  if (sample) {
    fs.mkdirSync(path.join(root, 'data', 'history'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'data', 'history', `${sample.ts.slice(0, 10)}.ndjson`), `${JSON.stringify(sample)}\n`);
  }
  return { root, home, key };
}

const SAMPLE = (now, extra = {}) => ({
  ts: new Date(now - 18000).toISOString(),
  collector: { hashMismatch: false, durationMs: 910, outputBytes: 6349 },
  smart: [{ dev: 'sda', status: 'PASSED' }, { dev: 'sdc', status: 'SEM_PERMISSAO' }],
  ...extra,
});

test('diagnosticar: com o painel coletando, usa a última amostra e explica cada aviso', async (t) => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const { root, home } = installedRoot(t, { sample: SAMPLE(now) });
  const o = memOut();
  let collected = 0;
  const code = await diagnosticar({
    out: o.out, root, home,
    deps: { now, panelStatus: () => ({ running: true, mode: 'servico', enabled: true }), collect: async () => { collected += 1; return { ok: false }; } },
  });
  assert.equal(code, 0);
  assert.equal(collected, 0, 'nenhuma conexão extra (I1)');
  const text = o.text();
  assert.match(text, /✓ painel rodando \(serviço de usuário, inicia com o computador\)/);
  assert.match(text, /✓ permissões dos arquivos corretas \(700 \/ 600\)/);
  assert.match(text, /✓ servidor responde · identidade confere \(pela última coleta do painel\)/);
  assert.match(text, /✓ chave restrita ao comando de coleta · em dia/);
  assert.match(text, /▲ SMART de \/dev\/sdc sem permissão/);
  assert.match(text, /Como resolver: rode dashboard reconfigurar e marque sdc no passo "O que monitorar"\./);
  assert.match(text, /✓ última coleta há 18 s · 0,91 s · 6,2 KB/);
  assert.match(text, /Resultado: 1 aviso, nenhum erro\./);
  assert.ok(latestSample(root));
});

test('diagnosticar: permissões abertas, linha desatualizada, disco reprovado e coleta ao vivo', async (t) => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const { root, home } = installedRoot(t, { sample: SAMPLE(now - 3600e3, { collector: { hashMismatch: true }, smart: [{ dev: 'sda', status: 'FAILED' }, { dev: 'sdb', status: 'SEM_SMARTCTL' }] }) });
  fs.chmodSync(path.join(root, '.env'), 0o644);
  assert.equal(permissionProblems(root)[0].want, '600');
  const o = memOut();
  const live = SAMPLE(now, { collector: { hashMismatch: true, durationMs: 1200 }, smart: [{ dev: 'sda', status: 'FAILED' }, { dev: 'sdb', status: 'SEM_SMARTCTL' }] });
  const code = await diagnosticar({
    out: o.out, root, home,
    deps: { now, panelStatus: () => ({ running: false }), collect: async (p) => { assert.equal(p.access, 'restrito'); return { ok: true, sample: live }; } },
  });
  assert.equal(code, 1);
  const text = o.text();
  assert.match(text, /▲ painel parado/);
  assert.match(text, /✗ arquivos com permissão aberta demais \(\.env 644\)/);
  assert.match(text, /chmod 600 ".*\/\.env"/);
  assert.match(text, /▲ a linha da chave no servidor está desatualizada/);
  assert.match(text, /✗ o disco \/dev\/sda reprovou no teste de saúde/);
  assert.match(text, /▲ o smartctl não está instalado no servidor/);
  assert.match(text, /coleta de teste há 18 s · 1,20 s/);
});

test('diagnosticar: lê SSH_ACESSO e SSH_CONFIG com as mesmas regras do painel', async (t) => {
  const { root, home } = installedRoot(t);
  const data = path.join(root, 'data');
  // As regras de server/config.js: modo sem diferença de caixa/espaço; caminho preso em data/.
  assert.deepEqual(sshSettings({ SSH_ACESSO: ' Restrito ', SSH_CONFIG: 'data/ssh/config' }, root),
    { access: 'restrito', configFile: path.join(data, 'ssh', 'config') });
  assert.deepEqual(sshSettings({ SSH_ACESSO: 'restrito', SSH_CONFIG: '' }, root), { access: 'restrito', configFile: '' },
    'sem SSH_CONFIG o painel usa o ~/.ssh/config, e o diagnóstico também');
  assert.deepEqual(sshSettings({ SSH_CONFIG: '../../etc/ssh/ssh_config' }, root),
    { access: 'direto', configFile: path.join(data, 'ssh', 'config') }, 'fora de data/ volta ao padrão');
  assert.deepEqual(sshSettings({ SSH_ACESSO: 'qualquer', SSH_CONFIG: 'data/ssh/outro' }, root),
    { access: 'direto', configFile: path.join(data, 'ssh', 'outro') });
  // Ponta a ponta: "Restrito" com maiúscula vale como restrito, como no painel.
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=servidor\nSSH_ACESSO=Restrito\nSSH_CONFIG=data/ssh/config\nDISK_MOUNTS=/\n', { mode: 0o600 });
  const o = memOut();
  let access = null;
  await diagnosticar({ out: o.out, root, home, deps: { panelStatus: () => ({ running: false }), collect: async (p) => { access = p.access; return { ok: false, error: 'x' }; } } });
  assert.equal(access, 'restrito');
  assert.doesNotMatch(o.text(), /acesso direto ao servidor/);
});

test('diagnosticar: não instalado, coleta falhando e acesso direto da V1', async (t) => {
  const empty = tmp(t, 'dash-diag-empty-');
  const a = memOut();
  assert.equal(await diagnosticar({ out: a.out, root: empty }), 1);
  assert.match(a.text(), /✗ ainda não instalado/);
  const { root, home } = installedRoot(t);
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=meu-servidor\n', { mode: 0o600 });
  const b = memOut();
  const code = await diagnosticar({ out: b.out, root, home, deps: { panelStatus: () => ({ running: false }), collect: async () => ({ ok: false, error: 'identidade do servidor desconhecida ou mudou — confira e rode ./dashboard reconfigurar' }) } });
  assert.equal(code, 1);
  assert.match(b.text(), /▲ acesso direto ao servidor \(como na V1\)/);
  assert.match(b.text(), /✗ o servidor não respondeu à coleta de teste/);
  assert.match(b.text(), /a identidade do servidor mudou/);
  assert.match(explainFailure('timeout — servidor não respondeu')[0], /a tempo/);
  assert.match(explainFailure('SSH falhou (exit 255)')[1], /reconfigurar/);
  assert.match(explainFailure('outra coisa')[1], /dashboard\.log/);
});

// ---------------- atualizar ----------------

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const hasGit = !spawnSync('git', ['--version']).error && !spawnSync('ssh-keygen', ['-?']).error;

function releaseRepos(t) {
  const base = tmp(t, 'dash-upd-');
  const g = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const work = path.join(base, 'trabalho');
  fs.mkdirSync(work);
  g(work, 'init', '-q');
  g(work, 'config', 'user.email', 'mantenedor@example.com');
  g(work, 'config', 'user.name', 'Mantenedor');
  for (const k of ['chave', 'outra']) spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', k, '-f', path.join(base, k)]);
  const pub = fs.readFileSync(path.join(base, 'chave.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  const release = (version, { key = 'chave', broken = false } = {}) => {
    fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(work, 'docs', 'allowed_signers'), `mantenedor@example.com namespaces="git" ${pub}\n`);
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(work, 'quebrada'), broken ? 'sim' : 'nao');
    g(work, 'add', '-A');
    g(work, 'commit', '-q', '-m', version);
    g(work, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${path.join(base, key)}`, 'tag', '-s', `v${version}`, '-m', version);
  };
  release('2.0.0-alpha.8');
  const clone = path.join(base, 'instalado');
  spawnSync('git', ['clone', '-q', work, clone], { env: GIT_ENV });
  g(clone, 'checkout', '-q', '--detach', 'v2.0.0-alpha.8');
  fs.mkdirSync(path.join(clone, 'data'), { mode: 0o700 });
  fs.writeFileSync(path.join(clone, 'data', 'alerts.json'), '[]');
  fs.writeFileSync(path.join(clone, '.env'), 'SSH_HOST=servidor\n', { mode: 0o600 });
  return { work, clone, release, g };
}

const gitRun = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, env: GIT_ENV });

test('atualizar: só tag assinada pela chave instalada; backup, troca e volta atrás se falhar', { skip: !hasGit }, async (t) => {
  const { clone, release, g } = releaseRepos(t);
  const home = tmp(t, 'dash-upd-home-');
  const deps = { run: gitRun, gitRun, stopPanel: async () => ({}), startPanel: async () => ({ ok: true }), panelStatus: () => ({ running: true }) };
  const a = memOut();
  assert.equal(await atualizar({ out: a.out, root: clone, home, deps: { ...deps, reexec: () => 0 } }), 0);
  assert.match(a.text(), /você já está na versão mais nova \(v2\.0\.0-alpha\.8\)/);

  release('2.0.0-alpha.9', { key: 'outra' }); // assinada por outra chave: ignorada
  const b = memOut();
  await atualizar({ out: b.out, root: clone, home, deps: { ...deps, reexec: () => 0 } });
  assert.match(b.text(), /já está na versão mais nova/);

  release('2.0.0-alpha.10');
  const calls = [];
  const c = memOut();
  const ok = await atualizar({ out: c.out, root: clone, home, deps: { ...deps, reexec: (args) => { calls.push(args); return 0; } } });
  assert.equal(ok, 0, c.text());
  assert.match(c.text(), /✓ versão nova encontrada: v2\.0\.0-alpha\.10/);
  assert.match(c.text(), /✓ cópia de segurança de data\/ feita \(\.backups\/.*-v2\.0\.0-alpha\.8\)/);
  assert.match(c.text(), /✓ atualizado de v2\.0\.0-alpha\.8 para v2\.0\.0-alpha\.10/);
  assert.deepEqual(calls, [['atualizar', '--pos-atualizacao']], 'a versão nova liga o painel');
  assert.equal(g(clone, 'describe', '--tags', '--exact-match'), 'v2.0.0-alpha.10');

  release('2.0.0-alpha.11', { broken: true });
  const d = memOut();
  const bad = await atualizar({
    out: d.out, root: clone, home,
    deps: {
      ...deps,
      reexec: () => {
        const broken = fs.readFileSync(path.join(clone, 'quebrada'), 'utf8') === 'sim';
        if (broken) fs.writeFileSync(path.join(clone, 'data', 'alerts.json'), 'estragado pela versão nova');
        return broken ? 1 : 0;
      },
    },
  });
  assert.equal(bad, 1);
  assert.match(d.text(), /✗ a versão v2\.0\.0-alpha\.11 não funcionou aqui: voltando para v2\.0\.0-alpha\.10/);
  assert.match(d.text(), /✓ de volta à v2\.0\.0-alpha\.10, com os dados de antes da atualização/);
  assert.equal(g(clone, 'describe', '--tags', '--exact-match'), 'v2.0.0-alpha.10');
  assert.equal(fs.readFileSync(path.join(clone, 'data', 'alerts.json'), 'utf8'), '[]', 'data/ restaurado do backup');

  fs.appendFileSync(path.join(clone, 'package.json'), ' ');
  release('2.0.0-alpha.12');
  const e = memOut();
  assert.equal(await atualizar({ out: e.out, root: clone, home, deps: { ...deps, reexec: () => 0 } }), 1);
  assert.match(e.text(), /há arquivos do painel alterados/);
});

test('atualizar --registro: log e estado em .atualizacao/, sem nada no terminal, sem o token e sem cor', { skip: !hasGit }, async (t) => {
  const { clone, release, g } = releaseRepos(t);
  const home = tmp(t, 'dash-upd-home-');
  fs.writeFileSync(path.join(clone, '.env'), `SSH_HOST=servidor\nDASH_TOKEN=${'x'.repeat(43)}\n`, { mode: 0o600 });
  release('2.0.0-alpha.9');
  const fases = [];
  const silencioso = memOut();
  const ler = () => JSON.parse(fs.readFileSync(path.join(clone, '.atualizacao', 'estado.json'), 'utf8'));
  const deps = {
    run: gitRun, gitRun, startPanel: async () => ({ ok: true }), panelStatus: () => ({ running: true }),
    stopPanel: async () => { fases.push(ler().fase); return {}; },
    reexec: (a) => { fases.push(ler().fase); assert.deepEqual(a, ['atualizar', '--pos-atualizacao']); return 0; },
  };
  assert.equal(await atualizar({ out: silencioso.out, root: clone, home, args: ['--registro'], deps }), 0);
  assert.equal(silencioso.text(), '', 'o registro não escreve no terminal');
  assert.deepEqual(fases, ['trocando', 'ligando']);
  const log = fs.readFileSync(path.join(clone, '.atualizacao', 'ultima.log'), 'utf8');
  assert.match(log, /✓ versão nova encontrada: v2\.0\.0-alpha\.9/);
  assert.match(log, /✓ atualizado de v2\.0\.0-alpha\.8 para v2\.0\.0-alpha\.9/);
  assert.ok(!log.includes('x'.repeat(43)), 'o token não vai para o log');
  assert.ok(!log.includes('\x1b['), 'sem cor');
  const e = ler();
  assert.equal(e.fase, 'fim');
  assert.equal(e.resultado, 'atualizado');
  assert.equal(e.alvo, 'v2.0.0-alpha.9');
  assert.equal(e.de, 'v2.0.0-alpha.8');
  assert.ok(e.fim);
  assert.equal(fs.existsSync(path.join(clone, '.atualizacao', 'trava.pid')), false, 'a trava sai no fim');
  assert.equal(g(clone, 'status', '--porcelain', '--untracked-files=no'), '', 'a pasta nova não suja o git');
});

test('atualizar --registro: a volta atrás não apaga o log e fica no estado', { skip: !hasGit }, async (t) => {
  const { clone, release, g } = releaseRepos(t);
  const home = tmp(t, 'dash-upd-home-');
  release('2.0.0-alpha.9', { broken: true });
  const deps = {
    run: gitRun, gitRun, startPanel: async () => ({ ok: true }), panelStatus: () => ({ running: true }), stopPanel: async () => ({}),
    reexec: () => (fs.readFileSync(path.join(clone, 'quebrada'), 'utf8') === 'sim' ? 1 : 0),
  };
  assert.equal(await atualizar({ out: memOut().out, root: clone, home, args: ['--registro'], deps }), 1);
  assert.equal(g(clone, 'describe', '--tags', '--exact-match'), 'v2.0.0-alpha.8');
  assert.equal(JSON.parse(fs.readFileSync(path.join(clone, '.atualizacao', 'estado.json'), 'utf8')).resultado, 'voltou');
  assert.match(fs.readFileSync(path.join(clone, '.atualizacao', 'ultima.log'), 'utf8'), /✗ a versão v2\.0\.0-alpha\.9 não funcionou aqui/);
});

test('atualizar --registro: já na mais nova e falha da pasta têm resultado próprio', { skip: !hasGit }, async (t) => {
  const { clone } = releaseRepos(t);
  const home = tmp(t, 'dash-upd-home-');
  const deps = { run: gitRun, gitRun };
  const ler = () => JSON.parse(fs.readFileSync(path.join(clone, '.atualizacao', 'estado.json'), 'utf8'));
  assert.equal(await atualizar({ out: memOut().out, root: clone, home, args: ['--registro'], deps }), 0);
  assert.equal(ler().resultado, 'ja-na-mais-nova');
  fs.rmSync(path.join(clone, '.atualizacao'), { recursive: true });
  fs.rmSync(path.join(clone, '.env'));
  assert.equal(await atualizar({ out: memOut().out, root: clone, home, args: ['--registro'], deps }), 1);
  assert.equal(ler().resultado, 'falhou');
});

test('atualizar: 2 ao mesmo tempo não andam juntas, no terminal e pelo painel', { skip: !hasGit }, async (t) => {
  const { clone, release, g } = releaseRepos(t);
  const home = tmp(t, 'dash-upd-home-');
  release('2.0.0-alpha.9');
  const procDir = path.join(tmp(t, 'dash-upd-proc-'), 'proc');
  fs.mkdirSync(path.join(procDir, '700'), { recursive: true });
  fs.writeFileSync(path.join(procDir, '700', 'cmdline'), 'node\0/p/server/cli/index.js\0atualizar\0');
  fs.mkdirSync(path.join(clone, '.atualizacao'));
  fs.writeFileSync(path.join(clone, '.atualizacao', 'trava.pid'), '700\n');
  const deps = { run: gitRun, gitRun, trava: { procDir } };
  const o = memOut();
  assert.equal(await atualizar({ out: o.out, root: clone, home, deps }), 1);
  assert.match(o.text(), /já há uma atualização rodando/);
  assert.equal(g(clone, 'describe', '--tags', '--exact-match'), 'v2.0.0-alpha.8');
  assert.equal(await atualizar({ out: memOut().out, root: clone, home, args: ['--registro'], deps }), 1);
  assert.match(fs.readFileSync(path.join(clone, '.atualizacao', 'ultima.log'), 'utf8'), /já há uma atualização rodando/);
  assert.equal(fs.readFileSync(path.join(clone, '.atualizacao', 'trava.pid'), 'utf8'), '700\n', 'a trava dos outros fica');
});

test('atualizar --registro: o git do painel não pergunta nada', { skip: !hasGit }, async (t) => {
  const { clone } = releaseRepos(t);
  const home = tmp(t, 'dash-upd-home-');
  const envs = [];
  const run = (cmd, args, opts) => { if (args.includes('fetch')) envs.push(opts.env); return gitRun(cmd, args, opts); };
  await atualizar({ out: memOut().out, root: clone, home, args: ['--registro'], deps: { run, gitRun } });
  assert.equal(envs[0].GIT_TERMINAL_PROMPT, '0');
  assert.match(envs[0].GIT_SSH_COMMAND, /BatchMode=yes/);
});

test('atualizar: pasta sem git; fase 2 liga o painel e confere a saúde', async (t) => {
  const root = tmp(t, 'dash-upd-nogit-');
  const home = tmp(t, 'dash-upd-home-');
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=servidor\n', { mode: 0o600 });
  const a = memOut();
  assert.equal(await atualizar({ out: a.out, root, home }), 1);
  assert.match(a.text(), /não veio de um git clone/);
  const b = memOut();
  assert.equal(await afterUpdate({ out: b.out, root, home, deps: { startPanel: async () => ({ ok: true }), healthy: async () => true } }), 0);
  assert.match(b.text(), /versão nova no ar/);
  const c = memOut();
  assert.equal(await afterUpdate({ out: c.out, root, home, deps: { startPanel: async () => ({ ok: true }), healthy: async () => false } }), 1);
  assert.equal(await afterUpdate({ out: c.out, root, home, deps: { startPanel: async () => ({ ok: false, error: 'x' }) } }), 1);
  // Backups: guarda os 3 mais novos.
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'a'), '1');
  const dirs = [0, 1, 2, 3].map((i) => backupData(root, `v${i}`, new Date(Date.UTC(2026, 0, 1, 0, i))));
  assert.deepEqual(fs.readdirSync(path.join(root, '.backups')).length, 3);
  assert.equal(fs.statSync(path.join(root, '.backups')).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(root, 'data', 'a'), '2');
  restoreData(root, dirs[3]);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'a'), 'utf8'), '1');
});

// Serviço instalado em `dir`, com a unidade que a instalação escreve de verdade.
function serviceAt(home, dir) {
  const file = unitPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, unitText({ root: dir, nodeBin: '/usr/bin/node' }));
  return file;
}

// Dependências que reprovam o teste se o atualizar tocar em git, painel ou serviço.
const untouched = () => {
  const stop = (name) => () => assert.fail(`o atualizar chamou ${name}`);
  return { run: stop('git'), gitRun: stop('git'), panelStatus: stop('panelStatus'), stopPanel: stop('stopPanel'), startPanel: stop('startPanel'), reexec: stop('reexec'), installService: stop('installService') };
};

test('atualizar: pasta sem .env para antes de tudo e diz qual é a instalação (#118)', async (t) => {
  const root = tmp(t, 'dash-upd-copia-');
  const home = tmp(t, 'dash-upd-home-');

  const semNada = memOut();
  assert.equal(await atualizar({ out: semNada.out, root, home, deps: untouched() }), 1);
  assert.match(semNada.text(), /✗ esta pasta não é uma instalação do painel \(não tem \.env\)/);
  assert.match(semNada.text(), /instale nesta com/);

  // Com o comando `dashboard` apontando para a instalação (sem serviço systemd).
  const viaLink = tmp(t, 'dash-upd-link-');
  fs.mkdirSync(path.join(viaLink, 'server', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(viaLink, 'server', 'cli', 'index.js'), '');
  fs.writeFileSync(path.join(viaLink, 'dashboard'), '');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(viaLink, 'dashboard'), path.join(home, '.local', 'bin', 'dashboard'));
  const peloLink = memOut();
  assert.equal(await atualizar({ out: peloLink.out, root, home, deps: untouched() }), 1);
  assert.ok(peloLink.text().includes(`cd "${fs.realpathSync(viaLink)}" && ./dashboard atualizar`), peloLink.text());

  // O serviço manda mais que o link, e a unidade fica exatamente como estava.
  const instalada = tmp(t, 'dash-upd-instalada-');
  const unit = serviceAt(home, instalada);
  const antes = fs.readFileSync(unit, 'utf8');
  const peloServico = memOut();
  assert.equal(await atualizar({ out: peloServico.out, root, home, deps: untouched() }), 1);
  assert.ok(peloServico.text().includes(`cd "${instalada}" && ./dashboard atualizar`), peloServico.text());
  assert.equal(fs.readFileSync(unit, 'utf8'), antes);
  assert.equal(fs.existsSync(path.join(root, '.backups')), false, 'sem backup');
});

test('atualizar: serviço de outra pasta para, mostra as 2 pastas e não reescreve (#118)', async (t) => {
  const root = tmp(t, 'dash-upd-aqui-');
  const home = tmp(t, 'dash-upd-home-');
  // O % vira %% na unidade: a pasta mostrada é a de verdade.
  const instalada = path.join(tmp(t, 'dash-upd-outra-'), 'painel 100%');
  fs.mkdirSync(instalada);
  fs.writeFileSync(path.join(root, '.env'), 'SSH_HOST=servidor\n', { mode: 0o600 });
  const unit = serviceAt(home, instalada);
  const antes = fs.readFileSync(unit, 'utf8');

  const a = memOut();
  assert.equal(await atualizar({ out: a.out, root, home, deps: untouched() }), 1);
  assert.match(a.text(), /✗ o serviço do painel roda de outra pasta/);
  assert.ok(a.text().includes(`Serviço:     ${instalada}`), a.text());
  assert.ok(a.text().includes(`Esta pasta:  ${root}`), a.text());
  assert.match(a.text(), /reconfigurar nesta pasta/);
  assert.equal(fs.readFileSync(unit, 'utf8'), antes);
  assert.equal(fs.existsSync(path.join(root, '.backups')), false, 'sem backup');

  // A fase 2 também recusa: a fase 1 de uma versão anterior não conferia a pasta.
  const b = memOut();
  assert.equal(await afterUpdate({ out: b.out, root, home, deps: untouched() }), 1);
  assert.match(b.text(), /✗ o serviço do painel roda de outra pasta/);
  assert.equal(fs.readFileSync(unit, 'utf8'), antes);

  // Serviço desta pasta, mesmo por um link simbólico: segue normal e refaz a unidade.
  const atalho = path.join(tmp(t, 'dash-upd-atalho-'), 'atalho');
  fs.symlinkSync(root, atalho);
  serviceAt(home, atalho);
  const refeitos = [];
  const c = memOut();
  const deps = { installService: async (o) => { refeitos.push(o.root); return { ok: true }; }, healthy: async () => true };
  assert.equal(await afterUpdate({ out: c.out, root, home, deps }), 0, c.text());
  assert.deepEqual(refeitos, [root]);
  const d = memOut();
  assert.equal(await atualizar({ out: d.out, root, home }), 1);
  assert.match(d.text(), /não veio de um git clone/, 'passou da conferência da pasta');
});

// ---------------- V1 → V2 ----------------

function v1Folder(t) {
  const v1 = tmp(t, 'dash-v1-');
  fs.mkdirSync(path.join(v1, 'server'));
  fs.mkdirSync(path.join(v1, 'data'));
  fs.writeFileSync(path.join(v1, 'package.json'), JSON.stringify({ name: 'linux-server-dashboard', version: '1.0.0', type: 'commonjs' }));
  fs.writeFileSync(path.join(v1, 'server', 'index.js'), 'setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(v1, '.env'), [
    'SSH_HOST=dash-192_0_2_10', 'POLL_INTERVAL=60000', 'PORT=3000', 'NET_IF=enp3s0',
    'DISK_MOUNTS=/ /mnt/dados $(reboot)', 'DISK_DEVS=sda sdb', 'SERVICES=smbd nmbd', `DASH_TOKEN=${'a'.repeat(32)}`, 'HISTORY_FILE=/etc/passwd', '',
  ].join('\n'));
  fs.writeFileSync(path.join(v1, 'data', 'history.json'), '[]');
  fs.writeFileSync(path.join(v1, 'data', 'alerts.json'), '[{"id":"1","message":"Temperatura CPU 61.2°C","status":"new"}]');
  fs.writeFileSync(path.join(v1, 'data', 'annotations.json'), '[{"id":"a","text":"troquei o disco"}]');
  return v1;
}

test('V1 → V2: para a V1, traz configuração e dados saneados e liga a V2; a V1 fica intacta', async (t) => {
  const v1 = v1Folder(t);
  const before = fs.readFileSync(path.join(v1, '.env'), 'utf8');
  const root = tmp(t, 'dash-v2-');
  const home = tmp(t, 'dash-v2-home-');
  fs.writeFileSync(path.join(root, '.env.example'), 'SSH_HOST=seu_host\nPORT=3000\n');
  const o = memOut();
  const code = await importarV1({
    out: o.out, root, dir: v1, home,
    deps: { stopV1: async () => ['servico-parado', 'servico-desligado'], hasSystemdUser: () => false, startPanel: async () => ({ ok: true }), waitForPort: async () => true },
  });
  assert.equal(code, 0, o.text());
  const env = loadEnvFile(path.join(root, '.env'));
  assert.deepEqual(
    [env.SSH_HOST, env.SSH_ACESSO, env.SSH_CONFIG, env.DISK_MOUNTS, env.DISK_DEVS, env.SERVICES, env.NET_IF, env.DASH_TOKEN, env.HISTORY_FILE],
    ['dash-192_0_2_10', 'direto', '', '/ /mnt/dados', 'sda sdb', 'smbd nmbd', 'enp3s0', 'a'.repeat(32), undefined],
    'o $(reboot) e o HISTORY_FILE fora de data/ não passam',
  );
  for (const f of ['history.json', 'alerts.json', 'annotations.json']) {
    assert.equal(fs.statSync(path.join(root, 'data', f)).mode & 0o777, 0o600);
  }
  assert.equal(fs.readFileSync(path.join(v1, '.env'), 'utf8'), before, 'a V1 não é alterada');
  assert.ok(fs.existsSync(path.join(v1, 'data', 'history.json')));
  assert.match(o.text(), /✓ V1 encontrada \(1\.0\.0\)/);
  assert.match(o.text(), /✓ V1 parada \(o serviço dela não inicia mais com o computador\)/);
  assert.match(o.text(), /▲ a V2 ainda usa o acesso completo da V1/);
  assert.match(o.text(), /systemctl --user enable --now linux-server-dashboard\.service/);
  assert.match(o.text(), /Para voltar à V1: \.\/dashboard parar e,/, 'V2 em segundo plano: parar basta');
  const again = memOut();
  await importarV1({ out: again.out, root, dir: v1, home, deps: { stopV1: async () => [], hasSystemdUser: () => false, startPanel: async () => ({ ok: true }), waitForPort: async () => true } });
  assert.match(again.text(), /nenhum dado novo para copiar/, 'não sobrescreve o que a V2 já tem');
  // V2 como serviço: "parar" não basta (ela voltaria com o computador e as duas fariam 2
  // conexões por minuto ao servidor); o recado manda desligar o serviço.
  const svc = memOut();
  await importarV1({ out: svc.out, root, dir: v1, home, deps: { stopV1: async () => [], hasSystemdUser: () => true, installService: async () => ({ ok: true }), installShortcut: () => {}, waitForPort: async () => true } });
  assert.match(svc.text(), /Para voltar à V1: systemctl --user disable --now server-dashboard\.service e,/);

  assert.deepEqual(detectV1(root), { ok: false, reason: 'nao-e-v1' });
  const notV1 = memOut();
  assert.equal(await importarV1({ out: notV1.out, root, dir: root, home }), 1);
  assert.match(notV1.text(), /não é uma instalação da V1/);
  assert.deepEqual(v1Settings({ SSH_HOST: 'seu-host', DASH_TOKEN: 'curto' }), {});
});

test('V1 → V2: para só o processo da V1 daquela pasta e o serviço dela', async (t) => {
  const v1 = v1Folder(t);
  const proc = spawn(process.execPath, [path.join(v1, 'server', 'index.js')], { stdio: 'ignore' });
  t.after(() => proc.kill('SIGKILL'));
  fs.writeFileSync(path.join(v1, 'data', 'dashboard.pid'), String(proc.pid));
  // Espera o processo da V1 aparecer no /proc com a linha de comando (não um tempo fixo).
  await esperarAte(() => v1Pid(v1) === proc.pid);
  assert.equal(v1Pid(v1), proc.pid);
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args.slice(1).join(' '));
    if (args[1] === 'is-active') return { status: 0, stdout: 'active\n' };
    if (args[1] === 'is-enabled') return { status: 0, stdout: 'enabled\n' };
    return { status: 0, stdout: '' };
  };
  const done = await stopV1(v1, { run });
  assert.deepEqual(done, ['servico-parado', 'servico-desligado', 'processo-parado']);
  assert.ok(calls.includes('stop linux-server-dashboard.service') && calls.includes('disable linux-server-dashboard.service'));
  fs.writeFileSync(path.join(v1, 'data', 'dashboard.pid'), String(process.pid));
  assert.equal(v1Pid(v1), null, 'outro processo no PID: não é a V1');
});

// ---------------- desinstalar ----------------

test('desinstalar: limpa só a parte desta instalação no servidor e remove os arquivos locais (#60)', async (t) => {
  const { root, home, key } = installedRoot(t);
  fs.writeFileSync(`${key}.pub`, 'ssh-ed25519 AAAA server-dashboard');
  const id = installId('ssh-ed25519 AAAA');
  fs.writeFileSync(path.join(root, 'data', 'ssh', 'config'), `Host servidor\n  HostName 192.0.2.10\n  Port 22\n  IdentityFile "${key}"\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'data', 'history'));
  // confirma, limpa o servidor, sem apelido (usuário e senha), usuário, senha, mantém o histórico
  const answers = ['s', 's', '', 'maria', 'certa', 'n'];
  const admin = [];
  const o = memOut();
  const code = await desinstalar({
    out: o.out, root, home,
    deps: {
      interactive: true, ask: async () => answers.shift(), stopPanel: async () => ({}), removeService: () => true,
      runAdmin: async (opts) => { admin.push(opts); return { code: 0, stdout: '@@restam 1\n@@ok removido\n', stderr: '' }; },
    },
  });
  assert.equal(code, 0, o.text());
  assert.equal(admin[0].host, '192.0.2.10');
  assert.match(admin[0].script, /grep -vF ' AAAA ' authorized_keys/, 'tira a linha da chave deste painel');
  assert.match(admin[0].script, new RegExp(`-name 'dashboard-\\*-${id}\\*' -delete`), 'e só o sudoers desta instalação');
  assert.match(admin[0].script, /if \[ "\$R" = 0 \]; then userdel -r dashmon/, 'o dashmon só sai sem nenhuma linha');
  assert.match(o.text(), new RegExp(`sudo find /etc/sudoers\\.d -maxdepth 1 -name 'dashboard-\\*-${id}\\*' -delete`), 'os comandos à mão também');
  assert.doesNotMatch(o.text(), /sudo userdel -r dashmon;/, 'nunca manda apagar o dashmon direto');
  assert.match(o.text(), /✓ servidor limpo \(linha e regra de sudo deste computador removidas; o usuário dashmon fica para a outra linha\)/);
  assert.match(admin[0].script, /sudo -S -k -p '' \/bin\/sh -s/);
  assert.match(o.text(), /✓ servidor limpo/);
  assert.match(o.text(), /✓ serviço de usuário removido/);
  assert.equal(fs.existsSync(key), false);
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'ssh')), false);
  assert.ok(fs.existsSync(path.join(root, 'data', 'history')), 'histórico mantido');

  const noTty = memOut();
  assert.equal(await desinstalar({ out: noTty.out, root, home, deps: { interactive: false } }), 2);
  const no = memOut();
  assert.equal(await desinstalar({ out: no.out, root, home, deps: { interactive: true, ask: async () => 'n' } }), 0);
  assert.match(no.text(), /nada foi removido/);
  const all = memOut();
  assert.equal(await desinstalar({ out: all.out, root, home, args: ['--sim', '--apagar-historico'], deps: { interactive: false, stopPanel: async () => ({}), removeService: () => false } }), 0);
  assert.equal(fs.existsSync(path.join(root, 'data')), false);

  // Servidor que só aceita chave (#61): o apelido dá o usuário e a chave; a senha é só a do sudo.
  const chave = installedRoot(t);
  fs.writeFileSync(`${chave.key}.pub`, 'ssh-ed25519 AAAA server-dashboard');
  fs.writeFileSync(path.join(chave.root, 'data', 'ssh', 'config'), `Host servidor\n  HostName 192.0.2.10\n  Port 22\n  IdentityFile "${chave.key}"\n`, { mode: 0o600 });
  const kc = [];
  const agente = { ok: false, motivo: 'falta', comando: 'ssh-add -t 15m ~/.ssh/chave_admin' };
  const kdeps = {
    interactive: false, ask: async () => 'certa', stopPanel: async () => ({}), removeService: () => false,
    resolveAlias: async (alias) => ({ ok: true, alias, host: '192.0.2.10', port: 22, user: 'maria', identityFile: '/home/maria/.ssh/chave_admin', identityAgent: '/tmp/agente.sock' }),
    checkAgentKey: async () => agente,
    runAdmin: async (o2) => { kc.push(o2); return { code: 0, stdout: '@@restam 0\n@@ok removido\n', stderr: '' }; },
  };
  const kArgs = ['--sim', '--limpar-servidor', '--chave-ssh', 'meu-servidor', '--senha-stdin'];
  const k1 = memOut();
  assert.equal(await desinstalar({ out: k1.out, root: chave.root, home: chave.home, args: kArgs, deps: kdeps }), 0);
  assert.equal(kc.length, 0, 'sem a chave no agente, nenhuma conexão');
  assert.match(k1.text(), /rode no seu terminal: ssh-add -t 15m ~\/\.ssh\/chave_admin/);
  const chave2 = installedRoot(t);
  fs.writeFileSync(`${chave2.key}.pub`, 'ssh-ed25519 AAAA server-dashboard');
  fs.writeFileSync(path.join(chave2.root, 'data', 'ssh', 'config'), `Host servidor\n  HostName 192.0.2.10\n  Port 22\n  IdentityFile "${chave2.key}"\n`, { mode: 0o600 });
  Object.assign(agente, { ok: true, via: 'agente' });
  const k2 = memOut();
  assert.equal(await desinstalar({ out: k2.out, root: chave2.root, home: chave2.home, args: kArgs, deps: kdeps }), 0);
  assert.deepEqual([kc[0].user, kc[0].password, kc[0].identityFile, kc[0].identityAgent], ['maria', '', '/home/maria/.ssh/chave_admin', '/tmp/agente.sock']);
  assert.match(kc[0].script, /^P='certa'$/m, 'a senha lida é a do sudo, pelo stdin do sudo');
  assert.match(k2.text(), /✓ servidor limpo \(usuário dashmon e regra de sudo removidos\)/);

  // Sem o .pub não dá para saber qual linha é deste computador: o servidor fica como está.
  const semPub = installedRoot(t);
  fs.writeFileSync(path.join(semPub.root, 'data', 'ssh', 'config'), `Host servidor\n  HostName 192.0.2.10\n  IdentityFile "${semPub.key}"\n`, { mode: 0o600 });
  const calls = [];
  const sp = memOut();
  assert.equal(await desinstalar({
    out: sp.out, root: semPub.root, home: semPub.home, args: ['--sim', '--limpar-servidor', '--usuario', 'maria'],
    deps: { interactive: false, stopPanel: async () => ({}), removeService: () => false, runAdmin: async (o2) => { calls.push(o2); return { code: 0, stdout: '' }; } },
  }), 0);
  assert.equal(calls.length, 0, 'nenhuma conexão com o servidor');
  assert.match(sp.text(), /o servidor não foi alterado \(não achei a chave pública deste painel/);
});

// ---------------- comando no PATH (F4) ----------------

// Link ~/.local/bin/dashboard criado de verdade; `env` é o PATH do diagnóstico.
function comLink(t) {
  const inst = installedRoot(t);
  const bin = path.join(inst.home, '.local', 'bin');
  fs.writeFileSync(path.join(inst.root, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(inst.root, 'dashboard'), path.join(bin, 'dashboard'));
  return { ...inst, bin };
}
const diagComando = async ({ root, home }, env, pacotes = []) => {
  const o = memOut();
  await diagnosticar({ out: o.out, root, home, deps: { env, pacotes, now: Date.now(), panelStatus: () => ({ running: false }), collect: async () => ({ ok: false, error: 'x' }) } });
  return o.text();
};
const seca = { stopPanel: async () => ({}), removeService: () => false, interactive: false };

test('desinstalar: tira o link e só o bloco do arquivo de login', async (t) => {
  const { root, home } = comLink(t);
  const profile = path.join(home, '.profile');
  fs.writeFileSync(profile, 'umask 022\n');
  editarArquivoDeLogin({ home, env: {} });
  const o = memOut();
  assert.equal(await desinstalar({ out: o.out, root, home, args: ['--sim'], deps: seca }), 0, o.text());
  assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'dashboard')), false);
  assert.equal(fs.readFileSync(profile, 'utf8'), 'umask 022\n');
  assert.match(o.text(), /✓ comando dashboard removido/);
  assert.match(o.text(), /✓ PATH retirado do ~\/\.profile/);
});

test('desinstalar: com o link em outra pasta, o link e o bloco ficam', async (t) => {
  const { root, home } = installedRoot(t);
  const outra = tmp(t, 'dash-outra-');
  fs.mkdirSync(path.join(outra, 'server', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(outra, 'server', 'cli', 'index.js'), '');
  fs.writeFileSync(path.join(outra, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(outra, 'dashboard'), path.join(bin, 'dashboard'));
  editarArquivoDeLogin({ home, env: {} });
  const o = memOut();
  assert.equal(await desinstalar({ out: o.out, root, home, args: ['--sim'], deps: seca }), 0, o.text());
  assert.ok(fs.lstatSync(path.join(bin, 'dashboard')));
  assert.match(fs.readFileSync(path.join(home, '.profile'), 'utf8'), /server-dashboard/);
  assert.ok(o.text().includes(`O comando dashboard continua: ele vale para ${fs.realpathSync(outra)}`), o.text());
});

test('desinstalar: arquivo de login sem escrita vira aviso, e a desinstalação termina', { skip: process.getuid?.() === 0 && 'root ignora a permissão' }, async (t) => {
  const { root, home } = comLink(t);
  editarArquivoDeLogin({ home, env: {} });
  const profile = path.join(home, '.profile');
  fs.chmodSync(profile, 0o444);
  const o = memOut();
  assert.equal(await desinstalar({ out: o.out, root, home, args: ['--sim'], deps: seca }), 0, o.text());
  assert.match(o.text(), /▲ não consegui editar o ~\/\.profile \(apague à mão o bloco server-dashboard\)/);
});

// Pasta do autocomplete, com o link desta instalação (como a instalação deixa).
function comAutocomplete({ root, home }) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'completar.bash'), '');
  const dir = path.join(home, '.local', 'share', 'bash-completion', 'completions');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(root, 'scripts', 'completar.bash'), path.join(dir, 'dashboard'));
  return path.join(dir, 'dashboard');
}

test('desinstalar: remove o link do autocomplete e o bloco do ~/.bashrc', async (t) => {
  const { root, home } = comLink(t);
  const link = comAutocomplete({ root, home });
  fs.writeFileSync(path.join(home, '.bashrc'), 'alias l=ls\n\n# >>> server-dashboard >>>\nx\n# <<< server-dashboard <<<\n');
  const o = memOut();
  assert.equal(await desinstalar({ out: o.out, root, home, args: ['--sim'], deps: { ...seca, env: {} } }), 0, o.text());
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(path.join(home, '.bashrc'), 'utf8'), 'alias l=ls\n');
  assert.match(o.text(), /✓ autocomplete removido/);
  assert.match(o.text(), /✓ autocomplete retirado do ~\/\.bashrc/);
});

test('diagnosticar: mostra o autocomplete e a linha do source, sem contar aviso', async (t) => {
  const c = comLink(t);
  const env = { PATH: c.bin };
  assert.match(await diagComando(c, env), /Autocomplete com Tab: não criado para esta pasta\. Para criar, rode dashboard reconfigurar\./);
  const link = comAutocomplete(c);
  const sem = await diagComando(c, env);
  assert.match(sem, /Autocomplete com Tab: falta o pacote bash-completion.*source "\$HOME\/\.local\/share\/bash-completion\/completions\/dashboard"/);
  assert.doesNotMatch(sem, /▲.*utocomplete/);
  assert.match(await diagComando(c, env, ['/']), /✓ autocomplete com Tab \(~\/\.local\/share/, 'com o pacote');
  fs.rmSync(link);
  fs.writeFileSync(link, 'do usuário');
  assert.match(await diagComando(c, env), /Autocomplete com Tab: ~\/\.local\/share\/bash-completion\/completions\/dashboard é outro arquivo/);
});

test('diagnosticar: confere o link e o PATH', async (t) => {
  const c = comLink(t);
  assert.match(await diagComando(c, { PATH: c.bin }), /✓ comando dashboard no PATH/);

  const login = await diagComando(c, { PATH: '/usr/bin' });
  assert.match(login, /▲ ~\/\.local\/bin não está no PATH/);
  assert.ok(login.includes(`no ~/.profile: ${LINHA_PATH}`), login);

  fs.writeFileSync(path.join(c.home, '.profile'), 'PATH="$HOME/.local/bin:$PATH"\n');
  const proximo = await diagComando(c, { PATH: '/usr/bin' });
  assert.match(proximo, /✓ comando dashboard criado \(vale no próximo login\)/);
  assert.doesNotMatch(proximo, /não está no PATH/, 'não conta como aviso: a instalação já explicou');

  const antes = tmp(t, 'dash-antes-');
  fs.writeFileSync(path.join(antes, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
  assert.ok((await diagComando(c, { PATH: `${antes}:${c.bin}` })).includes(`▲ outro dashboard vem antes no PATH (${path.join(antes, 'dashboard')})`));
});

test('diagnosticar: sem link é escolha, não aviso; link estranho é explicado', async (t) => {
  const c = installedRoot(t);
  const link = path.join(c.home, '.local', 'bin', 'dashboard');
  const sem = await diagComando(c, { PATH: '/usr/bin' });
  assert.match(sem, /Comando dashboard no PATH: não criado\. Para criar, rode \.\/dashboard reconfigurar\./);
  assert.doesNotMatch(sem, /▲.*comando/i);

  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(link, 'outro\n');
  assert.match(await diagComando(c, { PATH: '/usr/bin' }), /é outro programa/);

  fs.rmSync(link);
  fs.symlinkSync('/nao/existe/dashboard', link);
  assert.match(await diagComando(c, { PATH: '/usr/bin' }), /▲ o comando dashboard aponta para uma pasta que não existe mais \(\/nao\/existe\/dashboard\)/);

  const outra = tmp(t, 'dash-outra-');
  fs.mkdirSync(path.join(outra, 'server', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(outra, 'server', 'cli', 'index.js'), '');
  fs.writeFileSync(path.join(outra, 'dashboard'), '#!/bin/sh\n', { mode: 0o755 });
  fs.rmSync(link);
  fs.symlinkSync(path.join(outra, 'dashboard'), link);
  assert.match(await diagComando(c, { PATH: '/usr/bin' }), /▲ o comando dashboard vale para outra pasta/);
});
