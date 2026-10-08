// Os 6 passos da instalação (server/setup/instalacao.js) com servidor, ssh e systemd
// falsos: ordem, validações, senha só em memória até o fim do passo 5, modo assistido e
// manual, arquivos gravados e o link de entrada no final.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Instalacao, currentServer, STEPS } from '../../server/setup/instalacao.js';
import { loadEnvFile } from '../../server/config.js';
import { parseOutput } from '../../server/collector/parser.js';
import { targetsHash } from '../../server/collector/builder.js';
import { consumeLoginCode } from '../../server/http/entrar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(HERE, '..', 'fixtures', 'instalacao', 'deteccao-debian12.txt'), 'utf8');
const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAICLXaq8Zb0WG4QWeKtFRHjyahVNxZFkczJ5it2xMlpU2';

/** Servidor falso: responde à detecção, ao preparo e às coletas. */
function fakeServer({ sudoOk = true, smartPerm = true, detection = FIXTURE } = {}) {
  const calls = [];
  const srv = {
    calls,
    async runAdmin(opts) {
      calls.push({ kind: 'admin', password: opts.password, script: opts.script });
      if (opts.password && opts.password !== 'certa') return { code: 255, stdout: '', stderr: 'Permission denied (password).' };
      if (opts.script.includes('===WHO===')) return { code: 0, stdout: detection, stderr: '' };
      if (opts.script.includes("id -u dashmon >/dev/null 2>&1 && echo '@@ok usuario'")) return { code: 0, stdout: srv.dashmon ? '@@ok usuario\n/bin/sh\n' : '', stderr: '' };
      if (!sudoOk) return { code: 9, stdout: '@@erro senha\n', stderr: '' };
      srv.dashmon = true;
      srv.prepared = opts.script;
      return { code: 0, stdout: '@@ok usuario\n@@ok chave\n@@ok sudoers\n', stderr: '' };
    },
    async collect({ targets, access, runner }) {
      calls.push({ kind: 'collect', targets, access, runner });
      if (!srv.dashmon) return { ok: false, error: 'SSH falhou (exit 255) — host não encontrado ou chave inválida' };
      const smart = targets.smartDevs.map((d) => `${d} ${smartPerm ? 'PASSED' : 'SEM_PERMISSAO'}`).join('\n');
      const out = [
        '===VER===', `2 ${targetsHash(targets)}`, targets.smartDevs.length ? 'smart' : 'basico', '===HOST===', 'servidor-casa',
        '===MEM===', 'MemTotal: 8000000 kB', 'MemFree: 1000000 kB', 'MemAvailable: 2320000 kB',
        '===DF===', 'Filesystem 1B-blocks Used Avail Use% IUse% Mounted', '/dev/sdb1 /mnt/dados 100 64 36 64% 1%',
        ...(targets.smartDevs.length ? ['===SMART===', smart] : []),
        '===SERVICES===', ...targets.services.map((s) => `${s} active`), '===FIM===',
      ].join('\n');
      const sample = parseOutput(out, new Date().toISOString(), { targets });
      sample.collector.hashMismatch = sample.collector.hash !== targetsHash(targets);
      sample.collector.durationMs = 910;
      sample.collector.outputBytes = 6200;
      return { ok: true, sample };
    },
  };
  return srv;
}

function setup(t, serverOpts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-inst-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-inst-home-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, '.env.example'), 'SSH_HOST=seu_host\nPORT=3999\nDASH_TOKEN=\n');
  const srv = fakeServer(serverOpts);
  const services = [];
  const inst = new Instalacao({
    root,
    home,
    deps: {
      probePort: async (host) => (host === '192.0.2.99' ? { ok: false, reason: 'sem-resposta' } : { ok: true, ms: 3 }),
      scanHostKeys: async () => [{ type: 'ssh-ed25519', key: ED, fingerprint: 'SHA256:8oOm2IqGGSLMQ94IC6SBJJ/EIGqCSF6BhAsYUkBWlXw' }],
      runAdmin: srv.runAdmin,
      collect: srv.collect,
      hasSystemdUser: () => true,
      installService: async (o) => { services.push(o); return { ok: true, hardening: true }; },
      startPanel: async () => ({ ok: true }),
      versionStatus: () => ({ ok: true, tag: 'v2.0.0-alpha.8' }),
    },
  });
  return { inst, srv, root, home, services };
}

