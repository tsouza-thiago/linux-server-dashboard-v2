// Regra do polkit e grupos do pacote .deb (F9 etapa 6, ADR 0042 itens 2 e 5 e ADR 0046).
//
// A regra (pacote/polkit/50-server-dashboard.rules) é JavaScript do polkit. Aqui ela roda num `vm`
// com um `polkit` falso (`addRule`, `Result`) e é avaliada contra cada combinação de ação, unidade,
// verbo e grupo: só "grupo server-dashboard + manage-units + start + atualizar ou voltar" devolve
// YES; todo o resto não devolve nada e cai no padrão do polkit (senha do administrador).
//
// Por que não o `pkcheck`: ele pergunta ao polkitd do sistema, que só lê as regras de
// /etc/polkit-1/rules.d e /usr/share/polkit-1/rules.d (pastas do root). Sem root não dá para pôr
// esta regra lá, e um polkitd próprio precisa do barramento do sistema. O `pkaction`, que só lê,
// entra num teste extra: confere que a ação existe e que o padrão dela pede senha (o "cai no
// padrão" de cima é mesmo uma recusa sem senha). Sem o `pkaction`, esse teste pula.
//
// Os grupos (pacote/sysusers/server-dashboard.conf) passam pelo `systemd-sysusers --root` numa
// raiz falsa, sem root. Sem a ferramenta, essa parte pula; no CI (CI=true) ela falha.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../../server/config.js';
import { semComentarios } from '../../test-support/fonte.js';
import { aoFim } from '../../test-support/limpeza.js';

const REGRA = path.join(ROOT, 'pacote', 'polkit', '50-server-dashboard.rules');
const SYSUSERS = path.join(ROOT, 'pacote', 'sysusers', 'server-dashboard.conf');
const UNIDADES = path.join(ROOT, 'pacote', 'systemd');
const ACAO = 'org.freedesktop.systemd1.manage-units';
const GRUPO = 'server-dashboard';
const USUARIO = '_server-dashboard';
const PERMITIDAS = ['server-dashboard-atualizar.service', 'server-dashboard-voltar.service'];
const YES = 'yes';

// Carrega a regra num contexto isolado, com só o que o polkit oferece. Uma referência a
// qualquer outra coisa (require, process, polkit.spawn) vira erro na avaliação.
function carregarRegras() {
  const regras = [];
  const polkit = {
    Result: { NO: 'no', YES, AUTH_SELF: 'auth_self', AUTH_SELF_KEEP: 'auth_self_keep',
      AUTH_ADMIN: 'auth_admin', AUTH_ADMIN_KEEP: 'auth_admin_keep', NOT_HANDLED: null },
    addRule(fn) { regras.push(fn); },
    log() {},
  };
  vm.runInNewContext(fs.readFileSync(REGRA, 'utf8'), { polkit }, { filename: REGRA, timeout: 1000 });
  return regras;
}

// Avalia como o polkitd: as regras em ordem, a 1ª resposta diferente de vazio vale.
function avaliar(regras, { acao, unidade, verbo, grupos }) {
  const detalhes = { unit: unidade, verb: verbo };
  const action = { id: acao, lookup: (chave) => detalhes[chave] };
  const subject = { user: 'pessoa', pid: 4242, local: true, active: true,
    isInGroup: (g) => grupos.includes(g), isInNetGroup: () => false };
  for (const regra of regras) {
    const r = regra(action, subject);
    if (r !== undefined && r !== null) return r;
  }
  return null;
}

