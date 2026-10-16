#!/usr/bin/env node
// Soak acelerado (F9): roda o painel de verdade (createApp: histórico NDJSON, agregados de
// 5 min, motor de alertas, SSE com 1 navegador conectado) por mais de 72 h de coletas
// simuladas, em poucos segundos. Cada coleta passa pelo coletor real (parser + taxas) com a
// saída anonimizada do servidor do mantenedor; só o SSH e o relógio são falsos.
//
// Fase 1 — enche a janela de 72 h depressa e confere que a memória ocupada (heap depois de
//          um gc) para de crescer quando a janela enche: sem vazamento.
// Fase 2 — num processo novo, o painel reinicia com as 72 h lidas do disco e faz coletas em
//          ritmo calmo; mede a RAM do Node (RSS) como ela fica no uso real. Orçamento do
//          plano (Q17, revisto em 16/10/2026): até 110 MB. O Node 24 vazio já usa ~44 MB e o
//          painel sem histórico, ~62 MB.
//
//   npm run soak                      # 5000 coletas (~83 h simuladas)
//   npm run soak -- --coletas 8000
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { collect } from '../server/collector/index.js';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), '..');
const RAM_LIMIT_MB = 110;
const GROWTH_LIMIT_MB = 4;
const STEP_MS = 60_000;
const WINDOW = 4320;

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const mb = (n) => Math.round((n / 1048576) * 10) / 10;
if (!globalThis.gc) {
  console.error('rode com node --expose-gc (o npm run soak já passa a opção)');
  process.exit(2);
}

const fixture = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'coleta-v2', 'debian13-real.txt'), 'utf8');
const targets = { netIf: 'enp0s7', mounts: ['/'], devs: ['sda'], services: ['smbd'] };

// O coletor real, com a saída do servidor e o relógio avançando 1 min por coleta. Os
// contadores crescem para as taxas (CPU, rede, uptime) não ficarem nulas.
function fakeCollect(startMs, first = 0) {
  let tick = first;
  return ({ host, prev }) => {
    tick += 1;
    const stdout = fixture
      .replace(/^cpu\s+(\d+)/m, (_, n) => `cpu  ${Number(n) + tick * 6000}`)
      .replace(/(enp0s7:\s*)(\d+)/, (_, a, n) => `${a}${Number(n) + tick * 750_000}`)
      .replace(/(===UPTIME===\n)(\d+)/, (_, a, n) => `${a}${Number(n) + tick * 60}`);
    return collect({ host, prev, targets, now: startMs + tick * STEP_MS, runner: async () => ({ stdout, stderr: '', code: 0 }) });
  };
}

async function startPanel(dir, collectFn) {
  const app = createApp({
    sshHost: 'servidor', pollInterval: STEP_MS, targets, dashToken: '',
    historyFile: path.join(dir, 'history.json'), alertsFile: path.join(dir, 'alerts.json'),
    annotationsFile: path.join(dir, 'annotations.json'), collect: collectFn, log: () => {},
  });
  const server = await new Promise((resolve) => { const s = app.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  // 1 navegador conectado ao tempo real o tempo todo (cada coleta vira um evento SSE).
  const sse = { bytes: 0 };
  sse.req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.on('data', (d) => { sse.bytes += d.length; });
  });
  sse.req.on('error', () => {});
  const stop = async () => { sse.req.destroy(); await app.shutdown(); await new Promise((r) => server.close(r)); };
  return { app, sse, stop };
}

// Memória que FICA ocupada (depois de um gc e de o disco gravar): acelerado, o gc não
// acompanha sozinho.
async function settle() {
  for (let k = 0; k < 3; k++) { await new Promise((r) => setTimeout(r, 30)); globalThis.gc(); }
  return process.memoryUsage();
}

// ------------------------------------------------------------------ fase 2 (processo filho)
if (process.argv.includes('--fase2')) {
  const dir = arg('--dir');
  const startMs = Number(arg('--inicio'));
  const first = Number(arg('--depois-de'));
  const polls = 120;
  const t0 = performance.now();
  const { app, sse, stop } = await startPanel(dir, fakeCollect(startMs, first));
  const loadMs = Math.round(performance.now() - t0);
  const loaded = app.store.length;
  const cpu0 = process.cpuUsage();
  let maxRss = 0;
  for (let i = 0; i < polls; i++) {
    await app.runPoll();
    await new Promise((r) => setTimeout(r, 10));
    if (i % 20 === 19) maxRss = Math.max(maxRss, (await settle()).rss);
  }
  const cpu = process.cpuUsage(cpu0);
  const m = await settle();
  await stop();
  console.log(JSON.stringify({
    loaded, loadMs, rssMB: mb(m.rss), maxRssMB: mb(maxRss), heapMB: mb(m.heapUsed),
    cpuMsPorColeta: Math.round(((cpu.user + cpu.system) / 1000 / polls) * 100) / 100,
    sseKB: Math.round(sse.bytes / 1024), amostras: app.store.length,
  }));
  process.exit(0);
}

