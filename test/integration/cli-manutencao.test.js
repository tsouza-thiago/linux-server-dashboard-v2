// Manutenção pelo comando `dashboard` (F7): diagnosticar, atualizar (tags assinadas de
// verdade num repositório temporário, com volta atrás), upgrade V1→V2 e desinstalar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOutput } from '../../server/cli/saida.js';
import { diagnosticar, latestSample, permissionProblems, explainFailure } from '../../server/cli/diagnosticar.js';
import { atualizar, afterUpdate, backupData, restoreData } from '../../server/cli/atualizar.js';
import { importarV1, detectV1, v1Settings, v1Pid, stopV1 } from '../../server/cli/importar-v1.js';
import { desinstalar } from '../../server/cli/desinstalar.js';
import { loadEnvFile } from '../../server/config.js';

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
  return { work, clone, release, g };
}

const gitRun = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, env: GIT_ENV });

test('atualizar: só tag assinada pela chave instalada; backup, troca e volta atrás se falhar', { skip: !hasGit }, async (t) => {
  const { clone, release, g } = releaseRepos(t);
  const deps = { run: gitRun, gitRun, stopPanel: async () => ({}), startPanel: async () => ({ ok: true }), panelStatus: () => ({ running: true }) };
  const a = memOut();
  assert.equal(await atualizar({ out: a.out, root: clone, deps: { ...deps, reexec: () => 0 } }), 0);
  assert.match(a.text(), /você já está na versão mais nova \(v2\.0\.0-alpha\.8\)/);

  release('2.0.0-alpha.9', { key: 'outra' }); // assinada por outra chave: ignorada
  const b = memOut();
  await atualizar({ out: b.out, root: clone, deps: { ...deps, reexec: () => 0 } });
  assert.match(b.text(), /já está na versão mais nova/);

  release('2.0.0-alpha.10');
  const calls = [];
  const c = memOut();
  const ok = await atualizar({ out: c.out, root: clone, deps: { ...deps, reexec: (args) => { calls.push(args); return 0; } } });
  assert.equal(ok, 0, c.text());
  assert.match(c.text(), /✓ versão nova encontrada: v2\.0\.0-alpha\.10/);
  assert.match(c.text(), /✓ cópia de segurança de data\/ feita \(\.backups\/.*-v2\.0\.0-alpha\.8\)/);
  assert.match(c.text(), /✓ atualizado de v2\.0\.0-alpha\.8 para v2\.0\.0-alpha\.10/);
  assert.deepEqual(calls, [['atualizar', '--pos-atualizacao']], 'a versão nova liga o painel');
  assert.equal(g(clone, 'describe', '--tags', '--exact-match'), 'v2.0.0-alpha.10');

  release('2.0.0-alpha.11', { broken: true });
  const d = memOut();
  const bad = await atualizar({
    out: d.out, root: clone,
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
  assert.equal(await atualizar({ out: e.out, root: clone, deps: { ...deps, reexec: () => 0 } }), 1);
  assert.match(e.text(), /há arquivos do painel alterados/);
});

test('atualizar: pasta sem git; fase 2 liga o painel e confere a saúde', async (t) => {
  const root = tmp(t, 'dash-upd-nogit-');
  const a = memOut();
  assert.equal(await atualizar({ out: a.out, root }), 1);
  assert.match(a.text(), /não veio de um git clone/);
  const home = tmp(t, 'dash-upd-home-');
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
  const again = memOut();
  await importarV1({ out: again.out, root, dir: v1, home, deps: { stopV1: async () => [], hasSystemdUser: () => false, startPanel: async () => ({ ok: true }), waitForPort: async () => true } });
  assert.match(again.text(), /nenhum dado novo para copiar/, 'não sobrescreve o que a V2 já tem');

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
  await new Promise((r) => setTimeout(r, 150));
  fs.writeFileSync(path.join(v1, 'data', 'dashboard.pid'), String(proc.pid));
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

test('desinstalar: limpa o servidor com os comandos de sempre e remove os arquivos locais', async (t) => {
  const { root, home, key } = installedRoot(t);
  fs.writeFileSync(`${key}.pub`, 'ssh-ed25519 AAAA server-dashboard');
  fs.writeFileSync(path.join(root, 'data', 'ssh', 'config'), `Host servidor\n  HostName 192.0.2.10\n  Port 22\n  IdentityFile "${key}"\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'data', 'history'));
  const answers = ['s', 's', 'maria', 'certa', 'n'];
  const admin = [];
  const o = memOut();
  const code = await desinstalar({
    out: o.out, root, home,
    deps: {
      interactive: true, ask: async () => answers.shift(), stopPanel: async () => ({}), removeService: () => true,
      runAdmin: async (opts) => { admin.push(opts); return { code: 0, stdout: '@@ok removido\n', stderr: '' }; },
    },
  });
  assert.equal(code, 0, o.text());
  assert.equal(admin[0].host, '192.0.2.10');
  assert.match(admin[0].script, /userdel -r dashmon/);
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
});