async function throughStep4(inst) {
  await inst.definirServidor({ host: '192.0.2.10', user: 'maria' });
  await inst.lerIdentidade();
  return inst.conectar({ senha: 'certa', confirmo: true });
}

test('instalação: 6 passos com os nomes das pranchetas', () => {
  assert.deepEqual(STEPS, ['Boas-vindas', 'Servidor', 'Conectar', 'O que monitorar', 'Preparar servidor', 'Pronto']);
});

test('passo 1–3: verificações, servidor validado, identidade antes da senha', async (t) => {
  const { inst, srv } = setup(t);
  const chk = inst.verificarComputador();
  assert.deepEqual([chk.versao.ok, chk.versao.texto, chk.local.texto, chk.porta, chk.reconfigurar], [true, 'versão v2.0.0-alpha.8 assinada', 'painel só nesta máquina (127.0.0.1)', 3000, false]);
  await assert.rejects(() => inst.definirServidor({ host: '-oProxyCommand=x', user: 'maria' }), (e) => e.field === 'host');
  await assert.rejects(() => inst.definirServidor({ host: '192.0.2.10', user: 'ma ria' }), (e) => e.field === 'user');
  await assert.rejects(() => inst.definirServidor({ host: '192.0.2.10', user: 'maria', port: 0 }), (e) => e.field === 'port');
  await assert.rejects(() => inst.definirServidor({ host: '192.0.2.99', user: 'maria' }), /Ninguém respondeu/);
  await assert.rejects(() => inst.lerIdentidade(), /servidor primeiro/);
  assert.deepEqual(await inst.definirServidor({ host: ' 192.0.2.10 ', user: 'maria', port: '' }), { host: '192.0.2.10', user: 'maria', port: 22, ms: 3 });
  await assert.rejects(() => inst.conectar({ senha: 'certa', confirmo: true }), /identidade do servidor primeiro/);
  const id = await inst.lerIdentidade();
  assert.deepEqual(id.blocos.slice(0, 3), ['8oOm', '2IqG', 'GSLM']);
  assert.equal(id.conhecida, false);
  await assert.rejects(() => inst.conectar({ senha: 'certa' }), (e) => e.field === 'confirmo', 'sem confirmar a identidade, a senha não sai');
  assert.equal(srv.calls.length, 0);
  await assert.rejects(() => inst.conectar({ senha: 'errada', confirmo: true }), /recusou a entrada/);
  assert.equal(inst.temSenha, false, 'senha errada não fica');
  const det = await inst.conectar({ senha: 'certa', confirmo: true });
  assert.equal(inst.temSenha, true, 'guardada só em memória até o passo 5');
  assert.equal((await inst.lerIdentidade()).conhecida, true, 'a identidade confirmada foi gravada');
  assert.deepEqual([det.sudoTexto, det.podePreparar, det.smartPossivel, det.clientIp], ['sudo disponível', true, true, '192.0.2.50']);
  assert.equal(det.pastas.find((p) => p.target === '/boot/efi').nota, 'pequena e quase nunca muda');
  assert.deepEqual(det.escolhas.smart, ['sda', 'sdb', 'sdc']);
  assert.ok(det.custo.seconds > 0);
});

