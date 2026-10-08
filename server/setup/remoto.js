// Conexões da instalação com o servidor (fora do regime de 1 SSH por minuto, que vale para
// a coleta): identidade do servidor (ssh-keyscan), alcance da porta e a conexão do
// administrador para detectar (passo 3) e preparar (passo 5).
//
// A senha do administrador nunca vai para disco, log ou linha de comando: o ssh a pede ao
// ajudante scripts/askpass.sh, que a lê de uma variável de ambiente só deste processo; o
// sudo a recebe pelo stdin do script remoto (ver deteccao.js e preparo.js).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validHost, validPort, validUser } from './acesso.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ASKPASS = path.join(ROOT, 'scripts', 'askpass.sh');
export const HOST_KEY_ORDER = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'ssh-rsa'];

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
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) continue;
    keys.push({ type, key, fingerprint: fingerprint(key) });
  }
  const rank = (t) => { const i = HOST_KEY_ORDER.indexOf(t); return i < 0 ? 99 : i; };
  keys.sort((a, b) => rank(a.type) - rank(b.type));
  return keys;
}

/**
 * Executa um script no servidor como o administrador (`/bin/sh -s`, script no stdin).
 * Com senha, autentica só por senha (via askpass); sem senha, usa as chaves de sempre da
 * pessoa (~/.ssh/id_*, agente) em modo não interativo. Identidade conferida no
 * known_hosts do painel (StrictHostKeyChecking yes) e nenhum ~/.ssh/config lido (-F /dev/null).
 */
export function runAdmin({ host, port = 22, user, password = '', knownHosts, hostKeyType, script, timeoutMs = 120000, spawnFn }) {
  if (!validHost(host) || !validPort(port) || !validUser(user)) throw new Error('servidor ou usuário inválido');
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
    '-T', '--', host, '/bin/sh -s',
  ];
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
  if (/Permission denied/i.test(stderr)) return 'o servidor recusou a entrada: confira o usuário e a senha';
  if (/Connection refused/i.test(stderr)) return 'a porta do SSH está fechada no servidor';
  if (/timed out|No route to host|Network is unreachable/i.test(stderr)) return 'o servidor não respondeu (está ligado e na mesma rede?)';
  if (/Could not resolve hostname/i.test(stderr)) return 'esse nome não foi encontrado na rede';
  if (code === 255) return `a conexão SSH falhou: ${stderr.trim().split('\n').pop() || 'sem detalhes'}`;
  return `o comando no servidor falhou (código ${code})${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`;
}
