// Instalação com servidor, ssh e systemd falsos, para os testes do orquestrador, do
// assistente pela rede e do e2e no Chromium (nada sai desta máquina).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Instalacao } from '../server/setup/instalacao.js';
import { parseOutput } from '../server/collector/parser.js';
import { targetsHash } from '../server/collector/builder.js';

// Detecção de um Debian 12 (fixture anônima) e uma chave pública de exemplo do servidor.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = fs.readFileSync(path.join(HERE, '..', 'test', 'fixtures', 'instalacao', 'deteccao-debian12.txt'), 'utf8');
const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAICLXaq8Zb0WG4QWeKtFRHjyahVNxZFkczJ5it2xMlpU2';

/** A detecção do servidor de exemplo com outro estado do sudo (pede-senha, requiretty…). */
export const detectionWithSudo = (state) => FIXTURE.replace(/^===SUDO===\nsenha$/m, `===SUDO===\n${state}`);

/** Apelido falso do ~/.ssh/config (modo chave): o que o `ssh -G` devolveria já lido. */
export const ALIAS = {
  ok: true, alias: 'meu-servidor', host: '192.0.2.10', port: 2222, user: 'maria',
  identityFile: '/home/maria/.ssh/chave_admin', identityAgent: '/run/user/1000/agente.sock',
};

/**
 * Servidor falso: responde à detecção, ao preparo e às coletas. `sshd` é a saída da
 * conferência do sshd no preparo (linhas @@sshd); `sudoPassword` é a senha que o sudo aceita.
 */
function fakeServer({ sudoOk = true, smartPerm = true, detection = FIXTURE, sshd = '@@sshd pubkeyauthentication yes\n@@sshd fim\n', sudoPassword = 'certa' } = {}) {
  const calls = [];
  const srv = {
    calls,
    // Conexão do administrador: senha "certa" passa; detecção, conferência e preparo. Com a
    // chave do apelido, só passa se ela estiver "no agente".
    async runAdmin(opts) {
      calls.push({ kind: 'admin', password: opts.password, identityFile: opts.identityFile, identityAgent: opts.identityAgent, script: opts.script });
      if (opts.password && opts.password !== 'certa') return { code: 255, stdout: '', stderr: 'Permission denied (password).' };
      if (opts.identityFile && !srv.agentHasKey) return { code: 255, stdout: '', stderr: 'maria@192.0.2.10: Permission denied (publickey).' };
      if (opts.script.includes('===WHO===')) return { code: 0, stdout: detection, stderr: '' };
      if (opts.script.includes("id -u dashmon >/dev/null 2>&1 && echo '@@ok usuario'")) return { code: 0, stdout: srv.dashmon ? '@@ok usuario\n/bin/sh\n' : '', stderr: '' };
      // A senha do sudo vai no script (P='…'), nunca na conexão.
      const sudoPass = (/^P='([^']*)'$/m.exec(opts.script) || [])[1];
      if (!sudoOk || (sudoPass !== undefined && sudoPass !== sudoPassword)) return { code: 9, stdout: '@@erro senha\n', stderr: '' };
      srv.dashmon = true;
      srv.prepared = opts.script;
      return { code: 0, stdout: `${sshd}@@ok sshd\n@@ok usuario\n@@ok chave\n@@ok sudoers\n`, stderr: '' };
    },
    agentHasKey: true,
    // checkAgentKey falso: o agente tem a chave ou não (a tela mostra o ssh-add).
    async checkAgentKey({ identityFile }) {
      calls.push({ kind: 'agente', identityFile });
      return srv.agentHasKey ? { ok: true, via: 'agente' } : { ok: false, motivo: 'falta', comando: 'ssh-add -t 15m ~/.ssh/chave_admin' };
    },
    // resolveAlias falso: o apelido de exemplo, um com ProxyJump e o resto desconhecido.
    async resolveAlias(alias) {
      calls.push({ kind: 'apelido', alias });
      if (alias === 'meu-servidor') return ALIAS;
      if (alias === 'com-salto') return { ok: false, erro: 'O apelido com-salto usa ProxyJump (entra por outra máquina).' };
      return { ok: false, erro: `Não achei a chave do apelido ${alias} neste computador.` };
    },
    // Coleta de teste: só depois do preparo; monta uma saída mínima com o hash dos alvos.
    async collect({ targets, access, runner }) {
      calls.push({ kind: 'collect', targets, access, runner });
      if (!srv.dashmon) return { ok: false, error: 'SSH falhou (exit 255) — host não encontrado ou chave inválida' };
      const smart = targets.smartDevs.map((d) => `${d} ${smartPerm ? 'PASSED' : 'SEM_PERMISSAO'}`).join('\n');
      const out = [
        '===VER===', `2 ${targetsHash(targets)}`, targets.smartDevs.length ? 'smart' : 'basico', '===HOST===', 'servidor-casa',
        '===MEM===', 'MemTotal: 8000000 kB', 'MemFree: 1000000 kB', 'MemAvailable: 2320000 kB',
        '===DF===', 'Filesystem 1B-blocks Used Avail Use% IUse% Mounted', '/dev/sdb1 /mnt/dados 100 64 36 64% 1%',
        ...(targets.smartDevs.length ? ['===SMART===', smart] : []),
        '===SERVICES===', ...targets.services.map((s) => `${s} active`), '===FIM===',
      ].join('\n');
      const sample = parseOutput(out, new Date().toISOString(), { targets });
      sample.collector.hashMismatch = sample.collector.hash !== targetsHash(targets);
      sample.collector.durationMs = 910;
      sample.collector.outputBytes = 6200;
      return { ok: true, sample };
    },
  };
  return srv;
}


/**
 * Instalação pronta para teste: pastas temporárias de projeto e de home, servidor falso,
 * systemd falso. Devolve { inst, srv, root, home, services, cleanup }.
 */
export function makeInstalacao(serverOpts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-inst-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-inst-home-'));
  const cleanup = () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); };
  fs.writeFileSync(path.join(root, '.env.example'), 'SSH_HOST=seu_host\nPORT=3999\nDASH_TOKEN=\n');
  const srv = fakeServer(serverOpts);
  const services = [];
  const inst = new Instalacao({
    root,
    home,
    deps: {
      probePort: async (host) => (host === '192.0.2.99' ? { ok: false, reason: 'sem-resposta' } : { ok: true, ms: 3 }),
      scanHostKeys: async () => [{ type: 'ssh-ed25519', key: ED, fingerprint: 'SHA256:8oOm2IqGGSLMQ94IC6SBJJ/EIGqCSF6BhAsYUkBWlXw' }],
      runAdmin: srv.runAdmin,
      resolveAlias: srv.resolveAlias,
      checkAgentKey: srv.checkAgentKey,
      collect: srv.collect,
      hasSystemdUser: () => serverOpts.systemd ?? true,
      installService: async (o) => { services.push(o); return { ok: true, hardening: true }; },
      startPanel: async () => ({ ok: true }),
      versionStatus: () => ({ ok: true, tag: 'v2.0.0-alpha.8' }),
    },
  });
  return { inst, srv, root, home, services, cleanup };
}