test('passo 4: só o que existe no servidor e limiares nas faixas', async (t) => {
  const { inst } = setup(t);
  await throughStep4(inst);
  const base = { mounts: ['/', '/mnt/dados'], smart: ['sdb'], netIf: 'enp3s0', services: ['smbd'] };
  assert.throws(() => inst.definirEscolhas({ ...base, mounts: [] }), (e) => e.field === 'mounts');
  assert.throws(() => inst.definirEscolhas({ ...base, mounts: ['/etc'] }), /Pasta desconhecida/);
  assert.throws(() => inst.definirEscolhas({ ...base, smart: ['sdc'] }), /SMART só em discos das pastas escolhidas/);
  assert.throws(() => inst.definirEscolhas({ ...base, netIf: 'eth9' }), /Interface/);
  assert.throws(() => inst.definirEscolhas({ ...base, services: ['dbus'] }), /Serviço desconhecido/);
  assert.throws(() => inst.definirEscolhas({ ...base, limiares: { diskPct: 101 } }), (e) => e.field === 'diskPct');
  const r = inst.definirEscolhas({ ...base, limiares: { tempC: '65' } });
  assert.deepEqual(r.escolhas, { mounts: ['/', '/mnt/dados'], smart: ['sdb'], io: ['sda', 'sdb'], netIf: 'enp3s0', services: ['smbd'] });
  assert.deepEqual(r.limiares, { diskPct: 90, ramPct: 90, tempC: 65 });
});

test('passo 5 assistido → 6: prepara, testa a coleta, grava tudo e descarta a senha', async (t) => {
  const { inst, srv, root, home, services } = setup(t);
  await throughStep4(inst);
  inst.definirEscolhas({ mounts: ['/', '/mnt/dados'], smart: ['sda', 'sdb'], netIf: 'enp3s0', services: ['smbd', 'nmbd'] });
  const plano = inst.planoPreparo({ from: true });
  assert.deepEqual(plano.acoes.map((a) => a.id), ['sudo', 'usuario', 'chave', 'sudoers', 'teste']);
  assert.equal(plano.podeAssistido, true);
  assert.equal(plano.from, true);
  assert.match(plano.comandos, /restrict,from="192\.0\.2\.50"/);
  assert.ok(fs.existsSync(path.join(home, '.ssh', 'dashboard_ed25519')), 'chave criada');
  assert.throws(() => inst.tokenReserva(), /Termine a preparação/);
  const r = await inst.prepararAssistido();
  assert.equal(r.ok, true, r.erro);
  assert.deepEqual(r.feitos, ['sudo', 'usuario', 'chave', 'sudoers', 'teste']);
  assert.deepEqual(r.resumo, { duracaoMs: 910, bytes: 6200, memoriaPct: 71, discoPct: 64, discoMount: '/mnt/dados', temperaturaC: null, servicosAtivos: 2, servicosTotal: 2 });
  assert.equal(inst.temSenha, false, 'senha descartada depois do preparo');
  assert.match(srv.prepared, /sudo -S -k -p '' \/bin\/sh -s/);
  const collect = srv.calls.filter((c) => c.kind === 'collect').at(-1);
  assert.equal(collect.access, 'restrito');
  assert.deepEqual(collect.targets.smartDevs, ['sda', 'sdb']);

  const env = loadEnvFile(path.join(root, '.env'));
  assert.deepEqual(
    [env.SSH_HOST, env.SSH_CONFIG, env.SSH_ACESSO, env.DISK_MOUNTS, env.DISK_DEVS, env.SMART_DEVS, env.NET_IF, env.SERVICES, env.PORT],
    ['servidor', 'data/ssh/config', 'restrito', '/ /mnt/dados', 'sda sdb', 'sda sdb', 'enp3s0', 'smbd nmbd', '3999'],
  );
  assert.deepEqual(currentServer(root), { host: '192.0.2.10', port: 22 });
  assert.match(fs.readFileSync(path.join(root, 'data', 'ssh', 'known_hosts'), 'utf8'), /^192\.0\.2\.10 ssh-ed25519 /);

  const token = inst.tokenReserva();
  assert.ok(token.length >= 40);
  assert.throws(() => inst.tokenReserva(), /já foi mostrado/);
  inst.concluir({ iniciarComComputador: true, atalho: true });
  assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'applications', 'server-dashboard.desktop')));
  const lig = await inst.ligarPainel({ iniciarComComputador: true });
  assert.equal(lig.ok, true);
  assert.equal(services[0].enable, true);
  const code = new URL(lig.url).searchParams.get('codigo');
  assert.match(lig.url, /^http:\/\/127\.0\.0\.1:3999\/entrar\?codigo=/);
  assert.equal(consumeLoginCode(path.join(root, 'data'), code), true, 'link de uso único válido');
  assert.equal(inst.verificarComputador().reconfigurar, true);
});

