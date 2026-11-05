// Configuração: sanitizeToken, host de exemplo, faixas, caminhos presos em data/ e o modo sistema.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, DATA_ROOT, ENV_FILE, PASTAS, SINAL_MODO_SISTEMA, modoDaInstalacao, pastasDaInstalacao,
  prepararPastas, sshConfigFile,
} from '../../server/config.js';
import { aoFim } from '../../test-support/limpeza.js';
import {
  sanitizeToken, isPlaceholderHost, clampInt, clampPathToData, config,
} from '../../server/config.js';

test('sanitizeToken remove tokens perigosos', () => {
  assert.deepEqual(sanitizeToken('sda sdb'), ['sda', 'sdb']);
  assert.deepEqual(sanitizeToken('sda;rm -rf /'), ['/']);
  assert.deepEqual(sanitizeToken('$(reboot)'), []);
  assert.deepEqual(sanitizeToken('-rf /etc'), ['/etc']);
  assert.deepEqual(sanitizeToken('  a  b  '), ['a', 'b']);
  assert.deepEqual(sanitizeToken(''), []);
});

test('sanitizeToken aceita caracteres seguros', () => {
  assert.deepEqual(sanitizeToken('/ /mnt/disco1'), ['/', '/mnt/disco1']);
  assert.deepEqual(sanitizeToken('enpXsY:1'), ['enpXsY:1']);
});

test('isPlaceholderHost detecta valores padrão', () => {
  assert.equal(isPlaceholderHost('seu-host'), true);
  assert.equal(isPlaceholderHost('seu_host_ou_alias_ssh'), true);
  assert.equal(isPlaceholderHost('debiandell'), false);
});

test('clampInt respeita limites', () => {
  assert.equal(clampInt('60000', 60000, 10000, 3600000), 60000);
  assert.equal(clampInt('1000', 60000, 10000, 3600000), 60000); // abaixo do piso
  assert.equal(clampInt('banana', 60000, 10000, 3600000), 60000);
  assert.equal(clampInt('', 60000, 10000, 3600000), 60000);
});

test('clampPathToData mantém dentro de data/', () => {
  const p = clampPathToData('data/custom.json', 'history.json');
  assert.ok(p.endsWith('data/custom.json'));
  const escaped = clampPathToData('/tmp/evil.json', 'history.json');
  assert.ok(escaped.endsWith('data/history.json'));
});

test('config tem defaults seguros', () => {
  assert.ok(config.POLL_INTERVAL >= 10000);
  assert.ok(config.PORT >= 1 && config.PORT <= 65535);
  assert.ok(Array.isArray(config.DISK_MOUNTS) && config.DISK_MOUNTS.length > 0);
  assert.ok(Array.isArray(config.DISK_DEVS));
  assert.ok(Array.isArray(config.SERVICES));
});
test('intSetting: vazio usa o padrão; fora da faixa ou não inteiro avisa e usa o padrão', async () => {
  const { intSetting } = await import('../../server/config.js');
  const w = [];
  assert.equal(intSetting('X', '', 90, 50, 99, w), 90);
  assert.equal(intSetting('X', undefined, 90, 50, 99, w), 90);
  assert.equal(intSetting('X', ' 80 ', 90, 50, 99, w), 80);
  assert.deepEqual(w, []);
  assert.equal(intSetting('X', '120', 90, 50, 99, w), 90);
  assert.equal(intSetting('X', '85.5', 90, 50, 99, w), 90);
  assert.equal(intSetting('X', 'muito', 90, 50, 99, w), 90);
  assert.equal(w.length, 3);
  assert.match(w[0], /^X inválido \(aceita 50–99\); usando 90$/);
  assert.ok(!w.join(' ').includes('muito'), 'o valor recusado não é ecoado');
});

