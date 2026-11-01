// Executor fora do serviço (ADR 0031 e 0036): roda o `dashboard atualizar --registro` e o
// `dashboard reconfigurar --pela-tela`. Como filho do painel ele morreria no `stopPanel`: parar o
// serviço mata o grupo inteiro de processos dele. Os 2 comandos são fixos e vão em lista, sem
// shell: nada que vem da tela entra aqui (I11).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasSystemdUser, unitPath } from '../cli/servico.js';

const ATUALIZAR = { unidade: 'server-dashboard-atualizar', comando: ['atualizar', '--registro'] };
const RECONFIGURAR = { unidade: 'server-dashboard-reconfigurar', comando: ['reconfigurar', '--pela-tela'] };
// O systemd-run só cria a unidade e volta: leva milissegundos.
const TETO_MS = 15000;

/** Com o serviço instalado, o comando roda numa unidade própria; sem ele, em segundo plano. */
export function modoDoExecutor({ home = os.homedir(), run } = {}) {
  return fs.existsSync(unitPath(home)) && hasSystemdUser({ run }) ? 'systemd' : 'segundo-plano';
}

// Unidade própria do systemd do usuário, fora do grupo de processos do painel.
function pelaUnidade({ unidade, comando }, dashboard, root, spawnFn) {
  return new Promise((resolve) => {
    const filho = spawnFn('systemd-run', ['--user', `--unit=${unidade}`, '--collect', '--quiet', `--working-directory=${root}`, dashboard, ...comando], { stdio: 'ignore', timeout: TETO_MS });
    filho.on('error', () => resolve({ ok: false }));
    filho.on('close', (codigo) => resolve({ ok: codigo === 0 }));
  });
}

// `detached` faz o setsid do processo: sessão própria, que não some com o painel.
function emSegundoPlano({ comando }, dashboard, root, spawnFn) {
  return new Promise((resolve) => {
    const filho = spawnFn(dashboard, comando, { cwd: root, detached: true, stdio: 'ignore' });
    filho.on('error', () => resolve({ ok: false }));
    filho.on('spawn', () => { filho.unref(); resolve({ ok: true }); });
  });
}

/**
 * Dispara o comando e volta logo. Sem plano B do systemd para o segundo plano: dentro do serviço,
 * um processo solto morreria no `stopPanel`, com o painel já parado.
 */
function foraDoServico(alvo, { root, modo, spawnFn = spawn }) {
  const dashboard = path.join(root, 'dashboard');
  return modo === 'systemd' ? pelaUnidade(alvo, dashboard, root, spawnFn) : emSegundoPlano(alvo, dashboard, root, spawnFn);
}

/** Dispara a troca de versão. */
export const executarForaDoServico = (opcoes) => foraDoServico(ATUALIZAR, opcoes);

/** Dispara a reconfiguração pela tela: o assistente sobe no lugar do painel. */
export const reconfigurarForaDoServico = (opcoes) => foraDoServico(RECONFIGURAR, opcoes);
