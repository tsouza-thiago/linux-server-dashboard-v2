// Unidades systemd do executor (pacote/systemd/, F9 etapa 5, ADR 0042 item 7 e ADR 0045).
// Parte estática: lê os arquivos e exige cada diretiva de isolamento, o comando fixo sem
// parâmetro de fora e as pastas de gravação mínimas. Parte com o systemd: `systemd-analyze
// verify` numa raiz falsa e `systemd-analyze security --offline` com a nota máxima fixada aqui.
// Sem o systemd-analyze, esta parte pula com o motivo; no CI (CI=true) ela falha, porque o
// runner do GitHub tem a ferramenta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../server/config.js';
import { aoFim } from '../../test-support/limpeza.js';

const PASTA = path.join(ROOT, 'pacote', 'systemd');
const BASE = '/opt/server-dashboard';
const SUBCOMANDOS = ['verificar', 'atualizar', 'voltar'];
const TIMER = 'server-dashboard-verificar.timer';
const servico = (sub) => `server-dashboard-${sub}.service`;

// Nota máxima aceita do `systemd-analyze security` (0 = isolado, 10 = exposto). Medida no
// systemd 259: verificar 1,1 (precisa de rede) e 0,2 nos outros. A folga cobre versões do
// systemd que pesam as diretivas de outro jeito; subir este número pede uma ADR nova.
const NOTA_MAXIMA = { verificar: 1.5, atualizar: 0.5, voltar: 0.5 };

// Isolamento que as 3 unidades exigem (ADR 0042, item 7, e ADR 0045), com o valor exato.
const ISOLAMENTO = {
  User: '_server-dashboard',
  Group: '_server-dashboard',
  NoNewPrivileges: 'yes',
  PrivateUsers: 'yes',
  ProtectSystem: 'strict',
  ProtectHome: 'yes',
  PrivateTmp: 'yes',
  PrivateDevices: 'yes',
  DevicePolicy: 'closed',
  PrivateIPC: 'yes',
  RemoveIPC: 'yes',
  ProtectKernelTunables: 'yes',
  ProtectKernelModules: 'yes',
  ProtectKernelLogs: 'yes',
  ProtectControlGroups: 'yes',
  ProtectClock: 'yes',
  ProtectHostname: 'yes',
  ProtectProc: 'invisible',
  ProcSubset: 'pid',
  RestrictNamespaces: 'yes',
  RestrictRealtime: 'yes',
  RestrictSUIDSGID: 'yes',
  LockPersonality: 'yes',
  MemoryDenyWriteExecute: 'yes',
  CapabilityBoundingSet: '',
  AmbientCapabilities: '',
  SystemCallArchitectures: 'native',
  SystemCallFilter: ['@system-service', '~@privileged @resources'],
  SystemCallErrorNumber: 'EPERM',
  Type: 'oneshot',
};

// Por unidade: rede e pastas de gravação. Só o verificar sai para a rede (git fetch).
const POR_UNIDADE = {
  verificar: { rede: ['AF_INET AF_INET6'], privada: null, grava: ['repo.git', 'estado'] },
  atualizar: { rede: ['none'], privada: 'yes', grava: ['versoes', 'estado'] },
  voltar: { rede: ['none'], privada: 'yes', grava: ['versoes', 'estado'] },
};

