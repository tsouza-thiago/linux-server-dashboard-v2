// Executor fora do serviço (ADR 0031 e 0036): roda o `dashboard atualizar --registro` e o
// `dashboard reconfigurar --pela-tela`. Como filho do painel ele morreria no `stopPanel`: parar o
// serviço mata o grupo inteiro de processos dele. Os 2 comandos são fixos e vão em lista, sem
// shell: nada que vem da tela entra aqui (I11). No pacote .deb (modo sistema), quem roda é o lançador
// do pacote, com as pastas XDG da instalação, como o serviço do painel (ADR 0043 e 0048).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasSystemdUser, unitPath } from '../cli/servico.js';
import { caminhosDoPacote, pastasDe } from '../config.js';

const ATUALIZAR = { unidade: 'server-dashboard-atualizar', comando: ['atualizar', '--registro'] };
const RECONFIGURAR = { unidade: 'server-dashboard-reconfigurar', comando: ['reconfigurar', '--pela-tela'] };
// O systemd-run só cria a unidade e volta: leva milissegundos.
const TETO_MS = 15000;

/** Com o serviço instalado, o comando roda numa unidade própria; sem ele, em segundo plano. */
export function modoDoExecutor({ home = os.homedir(), run } = {}) {
  return fs.existsSync(unitPath(home)) && hasSystemdUser({ run }) ? 'systemd' : 'segundo-plano';
}

// Unidade própria do systemd do usuário, fora do grupo de processos do painel. O systemd de usuário
// não herda o ambiente do painel: no pacote, as pastas XDG vão no pedido, como na unidade do serviço.
function pelaUnidade({ unidade, comando }, dashboard, root, spawnFn, ambiente) {
  return new Promise((resolve) => {
    const filho = spawnFn('systemd-run', ['--user', `--unit=${unidade}`, '--collect', '--quiet', `--working-directory=${root}`, ...ambiente.map((v) => `--setenv=${v}`), dashboard, ...comando], { stdio: 'ignore', timeout: TETO_MS });
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
function foraDoServico(alvo, { root, modo, spawnFn = spawn, pastas = pastasDe(root) }) {
  const sistema = pastas.modo === 'sistema';
  const dashboard = sistema ? caminhosDoPacote(root).lancador : path.join(root, 'dashboard');
  // Valores da configuração desta instalação, nunca da tela.
  const ambiente = sistema ? [`XDG_CONFIG_HOME=${path.dirname(pastas.config)}`, `XDG_DATA_HOME=${path.dirname(pastas.dados)}`] : [];
  return modo === 'systemd' ? pelaUnidade(alvo, dashboard, root, spawnFn, ambiente) : emSegundoPlano(alvo, dashboard, root, spawnFn);
}

/** Dispara a troca de versão. */
export const executarForaDoServico = (opcoes) => foraDoServico(ATUALIZAR, opcoes);

/** Dispara a reconfiguração pela tela: o assistente sobe no lugar do painel. */
export const reconfigurarForaDoServico = (opcoes) => foraDoServico(RECONFIGURAR, opcoes);
