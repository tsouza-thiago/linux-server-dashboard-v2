// `dashboard diagnosticar` (prancheta "Instalação · 1 comando no terminal"): testa Node,
// permissões, SSH, chave restrita, sudo e coleta, e explica cada falha em português
// simples ("O que aconteceu / Como resolver"). Com o painel coletando, usa a última
// amostra gravada em vez de abrir outra conexão (I1); só testa ao vivo se ela estiver velha.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampInt, loadEnvFile, isPlaceholderHost, sanitizeToken } from '../config.js';
import { listDays, readNdjson } from '../storage/ndjson.js';
import { collect, runSSH } from '../collector/index.js';
import { normalizeTargets } from '../collector/builder.js';
import { panelStatus } from './servico.js';

const ago = (ms) => (ms < 90e3 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : `${Math.round(ms / 3600e3)} h`);
const comma = (n, d = 1) => n.toFixed(d).replace('.', ',');

/** Última amostra gravada em data/history/ (ou null). */
export function latestSample(root) {
  const dir = path.join(root, 'data', 'history');
  const days = listDays(dir);
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const { items } = readNdjson(path.join(dir, `${days[i]}.ndjson`));
    if (items.length) return items.at(-1);
  }
  return null;
}

function mode(file) {
  try { return fs.statSync(file).mode & 0o777; } catch { return null; }
}

/** Arquivos que precisam ser só do dono, com a permissão esperada. */
export function permissionProblems(root, keyFile) {
  const want = [
    [path.join(root, '.env'), 0o600], [path.join(root, 'data'), 0o700], [path.join(root, 'data', 'ssh'), 0o700],
    [path.join(root, 'data', 'ssh', 'config'), 0o600], [path.join(root, 'data', 'ssh', 'known_hosts'), 0o600],
    ...(keyFile ? [[keyFile, 0o600]] : []),
  ];
  return want.filter(([f, m]) => { const got = mode(f); return got !== null && (got & 0o077) !== 0 && got !== m; })
    .map(([f, m]) => ({ file: f, want: m.toString(8), got: mode(f).toString(8) }));
}

export function keyFileFromConfig(root) {
  try {
    const m = /^\s*IdentityFile\s+"?([^"\n]+)"?/m.exec(fs.readFileSync(path.join(root, 'data', 'ssh', 'config'), 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Alvos do .env desta pasta (os mesmos que o painel usa). */
function envTargets(env) {
  return normalizeTargets({
    netIf: sanitizeToken(env.NET_IF || '')[0] || '',
    mounts: sanitizeToken(env.DISK_MOUNTS || '/'),
    devs: sanitizeToken(env.DISK_DEVS || ''),
    smartDevs: env.SMART_DEVS === undefined ? undefined : sanitizeToken(env.SMART_DEVS),
    services: sanitizeToken(env.SERVICES || ''),
  });
}

/** Explicação de uma coleta que falhou. */
export function explainFailure(error) {
  if (/identidade do servidor/i.test(error)) {
    return ['a identidade do servidor mudou ou não é a que você confirmou na instalação.', 'se você reinstalou o servidor, rode dashboard reconfigurar e confira a nova identidade. Se não, pare: pode ser outro aparelho no mesmo endereço.'];
  }
  if (/timeout|não respondeu/i.test(error)) return ['o servidor não respondeu a tempo.', 'confira se ele está ligado e na mesma rede; o painel tenta de novo sozinho a cada minuto.'];
  if (/exit 255|recusou|Permission denied/i.test(error)) {
    return ['o servidor recusou a chave do painel.', 'rode dashboard reconfigurar: a linha da chave pode ter sumido do servidor, ou o endereço deste computador mudou (opção "só deste computador").'];
  }
  return [error, 'rode dashboard reconfigurar; se continuar, veja data/dashboard.log.'];
}

