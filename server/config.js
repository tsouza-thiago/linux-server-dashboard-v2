// Configuração do painel: o ÚNICO lugar que lê o .env (AGENTS, "Configuração").
//
// Quem usa: o servidor (server/index.js), a coleta (server/poller.js), a CLI e os scripts.
// O que garante (security by design):
//   - cada variável tem padrão e faixa; valor fora da faixa volta ao padrão, com aviso;
//   - os alvos da coleta (pastas, discos, serviços, interface) passam por uma whitelist
//     ANTES de entrar no script que roda no servidor (anti-injeção, CWE-78);
//   - todo caminho de arquivo de dados é forçado para dentro de data/ (clampPathToData).
// O .env é lido uma vez, quando o módulo carrega; process.env tem prioridade sobre ele.
//
// Dois modos de instalação (ADR 0042, decisão 3):
//   - clone (padrão): código, .env e data/ ficam na mesma pasta, a do projeto;
//   - sistema (pacote .deb): o código fica em /opt, só leitura, e os dados de cada pessoa
//     ficam nas pastas XDG dela (~/.config/server-dashboard/.env e
//     ~/.local/share/server-dashboard/data/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Raiz do código (a pasta que contém server/ e public/; no modo clone, também .env e data/). */
export const ROOT = path.join(__dirname, '..');

/**
 * Variável de ambiente que liga o modo sistema. Só o lançador do pacote
 * (/opt/server-dashboard/bin/dashboard, etapa 3 da F9) a define, com o valor exato `sistema`.
 * Por que uma variável de ambiente, e não um arquivo marcador ou o caminho do código:
 *   - o modo decide ONDE fica o .env, então não pode vir do .env (process.env só);
 *   - o lançador é quem escolhe o modo (ADR 0042), e a variável passa dele para o Node, para
 *     o serviço systemd e para os processos filhos sem nenhum arquivo a mais;
 *   - os testes trocam o modo sem mexer no disco.
 * Ela não dá privilégio nenhum: só muda para qual pasta da própria pessoa vão os dados dela.
 * Sem ela (ou com outro valor), tudo fica como no modo clone, sem mudança nenhuma.
 */
export const SINAL_MODO_SISTEMA = 'SERVER_DASHBOARD_MODO';

/** O modo da instalação: `sistema` só com o sinal exato; qualquer outra coisa é `clone`. */
export function modoDaInstalacao(ambiente = process.env) {
  return ambiente[SINAL_MODO_SISTEMA] === 'sistema' ? 'sistema' : 'clone';
}

// Pasta base XDG: a especificação manda ignorar valor relativo (ele dependeria da pasta
// atual, e o painel gravaria dados num lugar imprevisível). Vazio ou relativo usa o padrão.
function pastaXdg(valor, home, padrao) {
  return typeof valor === 'string' && path.isAbsolute(valor) ? valor : path.join(home, padrao);
}

/**
 * As pastas da instalação: `codigo` (server/, public/), `config` (a do .env) e `dados` (a
 * que contém data/ e .backups/). No modo clone, as 3 são a pasta do projeto, como sempre.
 * No modo sistema, `config` e `dados` seguem o XDG_CONFIG_HOME e o XDG_DATA_HOME.
 */
export function pastasDaInstalacao({ ambiente = process.env, home = os.homedir(), codigo = ROOT } = {}) {
  if (modoDaInstalacao(ambiente) !== 'sistema') return { modo: 'clone', codigo, config: codigo, dados: codigo };
  // Sem pasta pessoal absoluta, os dados iriam para a pasta atual (talvez /opt): recusa.
  if (!path.isAbsolute(String(home || ''))) throw new Error('modo sistema sem pasta pessoal (HOME)');
  return {
    modo: 'sistema',
    codigo,
    config: path.join(pastaXdg(ambiente.XDG_CONFIG_HOME, home, '.config'), 'server-dashboard'),
    dados: path.join(pastaXdg(ambiente.XDG_DATA_HOME, home, path.join('.local', 'share')), 'server-dashboard'),
  };
}

/** As pastas desta instalação, decididas 1 vez, quando o módulo carrega. */
export const PASTAS = pastasDaInstalacao();
/** Pasta que contém data/ (e .backups/): a do projeto no modo clone, a XDG no modo sistema. */
export const DATA_ROOT = PASTAS.dados;
/** O .env desta instalação. */
export const ENV_FILE = path.join(PASTAS.config, '.env');

/**
 * As pastas da instalação cujo código está em `root` (ADR 0043). A CLI e a instalação recebem
 * a pasta do código e, a partir dela, acham o .env e o data/:
 *   - a instalação que roda agora (root = ROOT) segue o modo do lançador (PASTAS);
 *   - qualquer outra pasta (a de um teste, a da V1 a importar) é um clone, com o .env e o
 *     data/ dentro dela, como sempre foi.
 * Assim o modo clone fica igual, e o modo sistema nunca grava na pasta do código (/opt).
 * `raiz` e `pastas` existem para os testes simularem o modo sistema sem trocar de processo.
 */
