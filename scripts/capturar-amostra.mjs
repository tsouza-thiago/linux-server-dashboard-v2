#!/usr/bin/env node
// Captura a saída BRUTA do comando de coleta (1 única conexão SSH, igual a um poll) e
// gera uma cópia anonimizada para virar fixture de teste da V2.
//
//   node scripts/capturar-amostra.mjs [--saida=PASTA]
//
// Grava em data/ (0700, fora do git), ou na PASTA indicada:
//   data/amostra-bruta.txt    — saída original (NÃO compartilhe)
//   data/amostra-anonima.txt  — hostname, IPs, MACs e usuários trocados por marcadores
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ROOT, isPlaceholderHost } from '../server/config.js';
import { buildCommand } from '../server/poller.js';

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const KEEP_USERS = new Set(['root', 'daemon', 'nobody', 'systemd+', 'message+', 'avahi', 'polkitd', 'syslog', '_rpc', 'statd']);

/**
 * Troca dados que identificam a rede/servidor por marcadores estáveis.
 * Mantém estrutura, números de métricas e nomes de dispositivos (sda, enp3s0),
 * que são necessários para testar o parser.
 */
export function anonymize(raw, { sshHost = '' } = {}) {
  const map = new Map();
  const counters = { ip: 0, mac: 0, user: 0 };
  const swap = (value, make) => {
    if (!map.has(value)) map.set(value, make());
    return map.get(value);
  };
  let out = String(raw);

  const hostLine = out.match(/===HOST===\r?\n([^\r\n]+)/);
  const hostnames = [hostLine && hostLine[1].trim(), String(sshHost).split('@').pop()]
    .filter((h) => h && !/^\d+\.\d+\.\d+\.\d+$/.test(h));
  for (const h of new Set(hostnames)) {
    const re = new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    out = out.replace(re, () => swap(`host:${h}`, () => 'servidor-exemplo'));
  }

  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => {
    if (ip === '127.0.0.1' || ip === '0.0.0.0') return ip;
    return swap(`ip:${ip}`, () => `192.0.2.${++counters.ip}`);
  });

  out = out.replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, (mac) =>
    swap(`mac:${mac.toLowerCase()}`, () => `02:00:00:00:00:${String(++counters.mac).padStart(2, '0')}`));

  // usuários na seção PS (1ª coluna), exceto contas de sistema comuns
  out = out.replace(/(===PS===\r?\n)([\s\S]*?)(?=\r?\n===|$)/, (_, head, body) => head + body
    .split('\n')
    .map((line) => line.replace(/^(\S+)/, (user) => {
      if (user === 'USER' || KEEP_USERS.has(user)) return user;
      return swap(`user:${user}`, () => `usuario${++counters.user}`);
    }))
    .join('\n'));

  return { text: out, replaced: map.size };
}

function runOnce(host, command, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...SSH_OPTS, host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ stdout, stderr: err.message, code: -1 }); });
  });
}

async function main() {
  const host = config.SSH_HOST;
  if (isPlaceholderHost(host)) {
    console.error('ERRO: SSH_HOST não configurado no .env. Rode ./dashboard instalar antes.');
    process.exit(1);
  }
  console.log('Capturando 1 amostra (1 conexão SSH, somente leitura)…');
  console.log('Se o painel estiver rodando, esta será uma coleta extra neste minuto.');
  const started = Date.now();
  const { stdout, stderr, code } = await runOnce(host, buildCommand({}, 'smart'));
  const ms = Date.now() - started;
  if (code !== 0 || !stdout.includes('===HOST===')) {
    console.error(`ERRO: a coleta falhou (código ${code}). ${stderr.trim()}`);
    process.exit(1);
  }
  const arg = process.argv.find((a) => a.startsWith('--saida='));
  const dataDir = arg ? path.resolve(arg.slice('--saida='.length)) : path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const rawFile = path.join(dataDir, 'amostra-bruta.txt');
  const anonFile = path.join(dataDir, 'amostra-anonima.txt');
  fs.writeFileSync(rawFile, stdout, { mode: 0o600 });
  const { text, replaced } = anonymize(stdout, { sshHost: host });
  fs.writeFileSync(anonFile, text, { mode: 0o600 });
  console.log(`OK em ${ms} ms · ${Buffer.byteLength(stdout)} bytes · ${replaced} valor(es) anonimizado(s)`);
  console.log(`  bruta (não compartilhe): ${rawFile}`);
  console.log(`  anonimizada:             ${anonFile}`);
  console.log('Confira a versão anonimizada antes de enviar: nada de nomes, IPs ou usuários reais.');
}

const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) await main();
