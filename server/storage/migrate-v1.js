// Migração do histórico da V1 (data/history.json, um único array JSON) para o formato da
// V2 (ADR 0005). Idempotente e sem perda: grava os arquivos diários e os agregados e só
// então renomeia o arquivo da V1 para history.v1-migrado.json — backup que nunca é apagado
// automaticamente. Se cair no meio, rodar de novo produz o mesmo resultado.
//
//   node server/storage/migrate-v1.js              migra agora (o painel também migra ao iniciar)
//   node server/storage/migrate-v1.js --verificar  só mostra o que seria migrado; não grava nada
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregate } from './buckets.js';
import { readNdjson, writeFileAtomicSync, dayOf } from './ndjson.js';
import { RollupStore, ROLLUP_STEP_MS } from './rollup.js';
import { RAW_RETENTION_MS } from './index.js';

export const BACKUP_NAME = 'history.v1-migrado.json';

const validTs = (s) => s && typeof s.ts === 'string' && Number.isFinite(Date.parse(s.ts));
const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

function dedupe(list) {
  const map = new Map();
  for (const s of list) map.set(s.ts, s);
  return [...map.values()].sort(byTs);
}

/** Lê o arquivo da V1 e resume o conteúdo, sem gravar nada. */
export function inspectV1(v1File) {
  let raw;
  try {
    raw = fs.readFileSync(v1File, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'ausente', file: v1File };
    return { status: 'invalido', file: v1File, error: err.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'invalido', file: v1File, error: `JSON inválido: ${err.message}` };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.samples) ? parsed.samples : null;
  if (!list) return { status: 'invalido', file: v1File, error: 'formato desconhecido (esperado uma lista de amostras)' };
  const samples = dedupe(list.filter(validTs));
  const days = [...new Set(samples.map((s) => dayOf(s.ts)))];
  return {
    status: 'ok',
    file: v1File,
    bytes: Buffer.byteLength(raw),
    total: list.length,
    invalid: list.length - list.filter(validTs).length,
    samples,
    from: samples[0]?.ts ?? null,
    to: samples.at(-1)?.ts ?? null,
    days: days.length,
  };
}

function backupPath(v1File) {
  const dir = path.dirname(v1File);
  const first = path.join(dir, BACKUP_NAME);
  if (!fs.existsSync(first)) return first;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(dir, BACKUP_NAME.replace('.json', `-${stamp}.json`));
}

/**
 * Migra o histórico da V1 para `dataDir` (history/ + rollup/).
 * @returns {object} resumo; `status` é 'ausente', 'invalido', 'verificado' ou 'migrado'
 */
export function migrateV1({ v1File, dataDir, dryRun = false, retentionMs = RAW_RETENTION_MS, log = () => {} }) {
  const info = inspectV1(v1File);
  if (info.status !== 'ok') return info;
  if (dryRun) return { ...info, status: 'verificado' };

  const { samples } = info;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // 1. Amostras brutas: só os dias que ainda cabem na janela de 72 h (o resto vive nos agregados).
  const rawDir = path.join(dataDir, 'history');
  const firstRawDay = samples.length ? dayOf(Date.parse(samples.at(-1).ts) - retentionMs) : null;
  const byDay = new Map();
  for (const s of samples) {
    const day = dayOf(s.ts);
    if (day < firstRawDay) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  for (const [day, list] of byDay) {
    const file = path.join(rawDir, `${day}.ndjson`);
    const merged = dedupe([...readNdjson(file).items.filter(validTs), ...list]);
    writeFileAtomicSync(file, `${merged.map((s) => JSON.stringify(s)).join('\n')}\n`);
  }

  // 2. Agregados de 5 min de todo o período; o último balde fica aberto para o painel fechar.
  const buckets = aggregate(samples, ROLLUP_STEP_MS);
  const closed = buckets.slice(0, -1);
  new RollupStore({ dir: path.join(dataDir, 'rollup'), log }).writeBucketsSync(closed, writeFileAtomicSync);

  // 3. Só agora o arquivo da V1 vira backup.
  const backup = backupPath(v1File);
  fs.renameSync(v1File, backup);
  try { fs.chmodSync(backup, 0o600); } catch { /* best-effort */ }

  const result = { ...info, status: 'migrado', backup, rawDays: byDay.size, rollupBuckets: closed.length };
  log(`[migração] ${samples.length} amostras da V1 migradas (${info.from} → ${info.to}); backup em ${path.basename(backup)}`);
  return result;
}

/** Texto do relatório da migração (CLI). */
export function describe(result, root = process.cwd()) {
  const rel = (p) => path.relative(root, p) || p;
  if (result.status === 'ausente') return `Nenhum histórico da V1 em ${rel(result.file)} — nada a migrar.`;
  if (result.status === 'invalido') return `Histórico da V1 em ${rel(result.file)} não pôde ser lido: ${result.error}\nO arquivo não foi alterado.`;
  const mb = (result.bytes / 1048576).toFixed(1);
  const lines = [
    `Histórico da V1: ${rel(result.file)} (${mb} MB)`,
    `  amostras válidas: ${result.samples.length}${result.invalid ? ` (inválidas ignoradas: ${result.invalid})` : ''}`,
    `  período: ${result.from ?? '—'} → ${result.to ?? '—'} (${result.days} dia(s))`,
  ];
  if (result.status === 'verificado') {
    lines.push('Nada foi gravado (--verificar). Para migrar: npm run migrar-v1 (o painel também migra sozinho ao iniciar).');
  } else {
    lines.push(`Migrado: ${result.rawDays} arquivo(s) diário(s) brutos e ${result.rollupBuckets} agregado(s) de 5 min.`);
    lines.push(`Backup do arquivo original: ${rel(result.backup)} (pode apagar quando quiser).`);
  }
  return lines.join('\n');
}

const isCLI = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCLI) {
  const { config, ROOT } = await import('../config.js');
  const dryRun = process.argv.includes('--verificar');
  const result = migrateV1({ v1File: config.HISTORY_FILE, dataDir: path.dirname(config.HISTORY_FILE), dryRun });
  console.log(describe(result, ROOT));
  if (result.status === 'invalido') process.exitCode = 1;
}