test('regra: registra 1 regra só e não usa nada além de addRule e Result', () => {
  const regras = carregarRegras();
  assert.equal(regras.length, 1);
  const codigo = semComentarios(fs.readFileSync(REGRA, 'utf8'));
  // Nunca rodar programa nem devolver outra resposta que libere sem senha.
  assert.doesNotMatch(codigo, /\bspawn\b|\beval\b|Function\s*\(/);
  assert.deepEqual([...codigo.matchAll(/polkit\.Result\.(\w+)/g)].map((m) => m[1]), ['YES']);
  // ES5: o motor do polkit muda conforme a versão (Duktape ou SpiderMonkey).
  assert.doesNotMatch(codigo, /=>|`|\.\.\.|\b(let|const|class|async|await)\b/);
});

test('regra: só grupo + manage-units + start + atualizar ou voltar devolve YES', () => {
  const regras = carregarRegras();
  const acoes = [ACAO, 'org.freedesktop.systemd1.manage-unit-files', 'org.freedesktop.systemd1.reload-daemon',
    'org.freedesktop.systemd1.set-environment', 'org.freedesktop.login1.reboot', 'org.freedesktop.policykit.exec',
    `${ACAO}.outra`, 'ORG.FREEDESKTOP.SYSTEMD1.MANAGE-UNITS', undefined];
  const unidades = [...PERMITIDAS, 'server-dashboard-verificar.service', 'server-dashboard-verificar.timer',
    'server-dashboard.service', 'ssh.service', 'server-dashboard-atualizar', 'server-dashboard-voltar',
    'server-dashboard-atualizar.service ', 'SERVER-DASHBOARD-ATUALIZAR.SERVICE',
    'x-server-dashboard-atualizar.service', 'server-dashboard-atualizar.service.d', '', undefined];
  const verbos = ['start', 'stop', 'restart', 'reload', 'try-restart', 'reload-or-restart',
    'reload-or-try-restart', 'kill', 'freeze', 'thaw', 'clean', 'Start', 'start ', '', undefined];
  const pessoas = [[GRUPO], ['users', GRUPO], ['users', 'sudo'], [USUARIO], [`${GRUPO}-x`], ['Server-Dashboard'], []];

  let liberadas = 0;
  for (const acao of acoes) {
    for (const unidade of unidades) {
      for (const verbo of verbos) {
        for (const grupos of pessoas) {
          const caso = { acao, unidade, verbo, grupos };
          const esperado = acao === ACAO && PERMITIDAS.includes(unidade) && verbo === 'start'
            && grupos.includes(GRUPO) ? YES : null;
          assert.equal(avaliar(regras, caso), esperado, JSON.stringify(caso));
          if (esperado) liberadas += 1;
        }
      }
    }
  }
  // 2 unidades × 2 conjuntos de grupos com server-dashboard: a matriz cobriu as liberadas.
  assert.equal(liberadas, 4);
});

test('regra: o grupo e as unidades batem com o sysusers e com pacote/systemd/', () => {
  const regra = fs.readFileSync(REGRA, 'utf8');
  for (const u of PERMITIDAS) {
    assert.ok(fs.existsSync(path.join(UNIDADES, u)), `${u} existe em pacote/systemd/`);
    assert.ok(regra.includes(`'${u}'`), `${u} está na regra`);
  }
  // As unidades sem [Install] só sobem pelo polkit (atualizar e voltar) ou pelo timer (verificar).
  for (const nome of fs.readdirSync(UNIDADES).filter((n) => n.endsWith('.service'))) {
    const texto = fs.readFileSync(path.join(UNIDADES, nome), 'utf8');
    assert.match(texto, new RegExp(`^User=${USUARIO}$`, 'm'), nome);
    assert.match(texto, new RegExp(`^Group=${USUARIO}$`, 'm'), nome);
  }
  const linhas = fs.readFileSync(SYSUSERS, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.deepEqual(linhas.map((l) => l.split(/\s+/).slice(0, 2).join(' ')), [`g ${GRUPO}`, `u ${USUARIO}`]);
  // Nenhuma linha "m": o executor nunca entra no grupo que pede ao polkit.
  assert.ok(!linhas.some((l) => l.startsWith('m ')));
});

const temSysusers = spawnSync('systemd-sysusers', ['--version'], { encoding: 'utf8' }).status === 0;
if (!temSysusers && process.env.CI === 'true') {
  throw new Error('CI=true, mas o systemd-sysusers não está instalado: os grupos ficariam sem conferência');
}

test('sysusers: cria o grupo vazio e o usuário de sistema sem login numa raiz falsa', {
  skip: temSysusers ? false : 'systemd-sysusers ausente nesta máquina',
}, (t) => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'sysusers-'));
  aoFim(t, () => fs.rmSync(raiz, { recursive: true, force: true }));
  const r = spawnSync('systemd-sysusers', [`--root=${raiz}`, SYSUSERS], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.includes('Failed'), false, r.stderr);

  const tabela = (arq) => fs.readFileSync(path.join(raiz, 'etc', arq), 'utf8').trim().split('\n')
    .map((l) => l.split(':'));
  const passwd = tabela('passwd');
  assert.equal(passwd.length, 1);
  const [nome, , uid, gid, , home, shell] = passwd[0];
  assert.equal(nome, USUARIO);
  assert.ok(Number(uid) > 0 && Number(uid) < 1000, `uid ${uid} de sistema`);
  assert.equal(home, '/');
  assert.equal(shell, '/usr/sbin/nologin');

  const grupos = Object.fromEntries(tabela('group').map(([g, , id, membros]) => [g, { id, membros }]));
  assert.deepEqual(Object.keys(grupos).sort(), [USUARIO, GRUPO].sort());
  assert.equal(grupos[USUARIO].id, gid, 'o usuário fica no grupo de mesmo nome');
  assert.equal(grupos[GRUPO].membros, '', 'o grupo das pessoas começa vazio');

  // O shadow sai com 0000; quem criou (esta pessoa) pode abrir para ler. Senha travada: "!…".
  const shadow = path.join(raiz, 'etc', 'shadow');
  fs.chmodSync(shadow, 0o600);
  const [nomeS, senha] = fs.readFileSync(shadow, 'utf8').trim().split(':');
  assert.equal(nomeS, USUARIO);
  assert.match(senha, /^!/);
});

const temPkaction = spawnSync('pkaction', ['--version'], { encoding: 'utf8' }).status === 0;

test('pkaction: a ação existe e o padrão dela pede a senha do administrador', {
  skip: temPkaction ? false : 'pkaction ausente nesta máquina (o polkit não está instalado)',
}, () => {
  const r = spawnSync('pkaction', ['--verbose', '--action-id', ACAO],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(r.status, 0, r.stderr);
  const padroes = [...r.stdout.matchAll(/^\s*implicit (any|inactive|active):\s*(\S+)/gm)].map((m) => m[2]);
  assert.equal(padroes.length, 3, r.stdout);
  for (const p of padroes) assert.match(p, /^auth_admin/, r.stdout);
});
