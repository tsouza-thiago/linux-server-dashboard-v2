import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScript, buildForcedScript, normalizeTargets, targetsHash, COLLECTOR_VERSION,
} from '../../server/collector/builder.js';

const FULL = { netIf: 'enp0s7', mounts: ['/', '/mnt/dados'], devs: ['sda', 'sdb'], services: ['smbd', 'nmbd'] };

// Remove redirecionamentos permitidos e devolve o que sobrar com '>' (deve ser nada).
function writeRedirections(script) {
  return script.replace(/2>\/dev\/null/g, '').replace(/2>&1/g, '').match(/[^=!]>/g) || [];
}

test('contrato I2/I3: o comando não escreve nada no servidor', () => {
  for (const mode of ['basico', 'smart']) {
    const { script } = buildScript(FULL, mode);
    assert.deepEqual(writeRedirections(script), [], `redirecionamento de escrita no modo ${mode}`);
    assert.doesNotMatch(script, /\b(rm|mv|cp|tee|dd|mkdir|touch|chmod|chown|truncate|ln|kill|reboot|shutdown|apt|apt-get|dpkg|systemctl (start|stop|restart|enable|disable))\b/);
    assert.doesNotMatch(script, /sed\s+-i/);
  }
});

test('contrato I4: LC_ALL=C no início e marcadores na ordem, terminando em ===FIM===', () => {
  const { script } = buildScript(FULL, 'smart');
  assert.match(script, /^LC_ALL=C; export LC_ALL;/);
  const order = ['VER', 'HOST', 'OS', 'CPU', 'UPTIME', 'LOAD', 'STAT', 'MEM', 'DF', 'NET', 'IO', 'PSI', 'TEMP', 'SMART', 'SERVICES', 'PS', 'FIM'];
  let last = -1;
  for (const name of order) {
    const at = script.indexOf(`'===${name}==='`);
    assert.ok(at > last, `${name} fora de ordem ou ausente`);
    last = at;
  }
});

test('seções opcionais só entram quando configuradas', () => {
  const { script } = buildScript({ mounts: ['/'] });
  for (const name of ['NET', 'IO', 'SMART', 'SERVICES']) assert.ok(!script.includes(`===${name}===`), name);
  for (const name of ['HOST', 'MEM', 'DF', 'PSI', 'TEMP', 'PS', 'FIM']) assert.ok(script.includes(`===${name}===`), name);
});

test('alvos aparecem no comando: mounts no df, interface exata, discos no awk, serviços nomeados', () => {
  const { script } = buildScript(FULL, 'smart');
  assert.ok(script.includes('df -B1 --output=source,target,size,used,avail,pcent,ipcent / /mnt/dados'));
  assert.ok(script.includes("-v i='enp0s7'"), 'filtro por nome exato da interface (B2)');
  assert.ok(!/grep\s+enp0s7/.test(script), 'sem grep por substring');
  assert.ok(script.includes('$3=="sda"||$3=="sdb"'));
  assert.ok(script.includes('for d in sda sdb;'));
  assert.ok(script.includes('for s in smbd nmbd;'));
});

test('B1: o SMART imprime sempre 1 linha por disco, terminada em \\n, com estado classificado', () => {
  const { script } = buildScript(FULL, 'smart');
  assert.ok(script.includes(`printf '%s %s\\n' "$d" "$s"`));
  for (const state of ['PASSED', 'FAILED', 'SEM_PERMISSAO', 'SEM_SMARTCTL', 'DESCONHECIDO']) {
    assert.ok(script.includes(`s=${state}`), state);
  }
  assert.ok(script.includes('sudo -n smartctl -H'), 'sudo nunca pergunta senha (-n)');
});

test('modo de coleta: básico pula o SMART, smart executa; modo inválido é recusado', () => {
  assert.ok(buildScript(FULL, 'basico').script.includes('M="${SSH_ORIGINAL_COMMAND:-basico}"'));
  assert.ok(buildScript(FULL, 'smart').script.includes('M="${SSH_ORIGINAL_COMMAND:-smart}"'));
  assert.ok(buildScript(FULL).script.includes('*) echo pulado;;'));
  assert.throws(() => buildScript(FULL, 'tudo; rm -rf /'), /modo de coleta inválido/);
});

test('comando forçado (authorized_keys): mesmo hash, modo vem do cliente via $SSH_ORIGINAL_COMMAND', () => {
  const forced = buildForcedScript(FULL);
  assert.equal(forced.hash, buildScript(FULL, 'smart').hash);
  assert.ok(forced.script.includes('M="${SSH_ORIGINAL_COMMAND:-basico}"'));
  assert.ok(forced.script.includes(`echo '${COLLECTOR_VERSION} ${forced.hash}'`));
  assert.ok(!/eval|\$SSH_ORIGINAL_COMMAND[^}]/.test(forced.script.replace('${SSH_ORIGINAL_COMMAND:-basico}', '')),
    'o comando do cliente nunca é executado, só comparado');
});

test('hash da configuração: estável, curto e sensível a qualquer alvo', () => {
  const h = targetsHash(FULL);
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(targetsHash({ ...FULL }), h);
  assert.notEqual(targetsHash({ ...FULL, devs: ['sda'] }), h);
  assert.notEqual(targetsHash({ ...FULL, services: ['smbd'] }), h);
  assert.notEqual(targetsHash({ ...FULL, netIf: 'eth0' }), h);
  assert.equal(targetsHash({ ...FULL, devs: ['sda', 'sdb', ';rm'] }), h, 'token inválido é descartado antes do hash');
});

test('anti-injeção: tokens perigosos nunca chegam ao comando', () => {
  const evil = {
    netIf: 'eth0;id',
    mounts: ['/', '/x;rm -rf /', '$(id)', '`id`', "/a'b", '-o'],
    devs: ['sda', 'sdb|nc', '-rf'],
    services: ['smbd', 'x&&reboot', '"q"'],
  };
  const t = normalizeTargets(evil);
  assert.deepEqual(t, { netIf: '', mounts: ['/'], devs: ['sda'], services: ['smbd'] });
  const { script } = buildScript(evil, 'smart');
  for (const bad of ['eth0;id', 'rm -rf', '$(id)', '`id`', "a'b", 'nc', 'reboot', '"q"']) {
    assert.ok(!script.includes(bad), `vazou: ${bad}`);
  }
});

test('tamanho do comando fica pequeno (orçamento do servidor de 1 núcleo)', () => {
  const { script } = buildScript({ ...FULL, mounts: ['/', '/a', '/b', '/c'], devs: ['sda', 'sdb', 'sdc', 'sdd'], services: ['a', 'b', 'c', 'd'] }, 'smart');
  assert.ok(script.length < 4096, `${script.length} bytes`);
});