test('alertThresholds: padrões da V1 e valores do .env validados', async () => {
  const { alertThresholds } = await import('../../server/config.js');
  assert.deepEqual(alertThresholds(() => ''), { diskPct: 90, ramPct: 90, tempC: 60, hysteresis: 5, offlineAfter: 2 });
  const vals = { ALERT_DISK_PCT: '85', ALERT_RAM_PCT: '95', ALERT_TEMP_C: '70', ALERT_HYSTERESIS: '3', ALERT_OFFLINE_AFTER: '11' };
  const w = [];
  assert.deepEqual(alertThresholds((k) => vals[k], w), { diskPct: 85, ramPct: 95, tempC: 70, hysteresis: 3, offlineAfter: 2 });
  assert.deepEqual(w, ['ALERT_OFFLINE_AFTER inválido (aceita 1–10); usando 2']);
  assert.deepEqual(config.ALERTS, alertThresholds(() => ''), 'sem ALERT_* no ambiente de teste');
});

// ── Modo sistema (ADR 0042, decisão 3; F9 etapa 2) ─────────────────────────────────────
// O lançador do pacote liga o modo com SERVER_DASHBOARD_MODO=sistema. Os dados de cada pessoa
// vão para as pastas XDG dela; o código em /opt nunca recebe dado.

test('modo: só o valor exato "sistema" liga o modo sistema', () => {
  assert.equal(SINAL_MODO_SISTEMA, 'SERVER_DASHBOARD_MODO');
  assert.equal(modoDaInstalacao({}), 'clone');
  assert.equal(modoDaInstalacao({ SERVER_DASHBOARD_MODO: 'sistema' }), 'sistema');
  for (const v of ['', 'SISTEMA', '1', 'sistema ', 'clone', 'true']) {
    assert.equal(modoDaInstalacao({ SERVER_DASHBOARD_MODO: v }), 'clone', `valor ${JSON.stringify(v)}`);
  }
});

test('modo clone: sem o sinal, nada muda (código, .env e data/ na pasta do projeto)', () => {
  assert.deepEqual(pastasDaInstalacao({ ambiente: {}, home: '/home/ana', codigo: '/proj' }),
    { modo: 'clone', codigo: '/proj', config: '/proj', dados: '/proj' });
  // O processo dos testes roda sem o sinal: as pastas são as de sempre.
  assert.equal(PASTAS.modo, 'clone');
  assert.equal(DATA_ROOT, ROOT);
  assert.equal(ENV_FILE, path.join(ROOT, '.env'));
  assert.equal(clampPathToData('', 'history.json'), path.join(ROOT, 'data', 'history.json'));
  assert.deepEqual(prepararPastas({ modo: 'clone', codigo: '/proj', config: '/proj', dados: '/proj' }), [], 'clone não cria pasta');
});

