// Instalação em servidor que só aceita chave (#61, ADR 0021): o apelido do ~/.ssh/config lido
// com `ssh -G` falso, o agente com e sem a chave, a conexão do administrador só com aquela
// chave, a senha do sudo separada da do SSH, o `requiretty` e a conferência do sshd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAlias, checkAgentKey, runAdmin, validAlias, validKeyPath, describeAdminError } from '../../server/setup/remoto.js';
import { detectionScript, parseDetection, recommendedChoices } from '../../server/setup/deteccao.js';
import { assistedScript, sshdWarnings, sshdCheckLines, preparationPlan } from '../../server/setup/preparo.js';
import { makeInstalacao, detectionWithSudo, ALIAS, FIXTURE } from '../../test-support/instalacao-fake.js';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICLXaq8Zb0WG4QWeKtFRHjyahVNxZFkczJ5it2xMlpU2';

/** spawn falso: `respond(cmd, args, env)` devolve { code, stdout, stderr }; guarda as chamadas. */
function fakeSpawn(respond) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      on() {},
      end() {
        const r = respond(cmd, args, opts.env || {});
        setImmediate(() => {
          if (r.stdout) child.stdout.emit('data', r.stdout);
          if (r.stderr) child.stderr.emit('data', r.stderr);
          child.emit('close', r.code ?? 0);
        });
      },
    };
    calls.push({ cmd, args, env: opts.env });
    return child;
  };
  return { spawnFn, calls };
}

/** Pasta pessoal temporária com uma chave (só os arquivos, o conteúdo não importa aqui). */
function homeWithKey(t, name = 'chave_admin') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-chave-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', name), 'chave privada de teste\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.ssh', `${name}.pub`), `${PUB} maria@notebook\n`);
  return home;
}

const sshG = (lines) => fakeSpawn((cmd) => (cmd === 'ssh' ? { code: 0, stdout: `${lines.join('\n')}\n` } : { code: 1 }));

test('apelido: ssh -G (sem conectar) dá endereço, porta, usuário, chave e agente', async (t) => {
  const home = homeWithKey(t);
  const { spawnFn, calls } = sshG([
    'user maria', 'hostname 192.0.2.10', 'port 2222', 'identityagent /run/user/1000/agente.sock',
    'identityfile ~/.ssh/nao_existe', 'identityfile ~/.ssh/chave_admin', 'proxyjump none', 'permitlocalcommand no',
  ]);
  const r = await resolveAlias('meu-servidor', { home, spawnFn, configFile: '/tmp/config-de-teste' });
  assert.equal(r.ok, true, r.erro);
  assert.deepEqual(calls[0].args, ['-F', '/tmp/config-de-teste', '-G', '--', 'meu-servidor']);
  assert.deepEqual(
    [r.host, r.port, r.user, r.identityFile, r.identityAgent],
    ['192.0.2.10', 2222, 'maria', path.join(home, '.ssh', 'chave_admin'), '/run/user/1000/agente.sock'],
    'a 1ª chave que existe, com o ~ expandido',
  );
  // Sem IdentityAgent no apelido: o SSH_AUTH_SOCK deste terminal; "none" desliga o agente.
  const semAgente = await resolveAlias('a', { home, env: { SSH_AUTH_SOCK: '/tmp/ssh-x/agent.1' }, spawnFn: sshG(['user maria', 'hostname 192.0.2.10', 'port 22', 'identityfile ~/.ssh/chave_admin']).spawnFn });
  assert.equal(semAgente.identityAgent, '/tmp/ssh-x/agent.1');
  const none = await resolveAlias('a', { home, spawnFn: sshG(['user maria', 'hostname 192.0.2.10', 'port 22', 'identityagent none', 'identityfile %d/.ssh/chave_admin']).spawnFn });
  assert.equal(none.identityAgent, 'none');
  assert.equal(none.identityFile, path.join(home, '.ssh', 'chave_admin'), 'o token %d vira a pasta pessoal');
});