test('passo 5: sudo recusa a senha → volta a pedir; sem SMART liberado → o teste aponta o disco', async (t) => {
  const a = setup(t, { sudoOk: false });
  await throughStep4(a.inst);
  a.inst.definirEscolhas({ mounts: ['/'], smart: [], netIf: '', services: [] });
  a.inst.planoPreparo({ from: false });
  const r = await a.inst.prepararAssistido();
  assert.equal(r.ok, false);
  assert.equal(r.precisaSenha, true);
  assert.match(r.erro, /Parou em "Confirmar que você pode usar sudo": o sudo recusou a senha/);
  assert.equal(a.inst.temSenha, false);
  await assert.rejects(() => a.inst.prepararAssistido(), (e) => e.field === 'senha');

  const b = setup(t, { smartPerm: false });
  await throughStep4(b.inst);
  b.inst.definirEscolhas({ mounts: ['/', '/mnt/dados', '/mnt/backup'], smart: ['sda', 'sdb', 'sdc'], netIf: 'enp3s0', services: [] });
  b.inst.planoPreparo();
  const s = await b.inst.prepararAssistido();
  assert.equal(s.ok, false);
  assert.match(s.erro, /ainda não libera o teste de sda, sdb, sdc\. Copie o bloco de novo: ele já inclui os 3 discos\./);
});

test('passo 5 manual: cada bloco é testado sem mudar nada; Continuar só com os 4 conferidos', async (t) => {
  const { inst, srv } = setup(t);
  await throughStep4(inst);
  inst.definirEscolhas({ mounts: ['/'], smart: ['sda'], netIf: 'enp3s0', services: [] });
  const plano = inst.planoPreparo({ from: true });
  assert.deepEqual(plano.blocos.map((b) => b.id), ['usuario', 'chave', 'sudoers', 'pronto']);
  const u = await inst.testarBloco('usuario');
  assert.equal(u.ok, false);
  assert.match(u.erro, /ainda não existe/);
  srv.dashmon = true; // a pessoa colou os blocos no servidor
  assert.equal((await inst.testarBloco('usuario')).ok, true);
  assert.deepEqual(await inst.testarBloco('chave'), { ok: true, resumo: inst.resumoTeste(), sample: undefined, conferidos: 2, total: 4, concluido: false });
  assert.equal((await inst.testarBloco('sudoers')).ok, true);
  const last = await inst.testarBloco('pronto');
  assert.deepEqual([last.conferidos, last.concluido], [4, true]);
  assert.equal(inst.temSenha, false);
  await assert.rejects(() => inst.testarBloco('outro'), /desconhecido/);
});

test('ligar o painel: sem "iniciar com o computador", o serviço existente fica sem enable', async (t) => {
  const { inst, home, services } = setup(t);
  await throughStep4(inst);
  inst.definirEscolhas({ mounts: ['/'], smart: [], netIf: '', services: [] });
  inst.planoPreparo();
  await inst.prepararAssistido();
  inst.concluir({ iniciarComComputador: false, atalho: false });
  const r1 = await inst.ligarPainel({ iniciarComComputador: false });
  assert.equal(r1.ok, true);
  assert.equal(services.length, 0, 'sem serviço instalado: só segundo plano');
  fs.mkdirSync(path.join(home, '.config', 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'server-dashboard.service'), '');
  await inst.ligarPainel({ iniciarComComputador: false });
  assert.equal(services[0].enable, false);
});