export async function diagnosticar({ out, root, home = os.homedir(), deps = {} }) {
  const now = deps.now ?? Date.now();
  let warns = 0;
  let errors = 0;
  const warn = (t, d) => { warns += 1; out.warn(t, d); };
  const fail = (t, d) => { errors += 1; out.fail(t, d); };
  out.title('Server Dashboard · diagnóstico');

  const env = loadEnvFile(path.join(root, '.env'));
  if (!env.SSH_HOST || isPlaceholderHost(env.SSH_HOST)) {
    fail('ainda não instalado');
    out.explain('não há servidor configurado nesta pasta.', 'rode ./dashboard instalar.');
    out.line(out.c.bold(`Resultado: ${warns} aviso(s), ${errors} erro(s).`));
    return 1;
  }

  const st = (deps.panelStatus ?? panelStatus)({ root, home });
  if (st.running) out.ok('painel rodando', st.mode === 'servico' ? `serviço de usuário${st.enabled ? ', inicia com o computador' : ''}` : `segundo plano, PID ${st.pid}`);
  else {
    warn('painel parado');
    out.explain('', 'inicie com ./dashboard iniciar (ou abra pelo atalho "Server Dashboard").');
  }

  const keyFile = keyFileFromConfig(root);
  const perms = permissionProblems(root, keyFile);
  if (!perms.length) out.ok('permissões dos arquivos corretas', '700 / 600');
  else {
    fail('arquivos com permissão aberta demais', perms.map((p) => `${path.relative(root, p.file) || p.file} ${p.got}`).join(', '));
    out.explain('outros usuários desta máquina poderiam ler a configuração ou a chave.', `rode: ${perms.map((p) => `chmod ${p.want} "${p.file}"`).join('; ')}`);
  }

  const restricted = env.SSH_ACESSO === 'restrito' && fs.existsSync(path.join(root, 'data', 'ssh', 'config'));
  if (!restricted) {
    warn('acesso direto ao servidor (como na V1)');
    out.explain('a chave usada pelo painel pode rodar qualquer comando no servidor.', 'rode dashboard reconfigurar para trocar por um usuário próprio com chave restrita à coleta.');
  }
  if (restricted && keyFile && !fs.existsSync(keyFile)) {
    fail('a chave do painel sumiu', keyFile);
    out.explain('o arquivo da chave foi apagado ou movido.', 'rode dashboard reconfigurar para criar outra.');
  }

  const interval = clampInt(env.POLL_INTERVAL, 60000, 10000, 3600000);
  let sample = latestSample(root);
  let live = false;
  if (!sample || now - Date.parse(sample.ts) > 3 * interval) {
    live = true;
    const configFile = restricted ? path.join(root, 'data', 'ssh', 'config') : '';
    const res = await (deps.collect ?? collect)({
      host: env.SSH_HOST, targets: envTargets(env), access: restricted ? 'restrito' : 'direto',
      runner: deps.runner ?? ((h, c) => runSSH(h, c, 30000, { configFile })), now,
    });
    if (!res.ok) {
      fail('o servidor não respondeu à coleta de teste', res.error);
      out.explain(...explainFailure(res.error));
      out.line(out.c.bold(`Resultado: ${warns} aviso(s), ${errors} erro(s).`));
      return 1;
    }
    sample = res.sample;
  }
  out.ok('servidor responde · identidade confere', live ? 'coleta de teste agora' : 'pela última coleta do painel');
  const c = sample.collector || {};
  if (restricted && c.hashMismatch) {
    warn('a linha da chave no servidor está desatualizada');
    out.explain('o .env mudou (outro disco, outra pasta ou serviço) depois que o servidor foi preparado; o painel continua coletando o que a linha antiga permite.', 'rode dashboard reconfigurar e confirme o passo "Preparar o servidor".');
  } else if (restricted) out.ok('chave restrita ao comando de coleta · em dia');

  for (const s of sample.smart || []) {
    if (s.status === 'SEM_PERMISSAO') {
      warn(`SMART de /dev/${s.dev} sem permissão`);
      out.explain(`o servidor ainda não libera o teste de saúde do disco ${s.dev} (ele pode ter sido adicionado depois da instalação).`, `rode dashboard reconfigurar e marque ${s.dev} no passo "O que monitorar".`);
    } else if (s.status === 'SEM_SMARTCTL') {
      warn('o smartctl não está instalado no servidor');
      out.explain('sem ele não dá para testar a saúde dos discos (o painel não instala nada no servidor).', 'se quiser o teste, instale no servidor: sudo apt install smartmontools; depois rode dashboard reconfigurar.');
    } else if (s.status === 'FAILED') {
      fail(`o disco /dev/${s.dev} reprovou no teste de saúde (SMART)`);
      out.explain('o próprio disco avisa que pode falhar em breve.', 'faça cópia de segurança do que estiver nele e planeje a troca.');
    }
  }

  const age = now - Date.parse(sample.ts);
  const parts = [`há ${ago(Math.max(0, age))}`];
  if (Number.isFinite(c.durationMs)) parts.push(`${comma(c.durationMs / 1000, 2)} s`);
  if (Number.isFinite(c.outputBytes)) parts.push(`${comma(c.outputBytes / 1024)} KB`);
  out.ok(`${live ? 'coleta de teste' : 'última coleta'} ${parts.join(' · ')}`);
  out.line();
  out.line(out.c.bold(`Resultado: ${warns ? `${warns} aviso${warns > 1 ? 's' : ''}` : 'nenhum aviso'}, ${errors ? `${errors} erro${errors > 1 ? 's' : ''}` : 'nenhum erro'}.`));
  return errors ? 1 : 0;
}