test('apelido: ProxyJump e ProxyCommand são recusados; apelido e valores estranhos também', async (t) => {
  const home = homeWithKey(t);
  const base = ['user maria', 'hostname 192.0.2.10', 'port 22', 'identityfile ~/.ssh/chave_admin'];
  const jump = await resolveAlias('srv', { home, spawnFn: sshG([...base, 'proxyjump salto']).spawnFn });
  assert.equal(jump.ok, false);
  assert.match(jump.erro, /ProxyJump.*conecta direto/);
  const cmd = await resolveAlias('srv', { home, spawnFn: sshG([...base, 'proxycommand nc %h %p']).spawnFn });
  assert.match(cmd.erro, /ProxyCommand/);
  // O apelido nunca vira opção do ssh, e nada roda sem um apelido válido.
  const { spawnFn, calls } = sshG(base);
  for (const bad of ['-oProxyCommand=x', '', 'a b', 'a;b', `a${'x'.repeat(70)}`]) {
    assert.equal((await resolveAlias(bad, { home, spawnFn })).ok, false, bad);
  }
  assert.equal(calls.length, 0);
  assert.equal(validAlias('meu-servidor.casa'), true);
  assert.match((await resolveAlias('srv', { home, spawnFn: sshG(['user maria', 'hostname -oX', 'port 22']).spawnFn })).erro, /HostName/);
  assert.match((await resolveAlias('srv', { home, spawnFn: sshG(['user maria', 'hostname 192.0.2.10', 'port 22', 'identityfile ~/.ssh/%h']).spawnFn })).erro, /Não achei a chave/);
  assert.equal(validKeyPath('/home/maria/.ssh/id_%h'), false);
  assert.equal(validKeyPath('/home/maria/.ssh/$X'), false);
  assert.equal(validKeyPath('relativo/chave'), false);
});

test('agente: compara o ssh-add -L com o .pub; sem a chave, o ssh-add a rodar (nunca a passphrase)', async (t) => {
  const home = homeWithKey(t);
  const key = path.join(home, '.ssh', 'chave_admin');
  // ssh-keygen -y -P '' falha: a chave tem passphrase.
  const agent = (list, code = 0) => fakeSpawn((cmd) => (cmd === 'ssh-keygen' ? { code: 1, stderr: 'incorrect passphrase' } : { code, stdout: list }));
  const com = agent(`ssh-rsa AAAAB3Nza outra\n${PUB} maria@notebook\n`);
  assert.deepEqual(await checkAgentKey({ identityFile: key, identityAgent: '/tmp/a.sock', home, spawnFn: com.spawnFn }), { ok: true, via: 'agente' });
  assert.equal(com.calls.find((c) => c.cmd === 'ssh-add').env.SSH_AUTH_SOCK, '/tmp/a.sock', 'o agente do apelido');
  assert.deepEqual(com.calls.find((c) => c.cmd === 'ssh-add').args, ['-L']);
  const sem = await checkAgentKey({ identityFile: key, identityAgent: '/tmp/a.sock', home, spawnFn: agent('ssh-rsa AAAAB3Nza outra\n').spawnFn });
  assert.deepEqual(sem, { ok: false, motivo: 'falta', comando: 'ssh-add -t 15m ~/.ssh/chave_admin' });
  assert.equal((await checkAgentKey({ identityFile: key, identityAgent: '/tmp/a.sock', home, spawnFn: agent('', 2).spawnFn })).motivo, 'sem-agente');
  assert.equal((await checkAgentKey({ identityFile: key, identityAgent: 'none', home, spawnFn: agent('').spawnFn })).motivo, 'sem-agente');
  // Chave sem passphrase: não precisa do agente.
  const plain = fakeSpawn((cmd) => (cmd === 'ssh-keygen' ? { code: 0, stdout: `${PUB}\n` } : { code: 2 }));
  assert.deepEqual(await checkAgentKey({ identityFile: key, identityAgent: 'none', home, spawnFn: plain.spawnFn }), { ok: true, via: 'sem-passphrase' });
  fs.rmSync(`${key}.pub`);
  const semPub = await checkAgentKey({ identityFile: key, identityAgent: '/tmp/a.sock', home, spawnFn: agent(PUB).spawnFn });
  assert.equal(semPub.motivo, 'sem-pub');
  assert.match(semPub.comando, /^ssh-keygen -y -f ~\/\.ssh\/chave_admin > ~\/\.ssh\/chave_admin\.pub$/);
});