/** Lê um arquivo de unidade: { secoes: [nomes], d: { Chave: [valores na ordem] } }. */
function ler(nome) {
  const texto = fs.readFileSync(path.join(PASTA, nome), 'utf8');
  const secoes = [];
  const d = {};
  for (const linha of texto.split('\n')) {
    if (/^\s*(#|$)/.test(linha)) continue;
    const s = linha.match(/^\[(\w+)\]$/);
    if (s) { secoes.push(s[1]); continue; }
    const m = linha.match(/^(\w+)=(.*)$/);
    assert.ok(m, `${nome}: linha fora do formato: ${linha}`);
    (d[m[1]] ??= []).push(m[2]);
  }
  return { texto, secoes, d };
}

test('unidades: o pacote traz só as 3 unidades de uso único e o timer', () => {
  const esperado = [...SUBCOMANDOS.map(servico), TIMER].sort();
  assert.deepEqual(fs.readdirSync(PASTA).sort(), esperado);
});

for (const sub of SUBCOMANDOS) {
  test(`unidades: ${sub} roda o comando fixo, sem parâmetro de fora e sem [Install]`, () => {
    const { texto, secoes, d } = ler(servico(sub));
    assert.deepEqual(secoes, ['Unit', 'Service']);
    // Caminho absoluto, subcomando fixo, sem prefixo (+, !, -, @) que mude privilégio ou erro.
    assert.deepEqual(d.ExecStart, [`${BASE}/libexec/atualizador ${sub}`]);
    // Nada de fora entra: nem especificador (%i, %I…), nem variável, nem outro comando.
    assert.doesNotMatch(texto.replace(/^#.*$/gm, ''), /[%$]/);
    for (const proibida of ['ExecStartPre', 'ExecStartPost', 'ExecStop', 'Environment', 'EnvironmentFile',
      'PassEnvironment', 'WorkingDirectory', 'RootDirectory', 'BindPaths', 'ReadOnlyPaths', 'InaccessiblePaths',
      'SupplementaryGroups']) {
      assert.equal(d[proibida], undefined, `${sub}: ${proibida}= não pode existir`);
    }
  });

  test(`unidades: ${sub} tem cada diretiva de isolamento`, () => {
    const { d } = ler(servico(sub));
    for (const [chave, valor] of Object.entries(ISOLAMENTO)) {
      assert.deepEqual(d[chave], [].concat(valor), `${sub}: ${chave}=`);
    }
    const u = POR_UNIDADE[sub];
    assert.deepEqual(d.RestrictAddressFamilies, u.rede, `${sub}: RestrictAddressFamilies=`);
    assert.deepEqual(d.PrivateNetwork, u.privada ? [u.privada] : undefined, `${sub}: PrivateNetwork=`);
    if (u.privada) assert.deepEqual(d.IPAddressDeny, ['any'], `${sub}: IPAddressDeny=`);
    // Gravação só nas pastas do executor, nunca na base (ela é do pacote, root) nem fora dela.
    assert.deepEqual(d.ReadWritePaths, [u.grava.map((p) => `${BASE}/${p}`).join(' ')], `${sub}: ReadWritePaths=`);
    // Limites de memória e de tempo, para uma falha não segurar a máquina.
    assert.match(d.MemoryMax?.[0] ?? '', /^\d+M$/, `${sub}: MemoryMax=`);
    assert.match(d.TimeoutStartSec?.[0] ?? '', /^\d+min$/, `${sub}: TimeoutStartSec=`);
  });
}

test('unidades: o timer roda o verificar 1 vez por dia, com atraso aleatório e Persistent=', () => {
  const { secoes, d } = ler(TIMER);
  assert.deepEqual(secoes, ['Unit', 'Timer', 'Install']);
  assert.deepEqual(d.Unit, [servico('verificar')]);
  assert.deepEqual(d.OnCalendar, ['daily']);
  assert.match(d.RandomizedDelaySec?.[0] ?? '', /^\d+h$/);
  assert.deepEqual(d.Persistent, ['true']);
  assert.deepEqual(d.WantedBy, ['timers.target']);
});

// --------------------------------------------------------- com o systemd-analyze

const temAnalyze = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' }).status === 0;
const semAnalyze = temAnalyze ? false : 'sem o systemd-analyze nesta máquina';
if (!temAnalyze && process.env.CI === 'true') {
  throw new Error('CI=true, mas o systemd-analyze não está instalado: as unidades ficariam sem conferência');
}

/** As pastas de unidades do systemd do sistema (Debian/Ubuntu antigos usam /lib). */
const pastaDoSistema = ['/usr/lib/systemd/system', '/lib/systemd/system'].find((p) => fs.existsSync(path.join(p, 'sysinit.target')));

test('unidades: systemd-analyze verify aceita as unidades numa raiz com o pacote', { skip: semAnalyze || (!pastaDoSistema && 'sem as unidades .target do systemd') }, (t) => {
  // Raiz falsa: o executor no lugar do pacote e os .target do sistema (o verify segue as
  // dependências padrão, como sysinit.target e timers.target).
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'unidades-'));
  aoFim(t, () => fs.rmSync(raiz, { recursive: true, force: true }));
  const libexec = path.join(raiz, 'opt', 'server-dashboard', 'libexec');
  const sistema = path.join(raiz, 'usr', 'lib', 'systemd', 'system');
  fs.mkdirSync(libexec, { recursive: true });
  fs.mkdirSync(sistema, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'libexec', 'atualizador'), path.join(libexec, 'atualizador'));
  fs.chmodSync(path.join(libexec, 'atualizador'), 0o755);
  for (const f of fs.readdirSync(pastaDoSistema).filter((n) => n.endsWith('.target'))) {
    fs.copyFileSync(path.join(pastaDoSistema, f), path.join(sistema, f));
  }
  const nossas = fs.readdirSync(PASTA);
  for (const f of nossas) fs.copyFileSync(path.join(PASTA, f), path.join(sistema, f));
  const r = spawnSync('systemd-analyze', ['verify', '--man=no', `--root=${raiz}`, ...nossas.map((f) => path.join(sistema, f))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // Aviso também reprova (diretiva desconhecida, valor ignorado…).
  assert.equal(r.stderr.trim(), '', r.stderr);
});

for (const sub of SUBCOMANDOS) {
  test(`unidades: systemd-analyze security dá a ${sub} nota até ${NOTA_MAXIMA[sub]}`, { skip: semAnalyze }, () => {
    const r = spawnSync('systemd-analyze', ['security', '--offline=yes', '--no-pager', path.join(PASTA, servico(sub))], { encoding: 'utf8' });
    const nota = Number(`${r.stdout}${r.stderr}`.match(/Overall exposure level for \S+: ([\d.]+)/)?.[1]);
    assert.ok(Number.isFinite(nota), `sem nota na saída: ${r.stdout}${r.stderr}`);
    assert.ok(nota <= NOTA_MAXIMA[sub], `${sub}: nota ${nota}, máxima ${NOTA_MAXIMA[sub]}\n${r.stdout}`);
  });
}
