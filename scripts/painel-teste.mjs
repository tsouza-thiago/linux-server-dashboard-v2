#!/usr/bin/env node
// Painel de teste para os testes no navegador (ADR 0019): sobe o painel de verdade
// (createApp) em 127.0.0.1, numa porta separada, sem token e com dados semeados numa pasta
// temporária. Nada de SSH nem de data/: a coleta usa a saída anonimizada da fixture do
// servidor (test/fixtures/coleta-v2/debian13-real.txt), como o soak.
//
//   npm run painel-teste                              # cenário normal, porta 3943
//   npm run painel-teste -- --cenario=lacunas --porta=3944
//
// Cenários:
//   normal   10 dias de agregados + 72 h de amostras a cada minuto, sem queda; coleta ao vivo
//   lacunas  dias sem coleta e um dia inteiro em queda (disponibilidade só sobre o tempo
//            medido, ADR 0018); coleta ao vivo
//   offline  24 h de amostras e o servidor caindo agora (queda em andamento)
//   vazio    nenhum dado e nenhuma coleta (o 1º uso, antes da 1ª coleta)
//
// Ctrl+C encerra o painel e apaga a pasta temporária.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { collect } from '../server/collector/index.js';
import { History } from '../server/storage/index.js';
import { OutageLog } from '../server/storage/outages.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60000;
const DAY = 1440 * MIN;
export const CENARIOS = ['normal', 'lacunas', 'offline', 'vazio'];
// Os alvos da fixture: 4 pastas em 3 discos, rede e 1 serviço (todas as telas têm o que mostrar).
export const ALVOS = { netIf: 'enp0s7', mounts: ['/', '/mnt/sdb1', '/mnt/sdc1', '/mnt/sdc2'], devs: ['sda', 'sdb', 'sdc'], services: ['smbd'] };
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'coleta-v2', 'debian13-real.txt'), 'utf8');

/**
 * Coletor falso: a saída da fixture com os contadores avançando conforme o instante, para
 * as taxas (CPU, rede, disco) e o uptime terem valores. Mesma ideia do soak.
 */
export function coletorFalso() {
  let prev = null;
  return async (now) => {
    const min = Math.floor(now / MIN);
    const stdout = FIXTURE
      // 1 núcleo, 6000 tiques por minuto: ~5% usuário, 2% sistema, 1% espera de disco, resto ocioso.
      .replace(/^cpu\s+(\d+) (\d+) (\d+) (\d+) (\d+)/m, (_, us, ni, sy, id, io) =>
        `cpu  ${Number(us) + min * 300} ${ni} ${Number(sy) + min * 120} ${Number(id) + min * 5520} ${Number(io) + min * 60}`)
      .replace(/(enp0s7:\s*)(\d+)/, (_, a, n) => `${a}${Number(n) + min * 750_000}`)
      .replace(/(===UPTIME===\n)(\d+)/, (_, a, n) => `${a}${Number(n) + (min % 100000) * 60}`);
    const r = await collect({ host: 'servidor', prev, targets: ALVOS, now, runner: async () => ({ stdout, stderr: '', code: 0 }) });
    if (r.ok) prev = r.sample;
    return r;
  };
}

// Instante (ms) de `dias` atrás, na hora local `hora`.
const diaHora = (agora, dias, hora) => { const d = new Date(agora - dias * DAY); d.setHours(hora, 0, 0, 0); return d.getTime(); };

/**
 * Grava em `dir` (o data/ do painel de teste) os dados do cenário. `opcoes` encurta os
 * períodos nos testes. Devolve o coletor falso, para a coleta ao vivo continuar de onde parou.
 */
export async function semear(dir, cenario, { agora = Date.now(), horasBrutas = 72, diasAntigos = 10 } = {}) {
  if (!CENARIOS.includes(cenario)) throw new Error(`cenário desconhecido: ${cenario} (use ${CENARIOS.join(', ')})`);
  const coletar = coletorFalso();
  const h = new History({ dataDir: dir, log: () => {} });
  const quedas = new OutageLog({ file: path.join(dir, 'outages.ndjson'), log: () => {} });
  const guardar = async (de, ate, passo) => {
    for (let t = de; t < ate; t += passo) {
      const r = await coletar(t);
      if (r.ok) h.append(r.sample);
    }
  };
  if (cenario === 'normal') {
    const inicioBruto = agora - horasBrutas * 60 * MIN;
    await guardar(inicioBruto - diasAntigos * DAY, inicioBruto, 5 * MIN);
    await guardar(inicioBruto, agora, MIN);
  } else if (cenario === 'lacunas') {
    // 6 dias atrás: 2 h; 3 dias atrás: 2 h e uma queda que atravessa o dia seguinte inteiro;
    // hoje: as 2 primeiras horas. Os outros dias ficam sem coleta.
    await guardar(diaHora(agora, 6, 9), diaHora(agora, 6, 11), MIN);
    await guardar(diaHora(agora, 3, 9), diaHora(agora, 3, 11), MIN);
    quedas.start(diaHora(agora, 3, 11) + MIN, 'teste: servidor desligado');
    quedas.end(diaHora(agora, 1, 0) + 5 * MIN);
    await guardar(Math.min(diaHora(agora, 0, 0), agora - 2 * 60 * MIN), Math.min(diaHora(agora, 0, 2), agora), MIN);
  } else if (cenario === 'offline') {
    await guardar(agora - 24 * 60 * MIN, agora - 10 * MIN, MIN);
  }
  await h.flush();
  await quedas.flush();
  return { coletar };
}

/** Lê --nome=valor da linha de comando. */
const opcao = (nome, padrao) => {
  const a = process.argv.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.slice(nome.length + 3) : padrao;
};

async function main() {
  const cenario = opcao('cenario', 'normal');
  const porta = Number(opcao('porta', '3943'));
  if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) throw new Error('use --porta entre 1024 e 65535');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-painel-teste-'));
  const { coletar } = await semear(dir, cenario);
  // offline: toda coleta falha (o motor abre a queda depois de 2 falhas seguidas).
  const coleta = cenario === 'offline'
    ? async () => ({ ok: false, error: 'teste: servidor desligado' })
    : () => coletar(Date.now());
  const arq = (nome) => path.join(dir, nome);
  const { app, runPoll, shutdown } = createApp({
    dataDir: dir, historyFile: arq('history.json'), alertsFile: arq('alerts.json'), annotationsFile: arq('annotations.json'),
    outagesFile: arq('outages.ndjson'), sessionsFile: arq('sessions.json'), dashToken: '', sshHost: 'servidor',
    targets: ALVOS, pollInterval: 60000, collect: coleta, log: () => {},
  });
  if (cenario === 'offline') { await runPoll(); await runPoll(); }
  // vazio fica sem coleta: é o estado do 1º uso, antes da 1ª amostra chegar.
  const timer = cenario === 'vazio' ? null : setInterval(runPoll, 60000);
  // Só 127.0.0.1 (I6), como o painel de verdade.
  const server = app.listen(porta, '127.0.0.1', () => {
    console.log(`painel de teste (${cenario}) em http://127.0.0.1:${porta} — dados em ${dir}`);
    console.log('Ctrl+C encerra e apaga os dados de teste.');
  });
  const sair = async () => {
    if (timer) clearInterval(timer);
    server.close();
    await shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', sair);
  process.on('SIGTERM', sair);
}

const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) main().catch((err) => { console.error(`ERRO: ${err.message}`); process.exit(1); });
