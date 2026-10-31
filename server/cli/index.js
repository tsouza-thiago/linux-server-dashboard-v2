#!/usr/bin/env node
// CLI do comando `dashboard` (ADR 0011). O ./dashboard (bash) garante o Node 24 e chama
// este arquivo; aqui ficam os subcomandos, todos em português e sem sudo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, isPlaceholderHost, loadEnvFile } from '../config.js';
import { createLoginCode } from '../http/entrar.js';
import { makeOutput } from './saida.js';
import { openBrowser, panelStatus, startPanel, stopPanel } from './servico.js';
import { instalar } from './instalar.js';
import { diagnosticar } from './diagnosticar.js';
import { atualizar } from './atualizar.js';
import { desinstalar } from './desinstalar.js';

// Texto de `./dashboard ajuda` (as opções citadas aqui são conferidas pelo docs.test.js).
const HELP = `Uso: ./dashboard <comando>

  instalar        primeira instalação (abre o assistente no navegador)
                    --terminal       os mesmos passos no terminal (máquina sem tela)
                    --sem-interface  sem perguntas, por opções (veja --sem-interface --ajuda)
                    --importar-v1 <pasta>  traz configuração e histórico da V1 (e para a V1)
                    --pre            aceita pré-versão (rc); sem ela, fica na estável
                    --sem-link       não cria o comando dashboard (~/.local/bin/dashboard)
  abrir           abre o painel no navegador, já logado
  iniciar         inicia o painel (serviço de usuário ou segundo plano)
  parar           para o painel
  status          mostra se o painel está rodando
  diagnosticar    testa tudo e explica cada problema em português simples
  reconfigurar    reabre o assistente (trocar servidor, discos, serviços)
  atualizar       baixa a versão assinada mais nova, com backup e volta atrás se falhar
                    --pre            aceita pré-versão (rc) mesmo estando na estável
  desinstalar     remove serviço, atalho, comando e arquivos locais (e ajuda a limpar o servidor)
  versao          mostra a versão
  ajuda           esta ajuda
`;

// A ajuda cita o comando do jeito que ele roda agora.
const help = (out) => HELP.replaceAll('./dashboard', out.cmd);

/** Versão do package.json da pasta `root` ("?" se ilegível). */
function version(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return '?'; }
}

/** Instalação feita? (.env com SSH_HOST de verdade) */
export function isConfigured(root) {
  const env = loadEnvFile(path.join(root, '.env'));
  return Boolean(env.SSH_HOST) && !isPlaceholderHost(env.SSH_HOST);
}

/** Endereço para abrir o painel: com DASH_TOKEN, um link de entrada de uso único. */
export function panelUrl(root, port) {
  const env = loadEnvFile(path.join(root, '.env'));
  const base = `http://127.0.0.1:${port}`;
  if (!env.DASH_TOKEN) return { url: `${base}/`, oneTime: false };
  const code = createLoginCode(path.join(root, 'data'));
  return { url: `${base}/entrar?codigo=${code}`, oneTime: true };
}

// Os subcomandos: cada um recebe { out, root, home, args } e devolve o código de saída
// (0 ok, 1 falha, 2 uso errado, 3 painel parado no `status`).
const COMMANDS = {
  instalar: (ctx) => instalar(ctx),
  reconfigurar: (ctx) => instalar({ ...ctx, reconfigurar: true }),
  diagnosticar: (ctx) => diagnosticar(ctx),
  atualizar: (ctx) => atualizar(ctx),
  desinstalar: (ctx) => desinstalar(ctx),
  async ajuda({ out }) { out.line(help(out)); return 0; },
  async versao({ out, root }) { out.line(`Server Dashboard ${version(root)}`); return 0; },

  async status({ out, root, home }) {
    const st = panelStatus({ root, home });
    // Com 2 pastas na máquina, o comando no PATH vale para só uma: diz qual respondeu.
    out.line(out.c.dim(`pasta: ${root}`));
    if (!isConfigured(root)) out.warn('ainda não instalado', `rode ${out.cmd} instalar`);
    if (st.running) {
      const how = st.mode === 'servico'
        ? `serviço de usuário${st.enabled ? ', inicia com o computador' : ''}`
        : `segundo plano, PID ${st.pid}`;
      out.ok(`painel rodando em http://127.0.0.1:${st.port}`, how);
      return 0;
    }
    out.warn('painel parado', `inicie com ${out.cmd} iniciar`);
    return 3;
  },

  async iniciar({ out, root, home }) {
    if (!isConfigured(root)) {
      out.fail('ainda não instalado', `rode ${out.cmd} instalar`);
      return 1;
    }
    const r = await startPanel({ root, home });
    if (!r.ok) { out.fail(r.error); return 1; }
    out.ok(r.already ? 'o painel já estava rodando' : 'painel iniciado', `http://127.0.0.1:${r.port}`);
    return 0;
  },

  async parar({ out, root, home }) {
    const r = await stopPanel({ root, home });
    if (!r.ok) { out.fail('não consegui parar o serviço', 'veja: systemctl --user status server-dashboard'); return 1; }
    if (!r.wasRunning) out.ok('o painel não estava rodando');
    else out.ok(r.forced ? 'painel parado (forçado após 5 s)' : 'painel parado', 'o histórico fica salvo em data/');
    return 0;
  },

  async abrir({ out, root, home }) {
    if (!isConfigured(root)) {
      out.fail('ainda não instalado', `rode ${out.cmd} instalar`);
      return 1;
    }
    const r = await startPanel({ root, home });
    if (!r.ok) { out.fail(r.error); return 1; }
    const { url, oneTime } = panelUrl(root, r.port);
    if (openBrowser(url)) {
      out.ok('painel aberto no navegador');
    } else {
      out.step('abra este endereço no navegador desta máquina:');
      out.line(`\n  ${url}\n`);
      if (oneTime) out.line(out.c.dim('  link de uso único: vale uma vez, por 2 minutos'));
    }
    return 0;
  },
};

/** Nomes dos subcomandos (a documentação é conferida contra esta lista). */
export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

/**
 * Ponto de entrada da CLI. `home` é a pasta pessoal onde ficam o serviço systemd e o atalho
 * (padrão: a do usuário); os testes passam uma pasta temporária para não enxergar o painel
 * instalado na máquina de quem roda a suíte.
 */
export async function main(argv = process.argv.slice(2), { root = ROOT, home = os.homedir(), out = makeOutput({ root }) } = {}) {
  const [name = 'ajuda', ...args] = argv;
  // Formas alternativas aceitas para ajuda e versão.
  const alias = { '--help': 'ajuda', '-h': 'ajuda', help: 'ajuda', '--version': 'versao', versão: 'versao' };
  const cmd = COMMANDS[alias[name] ?? name];
  if (!cmd) {
    out.fail(`comando desconhecido: ${name}`);
    out.line(help(out));
    return 2;
  }
  return cmd({ out, root, home, args });
}

// Rodando direto pelo ./dashboard? (importado pelos testes, não executa nada)
const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`ERRO: ${err.message}`);
    process.exit(1);
  });
}
