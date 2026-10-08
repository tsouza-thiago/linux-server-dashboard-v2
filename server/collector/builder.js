// Monta o comando de coleta V2: um único script POSIX sh, somente leitura, executado
// pelo SSH 1 vez por poll. Cada seção começa com um marcador ===NOME=== que o parser
// (./parser.js) reconhece. Lê /proc e /sys direto (imune a locale) e termina com
// ===FIM=== para o parser saber se a saída veio inteira.
//
// O mesmo script serve para os dois modos de acesso (ADR 0008):
// - direto: o painel envia o script inteiro, com o modo ("basico" ou "smart") embutido;
// - comando forçado: o script fica no authorized_keys e o painel envia só a palavra do
//   modo, que chega ao script como $SSH_ORIGINAL_COMMAND e é usada apenas num `case`.
import crypto from 'node:crypto';
import { sanitizeToken } from '../config.js';

export const COLLECTOR_VERSION = 2;
export const MODES = ['basico', 'smart'];
const MODE_PLACEHOLDER = '__MODO__';

/** Normaliza e saneia os alvos da coleta (whitelist do config.js, sem `-` inicial). */
export function normalizeTargets({ netIf = '', mounts = ['/'], devs = [], services = [] } = {}) {
  const one = (v) => sanitizeToken(String(v || ''))[0] || '';
  const many = (list) => [...new Set(sanitizeToken((Array.isArray(list) ? list : [list]).join(' ')))];
  const cleanMounts = many(mounts);
  return {
    netIf: one(netIf),
    mounts: cleanMounts.length ? cleanMounts : ['/'],
    devs: many(devs),
    services: many(services),
  };
}

/** Hash curto e estável da configuração da coleta (detecta authorized_keys desatualizado). */
export function targetsHash(targets) {
  const t = normalizeTargets(targets);
  const canonical = JSON.stringify({ v: COLLECTOR_VERSION, ...t });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

function section(name, body) {
  return `echo '===${name}==='; ${body}`;
}

function buildTemplate(targets) {
  const t = normalizeTargets(targets);
  const hash = targetsHash(t);
  const parts = [
    // No comando forçado, o que o cliente pede só escolhe entre "smart" e "basico": qualquer
    // outro texto vira "basico" e nunca é executado nem ecoado.
    `LC_ALL=C; export LC_ALL; M="\${SSH_ORIGINAL_COMMAND:-${MODE_PLACEHOLDER}}"; case "$M" in smart) ;; *) M=basico;; esac`,
    section('VER', `echo '${COLLECTOR_VERSION} ${hash}'; echo "$M"`),
    section('HOST', 'cat /proc/sys/kernel/hostname'),
    section('OS', "uname -r; grep -E '^(PRETTY_NAME|NAME)=' /etc/os-release 2>/dev/null"),
    section('CPU', 'getconf _NPROCESSORS_ONLN 2>/dev/null'),
    section('UPTIME', 'cat /proc/uptime'),
    section('LOAD', 'cat /proc/loadavg'),
    section('STAT', 'head -1 /proc/stat'),
    section('MEM', "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree|Dirty|Writeback):' /proc/meminfo"),
    section('DF', `df -B1 --output=source,target,size,used,avail,pcent,ipcent ${t.mounts.join(' ')} 2>/dev/null`),
  ];
  if (t.netIf) {
    parts.push(section('NET', `awk -F: -v i='${t.netIf}' '{n=$1; gsub(/[ \\t]/,"",n)} n==i' /proc/net/dev`));
  }
  if (t.devs.length) {
    const cond = t.devs.map((d) => `$3=="${d}"`).join('||');
    parts.push(section('IO', `awk '${cond}' /proc/diskstats`));
  }
  parts.push(
    section('PSI', 'for f in cpu memory io; do printf \'%s \' "$f"; grep -h . /proc/pressure/$f 2>/dev/null | tr \'\\n\' \' \'; echo; done'),
    section('TEMP', 'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && printf \'%s %s\\n\' "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"; done 2>/dev/null; true'),
  );
  if (t.devs.length) {
    // 1 linha por disco, SEMPRE terminada em \n (corrige B1). Root roda direto; os demais
    // usam sudo -n (sem senha, nunca pergunta), liberado só para `smartctl -H /dev/X`.
    const loop = [
      `for d in ${t.devs.join(' ')}; do`,
      'if [ "$(id -u)" = 0 ]; then r=$(smartctl -H "/dev/$d" 2>&1); else r=$(sudo -n smartctl -H "/dev/$d" 2>&1); fi;',
      'case "$r" in *"result: PASSED"*|*"Health Status: OK"*) s=PASSED;; *"result: FAILED"*|*"Health Status: FAIL"*) s=FAILED;;',
      '*"smartctl: not found"*|*"smartctl: command not found"*) s=SEM_SMARTCTL;;',
      '*"sudo:"*|*ermission*|*"Operation not permitted"*) s=SEM_PERMISSAO;; *) s=DESCONHECIDO;; esac;',
      'printf \'%s %s\\n\' "$d" "$s"; done',
    ].join(' ');
    parts.push(section('SMART', `case "$M" in smart) ${loop};; *) echo pulado;; esac`));
  }
  if (t.services.length) {
    parts.push(section('SERVICES', `for s in ${t.services.join(' ')}; do printf '%s %s\\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)"; done`));
  }
  parts.push(
    section('PS', 'ps -eo user:32,pid,pcpu,pmem,rss,etimes,args --sort=-rss 2>/dev/null | head -9'),
    "echo '===FIM==='",
  );
  return { template: parts.join('; '), hash };
}

/**
 * Script completo para o modo direto (o painel envia o script).
 * @param {object} targets alvos ({ netIf, mounts, devs, services })
 * @param {'basico'|'smart'} mode inclui o teste SMART quando 'smart'
 */
export function buildScript(targets, mode = 'basico') {
  if (!MODES.includes(mode)) throw new Error(`modo de coleta inválido: ${mode}`);
  const { template, hash } = buildTemplate(targets);
  return { script: template.replace(MODE_PLACEHOLDER, mode), hash, version: COLLECTOR_VERSION };
}

/** Script para o authorized_keys (comando forçado): o modo vem do cliente. */
export function buildForcedScript(targets) {
  const { template, hash } = buildTemplate(targets);
  return { script: template.replace(MODE_PLACEHOLDER, 'basico'), hash, version: COLLECTOR_VERSION };
}
