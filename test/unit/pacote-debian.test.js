// Scripts do mantenedor do pacote .deb (pacote/debian/, F9 do #92, ADR 0049 e 0050), rodados com
// comandos falsos no PATH (systemd-sysusers, install, runuser, systemctl, usermod, getent, id, rm,
// rmdir, userdel e groupdel), que só anotam o que receberam: nada é gravado no sistema. Confere a
// ordem dos passos, que o executor roda como _server-dashboard, que o timer só é ligado na 1ª
// instalação, que só uma conta de pessoa, e só com o grupo vazio, entra no grupo server-dashboard
// (1 pessoa por máquina), e que o apt purge tira só as pastas do executor e as contas de sistema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../server/config.js';
import { aoFim } from '../../test-support/limpeza.js';

const COMANDOS = ['systemd-sysusers', 'install', 'runuser', 'systemctl', 'usermod', 'getent', 'id', 'rm', 'rmdir', 'userdel', 'groupdel'];

// Um comando falso para todos: anota "nome argumentos" e responde pelo ambiente FALSO_*.
const FALSO = `#!/bin/sh
nome=$(basename "$0")
printf '%s %s\\n' "$nome" "$*" >> "$FALSO_LOG"
case "$nome" in
  id) echo "\${FALSO_UID:-1000}" ;;
  getent)
    case "$1:$2" in
      passwd:_server-dashboard) [ -n "\${FALSO_UID_DONO:-}" ] && echo "_server-dashboard:x:$FALSO_UID_DONO:$FALSO_UID_DONO::/:/usr/sbin/nologin" ;;
      passwd:*) [ -n "\${FALSO_PKEXEC:-}" ] && echo "$FALSO_PKEXEC:x:$2:$2::/home/$FALSO_PKEXEC:/bin/bash" ;;
      group:_server-dashboard) [ -n "\${FALSO_GID_DONO:-}" ] && echo "_server-dashboard:x:$FALSO_GID_DONO:" ;;
      group:*) echo "server-dashboard:x:\${FALSO_GID_GRUPO:-994}:\${FALSO_MEMBROS:-}" ;;
    esac ;;
  runuser) exit "\${FALSO_RUNUSER:-0}" ;;
  userdel) exit "\${FALSO_USERDEL:-0}" ;;
esac
exit 0
`;

/** Roda um script de pacote/debian/ com os comandos falsos; devolve código, texto e as chamadas. */
function rodar(t, script, args, ambiente = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-debian-'));
  aoFim(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'falso'), FALSO, { mode: 0o755 });
  for (const c of COMANDOS) fs.symlinkSync('falso', path.join(bin, c));
  const log = path.join(dir, 'log');
  fs.writeFileSync(log, '');
  // Sem SUDO_USER nem PKEXEC_UID herdados de quem roda os testes.
  const env = { PATH: `${bin}:/usr/bin:/bin`, FALSO_LOG: log, LC_ALL: 'C', ...ambiente };
  const r = spawnSync('sh', [path.join(ROOT, 'pacote', 'debian', script), ...args], { encoding: 'utf8', env });
  const chamadas = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { codigo: r.status, texto: `${r.stdout}${r.stderr}`, chamadas, de: (c) => chamadas.filter((l) => l.startsWith(`${c} `)) };
}

test('postinst: usuário, pastas do executor, semente como _server-dashboard e timer na 1ª instalação', (t) => {
  const r = rodar(t, 'postinst', ['configure', ''], { SUDO_USER: 'pessoa' });
  assert.equal(r.codigo, 0, r.texto);
  assert.deepEqual(r.de('systemd-sysusers'), ['systemd-sysusers server-dashboard.conf']);
  assert.deepEqual(r.de('install'), ['repo.git', 'versoes', 'estado', 'node']
    .map((p) => `install -d -o _server-dashboard -g _server-dashboard -m 0755 /opt/server-dashboard/${p}`));
  assert.deepEqual(r.de('runuser'), ['runuser -u _server-dashboard -- /opt/server-dashboard/libexec/atualizador semear']);
  assert.ok(r.de('systemctl').includes('systemctl enable server-dashboard-verificar.timer'));
  // A ordem: usuário, pastas, semente.
  const ordem = ['systemd-sysusers', 'install', 'runuser'].map((c) => r.chamadas.findIndex((l) => l.startsWith(`${c} `)));
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem);
});

