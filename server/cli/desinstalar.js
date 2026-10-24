// `dashboard desinstalar`: remove o serviço, o atalho e os arquivos locais e
// oferece limpar o servidor — só a parte desta instalação (a linha da chave e a regra de
// sudo dela; o usuário dashmon sai só se nenhum outro computador o usar, ADR 0020) — com
// os comandos exibidos antes e a senha usada uma vez, como no assistente.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { removalScript, remainingLines, assistedScript, completedSteps } from '../setup/preparo.js';
import { runAdmin, describeAdminError } from '../setup/remoto.js';
import { removeService, removeShortcut } from '../setup/local.js';
import { currentServer } from '../setup/instalacao.js';
import { validUser, installId, validPublicKey, NAME_PREFIX, PANEL_USER } from '../setup/acesso.js';
import { stopPanel } from './servico.js';
import { keyFileFromConfig } from './diagnosticar.js';
import { parseFlags } from './instalar.js';

/** Pergunta no terminal (com a senha escondida quando `secret`). */
export function ask(question, { secret = false, input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    // Senha: no terminal, cada caractere aparece como "•" (a pergunta continua visível).
    if (secret && input.isTTY) {
      rl._writeToOutput = (s) => { if (s.includes(question)) output.write(s); else if (!/[\r\n]/.test(s)) output.write('•'); };
    }
    rl.question(question, (answer) => { rl.close(); if (!input.isTTY || secret) output.write('\n'); resolve(answer); });
  });
}

/** Chave pública ("ssh-ed25519 AAAA…") do .pub ao lado da chave do painel, ou null. */
function publicKeyOf(key) {
  try {
    const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
    return validPublicKey(pub) ? pub : null;
  } catch {
    return null;
  }
}

// "s", "sim", "y" ou "yes" (sem diferenciar maiúsculas) contam como sim.
const yes = (a) => /^(s|sim|y|yes)$/i.test(String(a || '').trim());

/**
 * `./dashboard desinstalar`: pede confirmação (ou --sim), oferece limpar o servidor, remove o
 * serviço, o atalho, a chave e a configuração local, e pergunta se apaga o histórico.
 * Opções: --sim, --limpar-servidor, --usuario, --senha-stdin, --apagar-historico.
 */