// ------------------------------------------------------------------ fase 1
const TOTAL = Number(arg('--coletas') ?? 5000);
if (!Number.isInteger(TOTAL) || TOTAL < WINDOW + 80) {
  console.error(`use --coletas com pelo menos ${WINDOW + 80} (a janela de 72 h tem ${WINDOW})`);
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-soak-'));
const startMs = Date.now() - (TOTAL + 200) * STEP_MS;
const { app, sse, stop } = await startPanel(dir, fakeCollect(startMs));
const marks = [];
const t0 = performance.now();
let ok = 0;
for (let i = 1; i <= TOTAL; i++) {
  await app.runPoll();
  if (app.state.online) ok += 1;
  await new Promise((r) => setImmediate(r));
  if (i % 500 === 0 || i === WINDOW || i === TOTAL) {
    const m = await settle();
    marks.push({ coletas: i, horas: Math.round((i * STEP_MS) / 36e5), heapMB: mb(m.heapUsed), amostras: app.store.length });
  }
}
const elapsed = (performance.now() - t0) / 1000;
const sseKB = Math.round(sse.bytes / 1024);
await stop();
const diskKB = (d) => (fs.existsSync(d) ? Math.round(fs.readdirSync(d).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0) / 1024) : 0);
const rawKB = diskKB(path.join(dir, 'history'));
const rollupKB = diskKB(path.join(dir, 'rollup'));

const child = spawnSync(process.execPath, ['--expose-gc', SELF, '--fase2', '--dir', dir, '--inicio', String(startMs), '--depois-de', String(TOTAL)], { encoding: 'utf8' });
fs.rmSync(dir, { recursive: true, force: true });
if (child.status !== 0) {
  console.error(child.stderr || child.stdout);
  process.exit(1);
}
const f2 = JSON.parse(child.stdout.trim().split('\n').pop());

console.log(`Fase 1 — ${TOTAL} coletas (${Math.round((TOTAL * STEP_MS) / 36e5)} h simuladas) em ${elapsed.toFixed(1)} s`);
console.table(marks);
console.log(`disco: ${rawKB} KB brutos (72 h) + ${rollupKB} KB agregados · SSE: ${sseKB} KB enviados`);
console.log(`\nFase 2 — painel reiniciado com ${f2.loaded} amostras do disco (${f2.loadMs} ms), 120 coletas em ritmo calmo`);
console.log(`RSS ${f2.rssMB} MB (máximo ${f2.maxRssMB} MB) · heap ${f2.heapMB} MB · CPU ${f2.cpuMsPorColeta} ms por coleta\n`);

const full = marks.find((m) => m.coletas === WINDOW);
const last = marks.at(-1);
const growth = Math.round((last.heapMB - full.heapMB) * 10) / 10;
const peakRss = Math.max(f2.rssMB, f2.maxRssMB);
const checks = [
  [`RAM do Node com 72 h na memória: ${peakRss} MB (limite ${RAM_LIMIT_MB} MB)`, peakRss <= RAM_LIMIT_MB],
  [`memória depois da janela de 72 h encher: ${growth >= 0 ? '+' : ''}${growth} MB (limite +${GROWTH_LIMIT_MB} MB, sem vazamento)`, growth <= GROWTH_LIMIT_MB],
  [`amostras em memória: ${last.amostras} e ${f2.amostras} (janela de 72 h = ${WINDOW})`, last.amostras <= WINDOW && f2.amostras <= WINDOW],
  [`coletas aceitas: ${ok} de ${TOTAL}`, ok === TOTAL],
  ['SSE entregou as coletas ao navegador', sseKB > 0 && f2.sseKB > 0],
];
for (const [text, pass] of checks) console.log(`${pass ? '✓' : '✗'} ${text}`);
const failed = checks.filter(([, pass]) => !pass).length;
console.log(failed ? `\nREPROVADO (${failed})` : '\nAPROVADO');
process.exit(failed ? 1 : 0);