test('postinst: na troca por uma versão nova do pacote, não liga de novo o timer', (t) => {
  const r = rodar(t, 'postinst', ['configure', '2.6.0'], { SUDO_USER: 'pessoa', FALSO_MEMBROS: 'pessoa' });
  assert.equal(r.codigo, 0, r.texto);
  assert.equal(r.chamadas.includes('systemctl enable server-dashboard-verificar.timer'), false);
  assert.deepEqual(r.de('usermod'), []);
});

test('postinst: falha da semente ou do Node só avisa, e o pacote fica configurado', (t) => {
  const r = rodar(t, 'postinst', ['configure', ''], { FALSO_RUNUSER: '1' });
  assert.equal(r.codigo, 0, r.texto);
  assert.match(r.texto, /AVISO: a instalação da versão ou do Node não terminou/);
  assert.match(r.texto, /sudo apt install --reinstall server-dashboard/);
});

test('postinst põe no grupo só a conta de pessoa que instalou, e só com o grupo vazio', (t) => {
  const casos = [
    // [ambiente, entra no grupo?, texto esperado]
    [{ SUDO_USER: 'pessoa' }, 'pessoa', /A conta pessoa entrou no grupo server-dashboard[\s\S]*sair da sessão e entrar de novo/],
    [{ PKEXEC_UID: '1001', FALSO_PKEXEC: 'outra' }, 'outra', /A conta outra entrou no grupo/],
    [{ SUDO_USER: 'pessoa', FALSO_MEMBROS: 'pessoa' }, null, /^$/],
    [{ SUDO_USER: 'pessoa', FALSO_MEMBROS: 'primeira' }, null, /já tem a conta primeira\. Esta versão atende 1 pessoa por máquina/],
    [{ SUDO_USER: 'root', FALSO_UID: '0' }, null, /sudo usermod -a -G server-dashboard <sua-conta>/],
    [{ SUDO_USER: 'servico', FALSO_UID: '999' }, null, /<sua-conta>/],
    [{ SUDO_USER: 'nobody', FALSO_UID: '65534' }, null, /<sua-conta>/],
    [{ SUDO_USER: 'a;b', FALSO_UID: '1000' }, null, /<sua-conta>/],
    [{ SUDO_USER: '-G', FALSO_UID: '1000' }, null, /<sua-conta>/],
    [{}, null, /<sua-conta>/],
  ];
  for (const [ambiente, entra, texto] of casos) {
    const r = rodar(t, 'postinst', ['configure', '2.6.0'], ambiente);
    assert.equal(r.codigo, 0, r.texto);
    assert.deepEqual(r.de('usermod'), entra ? [`usermod -a -G server-dashboard ${entra}`] : [], JSON.stringify(ambiente));
    assert.match(r.texto.trim(), texto, JSON.stringify(ambiente));
  }
});

test('postinst e prerm não fazem nada fora dos passos deles', (t) => {
  for (const passo of ['abort-upgrade', 'abort-remove', 'triggered']) {
    assert.deepEqual(rodar(t, 'postinst', [passo, '2.6.0'], { SUDO_USER: 'pessoa' }).chamadas, [], passo);
  }
  // prerm: na remoção desliga o timer; na troca por uma versão nova, nada.
  assert.ok(rodar(t, 'prerm', ['remove']).chamadas.includes('systemctl disable server-dashboard-verificar.timer'));
  assert.deepEqual(rodar(t, 'prerm', ['upgrade', '2.7.0']).chamadas, []);
  assert.deepEqual(rodar(t, 'postrm', ['upgrade', '2.7.0']).chamadas, []);
});