export async function desinstalar({ out, root, args = [], home = os.homedir(), deps = {} }) {
  const flags = parseFlags(args);
  const askFn = deps.ask ?? ask;
  out.title('Server Dashboard · desinstalar');
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
  if (!flags.sim && !interactive) {
    out.fail('confirme com --sim para desinstalar sem perguntas');
    return 2;
  }
  if (!flags.sim && !yes(await askFn('Remover o painel desta máquina (serviço, atalho, chave e configuração)? [s/N] '))) {
    out.ok('nada foi removido');
    return 0;
  }

  // 1. Servidor primeiro: depois que a chave e o known_hosts saem, não dá mais para conferir a
  // identidade nem saber qual linha é desta instalação.
  const server = currentServer(root);
  const knownHosts = path.join(root, 'data', 'ssh', 'known_hosts');
  const key = keyFileFromConfig(root);
  const publicKey = publicKeyOf(key);
  if (server && fs.existsSync(knownHosts) && !publicKey) {
    out.line();
    out.warn('o servidor não foi alterado', `não achei a chave pública deste painel (${key ? `${key}.pub` : 'sem IdentityFile no data/ssh/config'})`);
    out.line(out.c.dim(`Confira à mão as linhas de ~${PANEL_USER}/.ssh/authorized_keys no servidor: cada uma termina com o computador e o ID.`));
  } else if (server && fs.existsSync(knownHosts)) {
    const id = installId(publicKey);
    out.line();
    out.line(`No servidor ficaram: a linha deste computador no authorized_keys do ${PANEL_USER} (ID ${id}) e a regra de sudo dele.`);
    out.line(out.c.dim('Para remover à mão, rode no servidor:'));
    out.line(out.c.dim(`  sudo sed -i -e '\\# ${publicKey.split(' ')[1]} #d' -e '\\# ${NAME_PREFIX}@[a-z0-9-]*:${id}$#d' ~${PANEL_USER}/.ssh/authorized_keys`));
    out.line(out.c.dim(`  sudo find /etc/sudoers.d -maxdepth 1 -name '${NAME_PREFIX}-*-${id}*' -delete`));
    out.line(out.c.dim(`  e, se o authorized_keys ficar vazio (nenhum outro computador): sudo userdel -r ${PANEL_USER}`));
    const want = flags['limpar-servidor'] || (interactive && !flags.sim && yes(await askFn(`Quer que eu faça isso agora em ${server.host}? Precisa de um usuário com sudo. [s/N] `)));
    if (want) {
      const user = String(flags.usuario || (interactive ? await askFn('Usuário administrador no servidor: ') : '')).trim();
      if (!validUser(user)) {
        out.fail('usuário inválido: o servidor não foi alterado');
      } else {
        const senha = flags['senha-stdin'] || interactive ? String(await askFn(`Senha de ${user} (em branco = sua chave SSH): `, { secret: true })) : '';
        // Como o script vai virar root: já é root, sudo com a senha ou sudo sem senha.
        const sudo = user === 'root' ? 'root' : senha ? 'senha' : 'nopasswd';
        const r = await (deps.runAdmin ?? runAdmin)({
          host: server.host, port: server.port, user, password: senha, knownHosts,
          script: assistedScript(removalScript({ publicKey }), { sudo, password: senha }), timeoutMs: 60000,
        });
        if (r.code === 0 && completedSteps(r.stdout).includes('removido')) {
          const rest = remainingLines(r.stdout);
          out.ok('servidor limpo', rest ? `linha e regra de sudo deste computador removidas; o usuário ${PANEL_USER} fica para ${rest === 1 ? 'a outra linha' : `as outras ${rest} linhas`}` : `usuário ${PANEL_USER} e regra de sudo removidos`);
        } else out.fail('não consegui limpar o servidor', /^@@erro senha$/m.test(r.stdout) ? 'o sudo recusou a senha' : describeAdminError(r));
      }
    } else {
      out.warn('o servidor não foi alterado', 'use os comandos acima quando quiser');
    }
  }

  // 2. Esta máquina.
  await (deps.stopPanel ?? stopPanel)({ root, home });
  out.ok('painel parado');
  if ((deps.removeService ?? removeService)({ home })) out.ok('serviço de usuário removido');
  if (removeShortcut({ home })) out.ok('atalho do menu removido');
  // Só apaga a chave se ela for do painel (nome dashboard*): nunca a chave pessoal de alguém.
  if (key && path.basename(key).startsWith('dashboard') && fs.existsSync(key)) {
    fs.rmSync(key, { force: true });
    fs.rmSync(`${key}.pub`, { force: true });
    out.ok('chave do painel apagada', key.replace(home, '~'));
  }
  for (const f of ['.env', path.join('data', 'ssh'), path.join('data', 'sessions.json'), path.join('data', 'entrar.json'), '.runtime']) {
    fs.rmSync(path.join(root, f), { recursive: true, force: true });
  }
  out.ok('configuração local apagada', '.env, data/ssh, sessões e o Node baixado');
  const dropHistory = flags['apagar-historico'] || (interactive && !flags.sim && yes(await askFn('Apagar também o histórico (data/)? [s/N] ')));
  if (dropHistory) {
    fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
    fs.rmSync(path.join(root, '.backups'), { recursive: true, force: true });
    out.ok('histórico apagado');
  } else {
    out.ok('histórico mantido em data/', 'apague a pasta quando quiser');
  }
  out.line();
  out.line(`Pronto. A pasta do projeto pode ser apagada: rm -rf "${root}"`);
  return 0;
}