export function pastasDe(root, { raiz = ROOT, pastas = PASTAS } = {}) {
  if (path.resolve(root) === path.resolve(raiz)) return pastas;
  return { modo: 'clone', codigo: root, config: root, dados: root };
}
/** O .env da instalação de `root`. */
export const envDe = (root, opcoes) => path.join(pastasDe(root, opcoes).config, '.env');
/** A pasta data/ da instalação de `root`. */
export const dataDe = (root, opcoes) => path.join(pastasDe(root, opcoes).dados, 'data');
/** A pasta das cópias de data/ (.backups/) da instalação de `root`. */
export const backupsDe = (root, opcoes) => path.join(pastasDe(root, opcoes).dados, '.backups');

/** Onde o pacote .deb fica, se o código não estiver no layout dele (ADR 0042, item 1). */
const PASTA_DO_PACOTE = '/opt/server-dashboard';

/**
 * Os caminhos fixos do pacote para o código em `codigo` (<base>/versoes/vX.Y.Z): o link
 * `atual` (o que o serviço de usuário roda, para valer a versão nova depois da troca) e o
 * lançador. Fora desse layout, usa o /opt/server-dashboard do pacote.
 */
export function caminhosDoPacote(codigo = ROOT) {
  const versoes = path.dirname(path.resolve(codigo));
  const base = path.basename(versoes) === 'versoes' ? path.dirname(versoes) : PASTA_DO_PACOTE;
  return { base, atual: path.join(base, 'atual'), lancador: path.join(base, 'bin', 'dashboard') };
}

/**
 * Cria as pastas pessoais do modo sistema com 0700 (as de hoje: AGENTS, "Permissões") e
 * fecha as que já existem abertas. Só mexe nas pastas do painel, nunca nas pastas XDG de
 * cima (~/.config, ~/.local/share), que são da pessoa. No modo clone não faz nada: lá a
 * instalação (server/setup/local.js) cuida das permissões. Devolve as pastas tratadas.
 */
export function prepararPastas(pastas = PASTAS) {
  if (pastas.modo !== 'sistema') return [];
  const lista = [pastas.config, pastas.dados, path.join(pastas.dados, 'data')];
  for (const dir of lista) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  return lista;
}

/**
 * Lê um arquivo no formato .env (`CHAVE=valor`, uma por linha) e devolve `{ CHAVE: valor }`.
 * Linhas comentadas (#) e linhas fora do formato são ignoradas; aspas nas pontas do valor
 * saem. Arquivo ausente devolve `{}` (o .env é opcional: tudo tem padrão).
 */
export function loadEnvFile(filePath = ENV_FILE) {
  const out = {};
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env opcional */ }
  return out;
}

// O .env desta instalação, lido uma vez.
const fileEnv = loadEnvFile();

/** Valor de uma variável: process.env, depois o .env; vazio ou ausente = `def`. */
export const env = (key, def) => {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === '' ? def : v;
};

// Whitelist dos alvos da coleta: só letras, números e `_ . / : -`. Nada de espaço, aspas,
// `$`, `;`, `|`, crase ou quebra de linha, que mudariam o script no servidor.
const TOKEN_RE = /^[A-Za-z0-9_./:-]+$/;

/**
 * Separa uma lista do .env (separada por espaços) e devolve só os itens seguros: que
 * passam na whitelist e não começam com `-` (não podem virar opção de comando, CWE-88).
 * Itens recusados simplesmente somem: nunca chegam ao servidor.
 */
export function sanitizeToken(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => TOKEN_RE.test(t) && !t.startsWith('-'));
}

// Valores de exemplo que indicam "ainda não instalado" (o .env.example e a V1 usam estes).
const PLACEHOLDER_RE = /seu[-_ ]?host|seu_host|usuario@ip/i;

/** O SSH_HOST ainda é o valor de exemplo? (a CLI usa para dizer "rode ./dashboard instalar"). */
export function isPlaceholderHost(value) {
  return PLACEHOLDER_RE.test(String(value || ''));
}

/** Inteiro dentro de [min, max]; qualquer outra coisa (texto, fora da faixa) vira `def`. */
export function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

/**
 * Inteiro do .env validado: vazio usa o padrão; fora da faixa usa o padrão e registra um
 * aviso (só o nome da variável e o valor numérico recusado — nunca o conteúdo do .env).
 */
export function intSetting(key, raw, def, min, max, warnings) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    warnings.push(`${key} inválido (aceita ${min}–${max}); usando ${def}`);
    return def;
  }
  return n;
}

/**
 * Limiares dos alertas (ADR 0006): fonte única para o motor, o índice de saúde e a tela.
 * `get` lê a variável (padrão: o .env); os avisos de valor recusado vão para `warnings`.
 * Padrões e faixas: AGENTS, tabela "Configuração" (conferida pelo docs.test.js).
 */
