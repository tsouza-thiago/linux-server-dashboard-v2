// Executor da troca de versão (ADR 0031): roda o `dashboard atualizar --registro` fora do serviço.
// Como filho do painel ele morreria no `stopPanel`: parar o serviço mata o grupo inteiro de
// processos dele. O comando é fixo e vai em lista, sem shell: nada que vem da tela entra aqui (I11).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasSystemdUser, unitPath } from '../cli/servico.js';

const UNIDADE = 'server-dashboard-atualizar';
const COMANDO = ['atualizar', '--registro'];
// O systemd-run só cria a unidade e volta: leva milissegundos.
const TETO_MS = 15000;

/** Com o serviço instalado, a troca roda numa unidade própria; sem ele, em segundo plano. */
export function modoDoExecutor({ home = os.homedir(), run } = {}) {
  return fs.existsSync(unitPath(home)) && hasSystemdUser({ run }) ? 'systemd' : 'segundo-plano';
}

// Unidade própria do systemd do usuário, fora do grupo de processos do painel.
function pelaUnidade(dashboard, root, spawnFn) {
  return new Promise((resolve) => {
    const filho = spawnFn('systemd-run', ['--user', `--unit=${UNIDADE}`, '--collect', '--quiet', `--working-directory=${root}`, dashboard, ...COMANDO], { stdio: 'ignore', timeout: TETO_MS });
    filho.on('error', () => resolve({ ok: false }));
    filho.on('close', (codigo) => resolve({ ok: codigo === 0 }));
  });
}

// `detached` faz o setsid do processo: sessão própria, que não some com o painel.
function emSegundoPlano(dashboard, root, spawnFn) {
  return new Promise((resolve) => {
    const filho = spawnFn(dashboard, COMANDO, { cwd: root, detached: true, stdio: 'ignore' });
    filho.on('error', () => resolve({ ok: false }));
    filho.on('spawn', () => { filho.unref(); resolve({ ok: true }); });
  });
}

/**
 * Dispara a troca de versão e volta logo. Sem plano B do systemd para o segundo plano: dentro do
 * serviço, um processo solto morreria no `stopPanel`, com o painel já parado.
 */
export function executarForaDoServico({ root, modo, spawnFn = spawn }) {
  const dashboard = path.join(root, 'dashboard');
  return modo === 'systemd' ? pelaUnidade(dashboard, root, spawnFn) : emSegundoPlano(dashboard, root, spawnFn);
}
