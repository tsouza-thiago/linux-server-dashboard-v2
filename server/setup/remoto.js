// Conexões da instalação com o servidor (fora do regime de 1 SSH por minuto, que vale para
// a coleta): identidade do servidor (ssh-keyscan), alcance da porta e a conexão do
// administrador para detectar (passo 3) e preparar (passo 5).
//
// A senha do administrador nunca vai para disco, log ou linha de comando: o ssh a pede ao
// ajudante scripts/askpass.sh, que a lê de uma variável de ambiente só deste processo; o
// sudo a recebe pelo stdin do script remoto (ver deteccao.js e preparo.js).
//
// Servidor que só aceita chave (ADR 0021): o apelido do ~/.ssh/config é lido com `ssh -G`
// (não conecta) e só os valores dele entram na conexão, sempre com `-F /dev/null`. A
// passphrase da chave fica no ssh-agent: o painel só confere se a chave está carregada.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validHost, validPort, validUser } from './acesso.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Ajudante que entrega a senha ao ssh (lê a variável de ambiente só deste processo). */
export const ASKPASS = path.join(ROOT, 'scripts', 'askpass.sh');
// Ordem de preferência dos tipos de chave do servidor (a 1ª que ele tiver é a mostrada).
const HOST_KEY_ORDER = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'ssh-rsa'];

/** O endereço responde na porta do SSH? (passo 2: "encontrado na rede · respondeu em 3 ms") */
export function probePort(host, port = 22, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!validHost(host) || !validPort(port)) { resolve({ ok: false, reason: 'invalido' }); return; }
    const started = performance.now();
    const sock = net.connect({ host, port: Number(port) });
    const done = (res) => { sock.destroy(); resolve(res); };
    sock.setTimeout(timeoutMs, () => done({ ok: false, reason: 'sem-resposta' }));
    sock.once('connect', () => done({ ok: true, ms: Math.max(1, Math.round(performance.now() - started)) }));
    sock.once('error', (err) => done({
      ok: false,
      reason: err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? 'nome-desconhecido'
        : err.code === 'ECONNREFUSED' ? 'porta-fechada'
          : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' ? 'inalcancavel' : 'erro',
    }));
  });
}

/** HostKeyAlgorithms para o tipo de chave conferido (RSA assina com SHA-2 hoje). */
export function hostKeyAlgorithms(type) {
  return type === 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256,ssh-rsa' : type;
}