export function alertThresholds(get = (k) => env(k, ''), warnings = []) {
  return {
    diskPct: intSetting('ALERT_DISK_PCT', get('ALERT_DISK_PCT'), 90, 50, 99, warnings),
    ramPct: intSetting('ALERT_RAM_PCT', get('ALERT_RAM_PCT'), 90, 50, 99, warnings),
    tempC: intSetting('ALERT_TEMP_C', get('ALERT_TEMP_C'), 60, 30, 110, warnings),
    hysteresis: intSetting('ALERT_HYSTERESIS', get('ALERT_HYSTERESIS'), 5, 0, 20, warnings),
    offlineAfter: intSetting('ALERT_OFFLINE_AFTER', get('ALERT_OFFLINE_AFTER'), 2, 1, 10, warnings),
  };
}

/**
 * Caminho de arquivo de dados SEMPRE dentro de data/ (CWE-22): um `HISTORY_FILE=../../etc/x`
 * ou um caminho absoluto fora de data/ vira `data/<fallbackBasename>`. `root` é a pasta que
 * contém data/: a de dados (DATA_ROOT), nunca a do código. No modo clone as 2 são a mesma; no
 * modo sistema, um caminho que aponte para o código em /opt também é recusado. A CLI passa a
 * pasta que está examinando.
 */
export function clampPathToData(value, fallbackBasename, root = DATA_ROOT) {
  const p = path.resolve(root, value || '');
  const dataDir = path.join(root, 'data');
  if (p === dataDir || p.startsWith(dataDir + path.sep)) return p;
  return path.join(dataDir, fallbackBasename);
}

// Alvos da coleta, já filtrados pela whitelist.
const sanitizedMounts = sanitizeToken(env('DISK_MOUNTS', '/'));
const sanitizedDevs = sanitizeToken(env('DISK_DEVS', ''));
const sanitizedServices = sanitizeToken(env('SERVICES', ''));
// SMART_DEVS ausente = SMART em todos os DISK_DEVS (V1); presente e vazio = nenhum. Por isso
// esta leitura distingue "ausente" de "vazio" (o env() trataria os dois como padrão).
const rawSmartDevs = process.env.SMART_DEVS ?? fileEnv.SMART_DEVS;
const sanitizedNetIf = sanitizeToken(env('NET_IF', ''));

/**
 * Servidor do SSH (alias do data/ssh/config ou `usuario@host`). Vazio ou começando com `-`
 * vira o valor de exemplo: um `-oProxyCommand=…` nunca chega ao `ssh` como opção (CWE-88).
 * O valor vai ao `ssh` como argumento separado, sem shell (server/collector/index.js).
 */
export function sanitizeHost(value) {
  const v = String(value || '').trim();
  if (!v || v.startsWith('-')) return 'seu-host';
  return v;
}

/**
 * Acesso SSH (ADR 0008). `restrito`: a chave do painel tem `command="…"` no authorized_keys
 * e o painel envia só a palavra do modo; `direto`: o painel envia o script inteiro (V1 e
 * quem ainda não preparou o servidor).
 */
export function sshAccess(value) {
  return String(value || '').trim().toLowerCase() === 'restrito' ? 'restrito' : 'direto';
}

/** Arquivo de configuração SSH próprio (`ssh -F`), sempre dentro de data/; vazio = nenhum. */
export function sshConfigFile(value, root = DATA_ROOT) {
  return String(value || '').trim() ? clampPathToData(String(value).trim(), 'ssh/config', root) : '';
}

/** Avisos de configuração (valores recusados), mostrados no log ao iniciar. */
export const configWarnings = [];

// A configuração ativa. Cada chave é uma variável do .env (nomes, padrões e faixas iguais à
// tabela do AGENTS e ao .env.example; o docs.test.js confere os três).
export const config = {
  SSH_HOST: sanitizeHost(env('SSH_HOST', 'seu-host')),
  SSH_CONFIG: sshConfigFile(env('SSH_CONFIG', '')),
  SSH_ACESSO: sshAccess(env('SSH_ACESSO', '')),
  POLL_INTERVAL: clampInt(env('POLL_INTERVAL', ''), 60000, 10000, 3600000),
  PORT: clampInt(env('PORT', ''), 3000, 1, 65535),
  HISTORY_LIMIT: clampInt(env('HISTORY_LIMIT', ''), 4320, 100, 100000),
  HISTORY_FILE: clampPathToData(env('HISTORY_FILE', ''), 'history.json'),
  LOG_FILE: clampPathToData(env('LOG_FILE', ''), 'dashboard.log'),
  // Uma interface só: se vierem várias, vale a primeira.
  NET_IF: sanitizedNetIf[0] || '',
  // Sem nenhuma pasta válida, acompanha ao menos a raiz.
  DISK_MOUNTS: sanitizedMounts.length ? sanitizedMounts : ['/'],
  DISK_DEVS: sanitizedDevs,
  // null = "siga os DISK_DEVS"; lista (mesmo vazia) = exatamente estes.
  SMART_DEVS: rawSmartDevs === undefined ? null : sanitizeToken(rawSmartDevs),
  SERVICES: sanitizedServices,
  DASH_TOKEN: env('DASH_TOKEN', '').trim(),
  ALERTS: alertThresholds(undefined, configWarnings),
};