test('modo sistema: pastas XDG padrão, XDG_* absolutos respeitados, relativos ignorados', () => {
  const sistema = { SERVER_DASHBOARD_MODO: 'sistema' };
  assert.deepEqual(pastasDaInstalacao({ ambiente: sistema, home: '/home/ana', codigo: '/opt/server-dashboard/atual' }), {
    modo: 'sistema',
    codigo: '/opt/server-dashboard/atual',
    config: '/home/ana/.config/server-dashboard',
    dados: '/home/ana/.local/share/server-dashboard',
  });
  const xdg = pastasDaInstalacao({ ambiente: { ...sistema, XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/dados' }, home: '/home/ana' });
  assert.equal(xdg.config, '/cfg/server-dashboard');
  assert.equal(xdg.dados, '/dados/server-dashboard');
  // A especificação XDG manda ignorar caminho relativo (dependeria da pasta atual).
  const rel = pastasDaInstalacao({ ambiente: { ...sistema, XDG_CONFIG_HOME: 'cfg', XDG_DATA_HOME: '../d' }, home: '/home/ana' });
  assert.equal(rel.config, '/home/ana/.config/server-dashboard');
  assert.equal(rel.dados, '/home/ana/.local/share/server-dashboard');
  // Sem pasta pessoal absoluta, os dados cairiam na pasta atual: recusa.
  for (const home of ['', 'relativa', null]) {
    assert.throws(() => pastasDaInstalacao({ ambiente: sistema, home }), /sem pasta pessoal/);
  }
});

test('modo sistema: clampPathToData prende em <dados>/data e recusa o código e o resto', () => {
  const dados = '/home/ana/.local/share/server-dashboard';
  const data = path.join(dados, 'data');
  assert.equal(clampPathToData('data/custom.json', 'history.json', dados), path.join(data, 'custom.json'));
  assert.equal(clampPathToData(path.join(data, 'x.json'), 'history.json', dados), path.join(data, 'x.json'));
  for (const fora of [
    '/opt/server-dashboard/atual/data/history.json', // a pasta do código
    '/opt/server-dashboard/estado/x', '/etc/passwd', '/tmp/evil.json',
    '../../.config/server-dashboard/.env', // o .env da pessoa
    'data/../../x', data + '-irma/x', dados,
  ]) {
    assert.equal(clampPathToData(fora, 'history.json', dados), path.join(data, 'history.json'), fora);
  }
  assert.equal(sshConfigFile('/opt/server-dashboard/atual/data/ssh/config', dados), path.join(data, 'ssh', 'config'));
  assert.equal(sshConfigFile('data/ssh/config', dados), path.join(data, 'ssh', 'config'));
});

test('modo sistema: prepararPastas cria e fecha as pastas com 0700, sem mexer nas de cima', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modo-sistema-'));
  aoFim(t, () => fs.rmSync(tmp, { recursive: true, force: true }));
  const pastas = pastasDaInstalacao({ ambiente: { SERVER_DASHBOARD_MODO: 'sistema' }, home: tmp });
  // A pasta de dados já existe aberta: precisa ser fechada.
  fs.mkdirSync(pastas.dados, { recursive: true, mode: 0o755 });
  fs.chmodSync(pastas.dados, 0o755);
  fs.chmodSync(path.join(tmp, '.local', 'share'), 0o755);
  const feitas = prepararPastas(pastas);
  assert.deepEqual(feitas, [pastas.config, pastas.dados, path.join(pastas.dados, 'data')]);
  for (const dir of feitas) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  assert.equal(fs.statSync(path.join(tmp, '.local', 'share')).mode & 0o777, 0o755, 'a pasta XDG de cima é da pessoa');
});

test('modo sistema: o painel lê o .env XDG e grava dados só na pasta XDG', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modo-sistema-'));
  aoFim(t, () => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = path.join(tmp, 'cfg', 'server-dashboard');
  fs.mkdirSync(cfg, { recursive: true });
  // .env da pessoa: porta válida, caminhos que tentam sair de data/ (o código e o /etc).
  fs.writeFileSync(path.join(cfg, '.env'), [
    'PORT=3999', `HISTORY_FILE=${path.join(ROOT, 'data', 'history.json')}`, 'LOG_FILE=../../etc/x.log',
    'SSH_CONFIG=data/ssh/config',
  ].join('\n'));
  const ambiente = { ...process.env, SERVER_DASHBOARD_MODO: 'sistema', HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, 'cfg') };
  delete ambiente.XDG_DATA_HOME;
  for (const k of ['PORT', 'HISTORY_FILE', 'LOG_FILE', 'SSH_CONFIG']) delete ambiente[k];
  const code = `import('./server/config.js').then(({ config, PASTAS, ENV_FILE, DATA_ROOT }) => {
    console.log(JSON.stringify({ modo: PASTAS.modo, ENV_FILE, DATA_ROOT, port: config.PORT,
      history: config.HISTORY_FILE, log: config.LOG_FILE, ssh: config.SSH_CONFIG }));
  })`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: ambiente, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  const dados = path.join(tmp, '.local', 'share', 'server-dashboard');
  assert.equal(c.modo, 'sistema');
  assert.equal(c.ENV_FILE, path.join(cfg, '.env'));
  assert.equal(c.DATA_ROOT, dados);
  assert.equal(c.port, 3999, 'o .env lido é o XDG');
  assert.equal(c.history, path.join(dados, 'data', 'history.json'), 'a pasta do código é recusada');
  assert.equal(c.log, path.join(dados, 'data', 'dashboard.log'));
  assert.equal(c.ssh, path.join(dados, 'data', 'ssh', 'config'));
  assert.ok(!fs.existsSync(path.join(tmp, '.local')), 'carregar a configuração não cria nada no disco');
});