/** SHA256:… como o `ssh-keygen -l` mostra (base64 sem "="). */
export function fingerprint(keyB64) {
  return `SHA256:${crypto.createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/** Impressão digital em blocos de 4 letras, para comparar com calma (passo 3). */
export const fingerprintBlocks = (fp) => fp.replace(/^SHA256:/, '').match(/.{1,4}/g) || [];

/**
 * Roda um programa (argumentos em lista, sem shell) com `input` no stdin e teto de tempo;
 * nunca lança: devolve código, saídas e o motivo da falha.
 */
function runProcess(cmd, args, { input = '', env = process.env, timeoutMs = 60000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr, error: err.code === 'ENOENT' ? `${cmd} não encontrado` : err.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Identidade do servidor: chaves públicas pelo ssh-keyscan, a preferida primeiro
 * (Ed25519, a que o `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` mostra).
 */
export async function scanHostKeys(host, port = 22, opts = {}) {
  if (!validHost(host) || !validPort(port)) throw new Error('servidor inválido');
  const r = await runProcess('ssh-keyscan', ['-T', '8', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', '--', host], { timeoutMs: 20000, ...opts });
  if (r.error) throw new Error(r.error);
  const keys = [];
  for (const line of r.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[0].startsWith('#')) continue;
    const [, type, key] = parts;
    // Só chave em base64 de verdade (a saída do keyscan vem da rede: nada cru passa).
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) continue;
    keys.push({ type, key, fingerprint: fingerprint(key) });
  }
  const rank = (t) => { const i = HOST_KEY_ORDER.indexOf(t); return i < 0 ? 99 : i; };
  keys.sort((a, b) => rank(a.type) - rank(b.type));
  return keys;
}

// ---- Apelido do ~/.ssh/config (modo chave) ------------------------------------------------

/** Apelido aceito: o nome de um `Host` comum (nada que o ssh leia como opção). */
export const validAlias = (s) => typeof s === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(s);

/**
 * Caminho de chave ou de agente que pode ir para o ssh: absoluto, sem caractere de controle e
 * sem `%` nem `$` (o ssh expandiria de novo como token ou variável).
 */
export const validKeyPath = (s) => typeof s === 'string' && s.length < 4096 && s.startsWith('/') && !/[\0-\x1f\x7f%$]/.test(s);

/** `~/…` e os tokens %d (pasta pessoal) e %u (usuário local) de um IdentityFile do `ssh -G`. */
function expandIdentity(file, home, localUser) {
  const t = (file.startsWith('~/') ? path.join(home, file.slice(2)) : file).replace(/%d/g, home).replace(/%u/g, localUser);
  // Outro token (%h, %r…): o arquivo depende da conexão; não serve aqui.
  return t.includes('%') ? '' : t;
}

/**
 * Lê o apelido com `ssh -G` (só calcula a configuração, não conecta) e devolve o que a
 * conexão do administrador usa: endereço, porta, usuário, chave e agente. Recusa
 * ProxyJump e ProxyCommand: a coleta conecta direto, então a instalação também.
 * `configFile` só existe para os testes (o ssh lê o ~/.ssh/config da conta, não o $HOME).
 */
export async function resolveAlias(alias, { configFile = '', home = os.homedir(), env = process.env, spawnFn } = {}) {
  if (!validAlias(alias)) return { ok: false, erro: 'Apelido inválido: use o nome de um "Host" do seu ~/.ssh/config (letras, números, ponto, _ e -).' };
  const r = await runProcess('ssh', [...(configFile ? ['-F', configFile] : []), '-G', '--', alias], { timeoutMs: 10000, spawnFn });
  if (r.error) return { ok: false, erro: r.error };
  if (r.code !== 0) return { ok: false, erro: `O ssh não conseguiu ler o apelido ${alias}: ${r.stderr.trim().split('\n').pop() || `código ${r.code}`}` };
  const opts = new Map();
  const files = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^([a-z]+) (.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'identityfile') files.push(m[2]);
    else if (!opts.has(m[1])) opts.set(m[1], m[2]);
  }
  for (const k of ['proxyjump', 'proxycommand']) {
    const v = opts.get(k);
    if (v && v !== 'none') {
      return { ok: false, erro: `O apelido ${alias} usa ${k === 'proxyjump' ? 'ProxyJump' : 'ProxyCommand'} (entra por outra máquina). O painel conecta direto ao servidor: use um apelido sem salto, com o endereço do próprio servidor.` };
    }
  }
  const host = opts.get('hostname') || '';
  const port = Number(opts.get('port') || 22);
  const user = opts.get('user') || '';
  if (!validHost(host)) return { ok: false, erro: `O apelido ${alias} não tem um HostName válido (achei "${host.slice(0, 80)}").` };
  if (!validPort(port)) return { ok: false, erro: `O apelido ${alias} tem uma porta inválida.` };
  if (!validUser(user)) return { ok: false, erro: `O apelido ${alias} não tem um User válido.` };
  // A 1ª chave que existe, na ordem do ssh (sem IdentityFile, o ssh -G lista as padrão).
  const localUser = os.userInfo().username;
  const identityFile = files.map((f) => expandIdentity(f, home, localUser)).find((f) => validKeyPath(f) && fs.existsSync(f)) || '';
  if (!identityFile) return { ok: false, erro: `Não achei a chave do apelido ${alias} neste computador. Confira o IdentityFile dele no ~/.ssh/config.` };
  // Agente: o IdentityAgent do apelido; sem ele, o SSH_AUTH_SOCK deste terminal.
  const raw = opts.get('identityagent') || 'SSH_AUTH_SOCK';
  let identityAgent = raw === 'none' ? 'none' : raw === 'SSH_AUTH_SOCK' ? env.SSH_AUTH_SOCK || '' : raw.startsWith('$') ? env[raw.slice(1)] || '' : raw;
  if (identityAgent !== 'none' && !validKeyPath(identityAgent)) identityAgent = '';
  return { ok: true, alias, host, port, user, identityFile, identityAgent: identityAgent || 'none' };
}

/** "ssh-ed25519 AAAA…" sem o comentário (o que o agente lista e o authorized_keys usa). */
const keyBlob = (line) => String(line).trim().split(/\s+/)[1] || '';

/**
 * A chave do apelido está pronta para uma conexão sem perguntas? Ou ela está no agente
 * (`ssh-add -L` traz o mesmo .pub), ou ela não tem passphrase. O painel nunca recebe a
 * passphrase: se faltar, a tela mostra o `ssh-add` para a pessoa rodar no terminal dela.
 * Resposta: { ok, via: 'agente'|'sem-passphrase' } ou { ok: false, motivo, comando }.
 */
export async function checkAgentKey({ identityFile, identityAgent = 'none', home = os.homedir(), spawnFn } = {}) {
  if (!validKeyPath(identityFile)) return { ok: false, motivo: 'chave-invalida' };
  const shown = identityFile.startsWith(`${home}/`) ? `~/${identityFile.slice(home.length + 1)}` : identityFile;
  const comando = `ssh-add -t 15m ${shown}`;
  // Sem passphrase, o ssh-keygen tira a parte pública com a passphrase vazia.
  const plain = await runProcess('ssh-keygen', ['-y', '-P', '', '-f', identityFile], { timeoutMs: 10000, spawnFn });
  if (plain.code === 0 && keyBlob(plain.stdout)) return { ok: true, via: 'sem-passphrase' };
  let pub = '';
  try { pub = keyBlob(fs.readFileSync(`${identityFile}.pub`, 'utf8')); } catch { /* sem .pub */ }
  if (!pub) return { ok: false, motivo: 'sem-pub', comando: `ssh-keygen -y -f ${shown} > ${shown}.pub` };
  if (identityAgent === 'none' || !validKeyPath(identityAgent)) return { ok: false, motivo: 'sem-agente', comando };
  const env = { ...process.env, SSH_AUTH_SOCK: identityAgent };
  const r = await runProcess('ssh-add', ['-L'], { env, timeoutMs: 10000, spawnFn });
  // Código 2: não achou o agente; 1: o agente está vazio.
  if (r.error || r.code === 2) return { ok: false, motivo: 'sem-agente', comando };
  if (r.code === 0 && r.stdout.split('\n').some((l) => keyBlob(l) === pub)) return { ok: true, via: 'agente' };
  return { ok: false, motivo: 'falta', comando };
}

/**
 * Executa um script no servidor como o administrador (`/bin/sh -s`, script no stdin).
 * Com senha, autentica só por senha (via askpass). Com `identityFile` (apelido do modo
 * chave), só aquela chave, pelo agente do apelido. Sem nenhum dos dois, as chaves de
 * sempre da pessoa (~/.ssh/id_*, agente). Sempre em modo não interativo quando não há
 * senha, com a identidade conferida no known_hosts do painel (StrictHostKeyChecking yes)
 * e nenhum ~/.ssh/config lido (-F /dev/null).
 */
export function runAdmin({ host, port = 22, user, password = '', identityFile = '', identityAgent = 'none', knownHosts, hostKeyType, script, timeoutMs = 120000, spawnFn }) {
  if (!validHost(host) || !validPort(port) || !validUser(user)) throw new Error('servidor ou usuário inválido');
  if (identityFile && (!validKeyPath(identityFile) || (identityAgent !== 'none' && !validKeyPath(identityAgent)))) throw new Error('chave ou agente inválido');
  const args = [
    '-F', '/dev/null',
    '-p', String(port),
    '-l', user,
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=yes',
    ...(hostKeyType ? ['-o', `HostKeyAlgorithms=${hostKeyAlgorithms(hostKeyType)}`] : []),
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'LogLevel=ERROR',
    ...(password
      ? ['-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password']
      : ['-o', 'BatchMode=yes']),
    // Só a chave do apelido: o agente não oferece as outras (MaxAuthTries, fail2ban).
    ...(identityFile && !password
      ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes', '-o', `IdentityAgent=${identityAgent}`, '-o', 'PreferredAuthentications=publickey']
      : []),
    '-T', '--', host, '/bin/sh -s',
  ];
  // Ambiente limpo: nenhum askpass de fora; a senha só entra por esta variável, só neste
  // processo do ssh (nunca na linha de comando, que outros usuários veem no `ps`).
  const env = { ...process.env };
  delete env.SSH_ASKPASS;
  delete env.DASHBOARD_SENHA_SSH;
  if (password) Object.assign(env, { SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: 'force', DASHBOARD_SENHA_SSH: password });
  return runProcess('ssh', args, { input: script, env, timeoutMs, spawnFn });
}

/** Erro da conexão do administrador em português simples. */
export function describeAdminError({ code, stderr = '', timedOut, error }) {
  if (error) return error;
  if (timedOut) return 'o servidor parou de responder no meio da conexão';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* not in list/i.test(stderr)) {
    return 'a identidade do servidor não é a que você confirmou: pare e confira (pode ser outro aparelho no mesmo endereço)';
  }
  if (/must have a tty|requiretty/i.test(stderr)) return 'o sudo do servidor exige um terminal (Defaults requiretty): use o modo "Prefiro fazer à mão"';
  if (/Permission denied \(publickey\)/i.test(stderr)) return 'o servidor recusou a chave: confira o usuário e se a chave está no ssh-agent';
  if (/Permission denied/i.test(stderr)) return 'o servidor recusou a entrada: confira o usuário e a senha';
  if (/Connection refused/i.test(stderr)) return 'a porta do SSH está fechada no servidor';
  if (/timed out|No route to host|Network is unreachable/i.test(stderr)) return 'o servidor não respondeu (está ligado e na mesma rede?)';
  if (/Could not resolve hostname/i.test(stderr)) return 'esse nome não foi encontrado na rede';
  if (code === 255) return `a conexão SSH falhou: ${stderr.trim().split('\n').pop() || 'sem detalhes'}`;
  return `o comando no servidor falhou (código ${code})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`;
}