test('conexão por chave: -F /dev/null, só a chave do apelido, o agente dele e BatchMode', async () => {
  const { spawnFn, calls } = fakeSpawn(() => ({ code: 0, stdout: 'ok\n' }));
  await runAdmin({
    host: '192.0.2.10', port: 2222, user: 'maria', identityFile: '/home/maria/.ssh/chave_admin', identityAgent: '/run/user/1000/agente.sock',
    knownHosts: '/k', hostKeyType: 'ssh-ed25519', script: 'echo oi\n', spawnFn,
  });
  const a = calls[0].args;
  assert.deepEqual(a.slice(0, 6), ['-F', '/dev/null', '-p', '2222', '-l', 'maria']);
  assert.equal(a[a.indexOf('-i') + 1], '/home/maria/.ssh/chave_admin');
  for (const o of ['IdentitiesOnly=yes', 'IdentityAgent=/run/user/1000/agente.sock', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile=/k', 'PreferredAuthentications=publickey']) {
    assert.ok(a.includes(o), o);
  }
  assert.ok(!a.includes('PubkeyAuthentication=no'));
  assert.equal(calls[0].env.DASHBOARD_SENHA_SSH, undefined, 'nenhuma senha no ambiente');
  assert.throws(() => runAdmin({ host: '192.0.2.10', user: 'maria', identityFile: '/k/%h', script: '' }), /inválido/);
  assert.throws(() => runAdmin({ host: '192.0.2.10', user: 'maria', identityFile: '/k/x', identityAgent: 'rel', script: '' }), /inválido/);
  assert.match(describeAdminError({ code: 255, stderr: 'maria@192.0.2.10: Permission denied (publickey).' }), /recusou a chave/);
  assert.match(describeAdminError({ code: 1, stderr: 'sudo: sorry, you must have a tty to run sudo' }), /requiretty/);
});

test('detecção: sem senha, o sudo que pede senha fica "pede-senha" (não "sem sudo"); requiretty à parte', () => {
  const script = detectionScript();
  assert.match(script, /sudo -n true 2>&1 <\/dev\/null/, 'o sudo -n não lê o script do stdin');
  assert.match(script, /must have a tty/);
  const det = parseDetection(detectionWithSudo('pede-senha').replace('===SMARTCTL===', '===GRUPOS===\nmaria sudo\n===SMARTCTL==='));
  assert.equal(det.sudo, 'pede-senha');
  assert.equal(det.sudoGroup, true);
  assert.ok(recommendedChoices(det).smart.length > 0, 'o SMART continua recomendado: o sudo vem no passo 5');
  assert.equal(parseDetection(detectionWithSudo('requiretty')).sudo, 'requiretty');
  assert.equal(parseDetection(detectionWithSudo('qualquer')).sudo, 'nao');
  assert.equal(parseDetection(FIXTURE).sudoGroup, false);
});

test('preparo: requiretty vira @@erro tty, e a conferência do sshd só lê', () => {
  const s = assistedScript('echo oi\n', { sudo: 'senha', password: 'x' });
  assert.match(s, /must have a tty'\*\) echo '@@erro tty'/);
  assert.match(s, /echo '@@erro senha'/);
  const lines = sshdCheckLines('192.0.2.20').join('\n');
  assert.match(lines, /-T -C user=dashmon,host=192\.0\.2\.20,addr=192\.0\.2\.20/);
  assert.doesNotMatch(lines, /sshd_config|sed -i|[^2]>|reload|restart/, 'nunca altera o sshd (só 2>/dev/null)');
  assert.deepEqual(sshdCheckLines('192.0.2.20; rm -rf /'), ['# sem o IP deste computador: a conferência do sshd fica de fora', "echo '@@sshd fim'"]);
  const plan = preparationPlan({ adminUser: 'maria', publicKey: PUB, computer: 'notebook', targets: { mounts: ['/'], devs: [], services: [], netIf: '' }, checkIp: '192.0.2.20' });
  assert.ok(plan.rootScript.indexOf('sshd -T') < plan.rootScript.indexOf('useradd'), 'confere antes de mudar qualquer coisa');
  assert.match(plan.displayed, /"\$b" -T -C user=dashmon/, 'o comando aparece antes do Confirmar');
  assert.ok(plan.actions.some((a) => a.id === 'sshd'));
});

test('sshd: avisa o que barra o dashmon (AllowUsers, AllowGroups, Deny*, chave, métodos, AuthorizedKeysFile)', () => {
  const w = (lines, ip = '192.0.2.20') => sshdWarnings(`${lines.map((l) => `@@sshd ${l}`).join('\n')}\n@@sshd fim\n`, { ip });
  assert.deepEqual(w(['pubkeyauthentication yes', 'maxauthtries 6', 'authenticationmethods any', 'authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2']), { conferido: true, avisos: [] });
  assert.match(w(['allowusers admin@192.0.2.* outro']).avisos[0], /AllowUsers.*dashmon@192\.0\.2\.20/);
  assert.equal(w(['allowusers admin', 'allowusers dashmon@192.0.2.0/24']).avisos.length, 0, 'CIDR que inclui este computador');
  assert.equal(w(['allowusers dash*']).avisos.length, 0, 'curinga');
  assert.equal(w(['allowusers dashmon@198.51.100.0/24']).avisos.length, 1, 'CIDR de outra rede');
  assert.match(w(['allowgroups sudo']).avisos[0], /AllowGroups/);
  assert.match(w(['denyusers dashmon']).avisos[0], /DenyUsers/);
  assert.match(w(['denygroups *']).avisos[0], /DenyGroups/);
  assert.match(w(['pubkeyauthentication no']).avisos[0], /PubkeyAuthentication no/);
  assert.match(w(['authenticationmethods publickey,password']).avisos[0], /AuthenticationMethods/);
  assert.equal(w(['authenticationmethods publickey,password publickey']).avisos.length, 0, 'uma lista só com a chave basta');
  assert.match(w(['maxauthtries 0']).avisos[0], /MaxAuthTries/);
  assert.match(w(['authorizedkeysfile /etc/ssh/chaves/%u']).avisos[0], /procura as chaves/);
  assert.deepEqual(sshdWarnings('@@sshd fim\n'), { conferido: false, avisos: [] }, 'sshd -T falhou: nada a dizer');
  assert.deepEqual(sshdWarnings(''), { conferido: false, avisos: [] });
});

/** Instalação falsa no modo chave até o passo 3 (o apelido de exemplo, agente com a chave). */
async function keySetup(t, opts = {}) {
  const r = makeInstalacao({ detection: detectionWithSudo('pede-senha'), ...opts });
  t.after(r.cleanup);
  return r;
}

test('passo 2–3 modo chave: apelido conferido, ProxyJump recusado e o ssh-add quando a chave falta', async (t) => {
  const { inst, srv } = await keySetup(t);
  await assert.rejects(inst.lerApelido({ apelido: 'com-salto' }), (e) => e.field === 'apelido' && /ProxyJump/.test(e.message));
  const a = await inst.lerApelido({ apelido: 'meu-servidor' });
  assert.deepEqual([a.host, a.port, a.user, a.identityFile], [ALIAS.host, ALIAS.port, ALIAS.user, ALIAS.identityFile]);
  const s = await inst.definirServidor({ modo: 'chave', apelido: 'meu-servidor', host: '192.0.2.99', user: 'outro' });
  assert.deepEqual([s.host, s.port, s.user, s.modo], ['192.0.2.10', 2222, 'maria', 'chave'], 'os valores vêm do apelido');
  await inst.lerIdentidade();
  srv.agentHasKey = false;
  await assert.rejects(inst.conectar({ confirmo: true }), (e) => e.field === 'agente' && e.detalhes.comando === 'ssh-add -t 15m ~/.ssh/chave_admin');
  assert.equal(srv.calls.filter((c) => c.kind === 'admin').length, 0, 'sem a chave no agente, nenhuma conexão');
  srv.agentHasKey = true;
  const det = await inst.conectar({ senha: 'teste-ignorada', confirmo: true });
  const admin = srv.calls.find((c) => c.kind === 'admin');
  assert.deepEqual([admin.password, admin.identityFile, admin.identityAgent], ['', ALIAS.identityFile, ALIAS.identityAgent], 'só a chave, nenhuma senha');
  assert.doesNotMatch(admin.script, /^P='teste-ignorada'/m);
  assert.equal(det.sudo, 'pede-senha');
  assert.equal(det.podePreparar, true);
  assert.match(det.sudoTexto, /pede senha/);
});

test('passo 5 modo chave: a senha do sudo é pedida à parte e vai só no script (sudo -S -k)', async (t) => {
  const { inst, srv } = await keySetup(t);
  await inst.definirServidor({ modo: 'chave', apelido: 'meu-servidor' });
  await inst.lerIdentidade();
  await inst.conectar({ confirmo: true });
  inst.definirEscolhas({ mounts: ['/'], smart: [], netIf: '', services: [] });
  const plano = inst.planoPreparo({ from: true });
  assert.deepEqual([plano.precisaSenha, plano.podeAssistido, plano.acesso], [true, false, 'chave']);
  assert.deepEqual(plano.acoes.map((x) => x.id), ['sudo', 'sshd', 'usuario', 'chave', 'sudoers', 'teste']);
  await assert.rejects(inst.prepararAssistido({}), (e) => e.field === 'senha');
  const errada = await inst.prepararAssistido({ senha: 'errada' });
  assert.deepEqual([errada.ok, errada.precisaSenha], [false, true]);
  assert.equal(inst.temSenha, false, 'senha recusada é esquecida');
  const r = await inst.prepararAssistido({ senha: 'certa' });
  assert.equal(r.ok, true, r.erro);
  assert.deepEqual(r.feitos, ['sudo', 'sshd', 'usuario', 'chave', 'sudoers', 'teste']);
  const prep = srv.calls.filter((c) => c.kind === 'admin').at(-1);
  assert.equal(prep.password, '', 'a conexão continua só por chave');
  assert.equal(prep.identityFile, ALIAS.identityFile);
  assert.match(prep.script, /sudo -S -k -p '' \/bin\/sh -s/);
  assert.equal(inst.temSenha, false, 'descartada depois do preparo');
});

test('passo 5: avisos do sshd chegam à tela; requiretty manda para o modo à mão', async (t) => {
  const { inst } = await keySetup(t, { detection: FIXTURE, sshd: '@@sshd allowusers maria\n@@sshd fim\n' });
  await inst.definirServidor({ host: '192.0.2.10', user: 'maria' });
  await inst.lerIdentidade();
  await inst.conectar({ senha: 'certa', confirmo: true });
  inst.definirEscolhas({ mounts: ['/'], smart: [], netIf: '', services: [] });
  inst.planoPreparo({ from: true });
  const r = await inst.prepararAssistido();
  assert.equal(r.ok, true, r.erro);
  assert.match(r.avisos[0], /AllowUsers do sshd não inclui o dashmon: acrescente dashmon@192\.0\.2\.50/);

  const tty = await keySetup(t, { detection: detectionWithSudo('requiretty') });
  await tty.inst.definirServidor({ modo: 'chave', apelido: 'meu-servidor' });
  await tty.inst.lerIdentidade();
  const det = await tty.inst.conectar({ confirmo: true });
  assert.match(det.sudoTexto, /requiretty/);
  tty.inst.definirEscolhas({ mounts: ['/'], smart: [], netIf: '', services: [] });
  assert.equal(tty.inst.planoPreparo({}).podeAssistido, false);
  await assert.rejects(tty.inst.prepararAssistido({ senha: 'certa' }), /Defaults requiretty/);
});

test('modo senha continua igual: em branco usa as chaves de sempre e o sudo é pedido no passo 5', async (t) => {
  const { inst, srv } = await keySetup(t);
  await inst.definirServidor({ host: '192.0.2.10', user: 'maria' });
  await inst.lerIdentidade();
  const det = await inst.conectar({ senha: '', confirmo: true });
  assert.equal(det.sudo, 'pede-senha', 'antes: "sem sudo para este usuário"');
  const admin = srv.calls.find((c) => c.kind === 'admin');
  assert.deepEqual([admin.password, admin.identityFile], ['', undefined]);
  inst.definirEscolhas({ mounts: ['/'], smart: [], netIf: '', services: [] });
  assert.equal(inst.planoPreparo({}).precisaSenha, true);
  assert.equal((await inst.prepararAssistido({ senha: 'certa' })).ok, true);
});