// O prerm só para as unidades com o systemd rodando (/run/systemd/system), como o dpkg faz.
const COM_SYSTEMD = fs.existsSync('/run/systemd/system');

test('prerm: na remoção, para o timer e as unidades do executor que estiverem rodando', { skip: !COM_SYSTEMD && 'sem o systemd rodando' }, (t) => {
  const r = rodar(t, 'prerm', ['remove']);
  assert.equal(r.codigo, 0, r.texto);
  assert.deepEqual(r.de('systemctl'), [
    'systemctl stop server-dashboard-verificar.timer',
    'systemctl stop server-dashboard-verificar.service server-dashboard-atualizar.service server-dashboard-voltar.service',
    'systemctl disable server-dashboard-verificar.timer',
  ]);
});

test('postrm purge: tira as 4 pastas do executor, a base vazia, o usuário e os grupos de sistema', (t) => {
  const r = rodar(t, 'postrm', ['purge'], { FALSO_UID_DONO: '995', FALSO_GID_DONO: '995' });
  assert.equal(r.codigo, 0, r.texto);
  assert.deepEqual(r.de('rm'), ['repo.git', 'versoes', 'estado', 'node']
    .map((p) => `rm -rf --one-file-system /opt/server-dashboard/${p}`));
  assert.deepEqual(r.de('rmdir'), ['rmdir /opt/server-dashboard']);
  assert.deepEqual(r.de('userdel'), ['userdel _server-dashboard']);
  assert.deepEqual(r.de('groupdel'), ['groupdel _server-dashboard', 'groupdel server-dashboard']);
  // Nenhum comando cita uma pasta pessoal: elas são de cada pessoa (dashboard desinstalar).
  assert.equal(r.chamadas.some((l) => /home|\.config|\.local/.test(l)), false, r.chamadas.join('\n'));
  assert.match(r.texto, /Os dados de cada pessoa ficam nas pastas pessoais/);
  // As pastas saem depois de o systemd reler a lista, e o usuário depois das pastas dele.
  assert.ok(r.chamadas.findIndex((l) => l.startsWith('rm ')) < r.chamadas.findIndex((l) => l.startsWith('userdel ')));
});

test('postrm purge: conta ou grupo de pessoa (UID ou GID 1000 ou mais) com o mesmo nome fica', (t) => {
  const r = rodar(t, 'postrm', ['purge'], { FALSO_UID_DONO: '1001', FALSO_GID_DONO: '1001', FALSO_GID_GRUPO: '1500' });
  assert.equal(r.codigo, 0, r.texto);
  assert.deepEqual(r.de('userdel'), []);
  assert.deepEqual(r.de('groupdel'), []);
  // Sem o usuário (já removido à mão), só os grupos que existem saem.
  const sem = rodar(t, 'postrm', ['purge']);
  assert.deepEqual(sem.de('userdel'), []);
  assert.deepEqual(sem.de('groupdel'), ['groupdel server-dashboard']);
});

test('postrm purge: falha ao remover o usuário só avisa, e o purge termina', (t) => {
  const r = rodar(t, 'postrm', ['purge'], { FALSO_UID_DONO: '995', FALSO_USERDEL: '1' });
  assert.equal(r.codigo, 0, r.texto);
  assert.match(r.texto, /AVISO: não consegui remover o usuário _server-dashboard; remova com: sudo userdel _server-dashboard/);
});

test('postrm: a remoção sem purge não apaga pastas nem contas', (t) => {
  for (const passo of ['remove', 'upgrade', 'failed-upgrade', 'abort-install', 'disappear']) {
    const r = rodar(t, 'postrm', [passo, '2.7.0'], { FALSO_UID_DONO: '995', FALSO_GID_DONO: '995' });
    assert.equal(r.codigo, 0, r.texto);
    for (const c of ['rm', 'rmdir', 'userdel', 'groupdel']) assert.deepEqual(r.de(c), [], `${passo}: ${c}`);
  }
});
