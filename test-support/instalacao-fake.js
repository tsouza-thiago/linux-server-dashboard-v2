// Instalação com servidor, ssh e systemd falsos, para os testes do orquestrador, do
// assistente pela rede e do e2e no Chromium (nada sai desta máquina).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Instalacao } from '../server/setup/instalacao.js';
import { parseOutput } from '../server/collector/parser.js';
import { targetsHash } from '../server/collector/builder.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = fs.readFileSync(path.join(HERE, '..', 'test', 'fixtures', 'instalacao', 'deteccao-debian12.txt'), 'utf8');
const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAICLXaq8Zb0WG4QWeKtFRHjyahVNxZFkczJ5it2xMlpU2';

/** Servidor falso: responde à detecção, ao preparo e às coletas. */
export function fakeServer({ sudoOk = true, smartPerm = true, detection = FIXTURE } = {}) {
  const calls = [];
  const srv = {
    calls,
    async runAdmin(opts) {
      calls.push({ kind: 'admin', password: opts.password, script: opts.script });
      if (opts.password && opts.password !== 'certa') return { code: 255, stdout: '', stderr: 'Permission denied (password).' };
      if (opts.script.includes('===WHO===')) return { code: 0, stdout: detection, stderr: '' };
      if (opts.script.includes("id -u dashmon >/dev/null 2>&1 && echo '@@ok usuario'")) return { code: 0, stdout: srv.dashmon ? '@@ok usuario\n/bin/sh\n' : '', stderr: '' };
      if (!sudoOk) return { code: 9, stdout: '@@erro senha\n', stderr: '' };
      srv.dashmon = true;
      srv.prepared = opts.script;
      return { code: 0, stdout: '@@ok usuario\n@@ok chave\n@@ok sudoers\n', stderr: '' };
    },
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
      collect: srv.collect,
      hasSystemdUser: () => serverOpts.systemd ?? true,
      installService: async (o) => { services.push(o); return { ok: true, hardening: true }; },
      startPanel: async () => ({ ok: true }),
      versionStatus: () => ({ ok: true, tag: 'v2.0.0-alpha.8' }),
    },
  });
  return { inst, srv, root, home, services, cleanup };
}
