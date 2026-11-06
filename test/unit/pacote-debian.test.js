// Scripts do mantenedor do pacote .deb (pacote/debian/, F9 do #92, ADR 0049), rodados com comandos
// falsos no PATH (systemd-sysusers, install, runuser, systemctl, usermod, getent e id), que só
// anotam o que receberam: nada é gravado no sistema. Confere a ordem dos passos, que o executor
// roda como _server-dashboard, que o timer só é ligado na 1ª instalação e que só uma conta de
// pessoa, e só com o grupo vazio, entra no grupo server-dashboard (1 pessoa por máquina).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../server/config.js';
import { aoFim } from '../../test-support/limpeza.js';

const COMANDOS = ['systemd-sysusers', 'install', 'runuser', 'systemctl', 'usermod', 'getent', 'id'];

// Um comando falso para todos: anota "nome argumentos" e responde pelo ambiente FALSO_*.
const FALSO = `#!/bin/sh
nome=$(basename "$0")
printf '%s %s\\n' "$nome" "$*" >> "$FALSO_LOG"
case "$nome" in
  id) echo "\${FALSO_UID:-1000}" ;;
  getent)
    case "$1" in
      passwd) [ -n "\${FALSO_PKEXEC:-}" ] && echo "$FALSO_PKEXEC:x:$2:$2::/home/$FALSO_PKEXEC:/bin/bash" ;;
      group) echo "server-dashboard:x:994:\${FALSO_MEMBROS:-}" ;;
    esac ;;
  runuser) exit "\${FALSO_RUNUSER:-0}" ;;
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
