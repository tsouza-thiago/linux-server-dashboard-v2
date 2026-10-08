// `dashboard instalar` e `dashboard reconfigurar` (seção 11 do plano): confere a versão
// assinada, o Node 24, os arquivos de terceiros (SHA-256), o SSH e a porta, e abre o
// assistente no navegador — ou a TUI (--terminal) ou o modo sem perguntas (--sem-interface).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Instalacao } from '../setup/instalacao.js';
import { createWizardApp, makeSetupCode } from '../setup/web.js';
import { currentVersionStatus, describeVersion, signedReleaseTags } from '../setup/assinatura.js';
import { ensureDataDirs } from '../setup/local.js';
import { openBrowser, panelPort, panelStatus, portFree, stopPanel } from './servico.js';

export const IDLE_MS = 60 * 60 * 1000;

/** Confere uPlot e fontes contra as somas de public/vendor/vendor.json. */
export function verifyVendor(root) {
  const manifestFile = path.join(root, 'public', 'vendor', 'vendor.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { return { ok: false, bad: ['public/vendor/vendor.json'] }; }
  const bad = [];
  let count = 0;
  for (const entry of Object.values(manifest)) {
    const dir = path.join(root, 'public', 'vendor', entry.dir);
    for (const [file, sum] of Object.entries(entry.sha256 || {})) {
      count += 1;
      let got = null;
      try { got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex'); } catch { /* falta o arquivo */ }
      if (got !== sum) bad.push(path.relative(root, path.join(dir, file)));
    }
  }
  return { ok: bad.length === 0, bad, count };
}

export function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) { flags._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (args[i + 1] && !args[i + 1].startsWith('--') && ['servidor', 'usuario', 'porta', 'pastas', 'smart', 'rede', 'servicos', 'identidade', 'importar-v1', 'disco', 'memoria', 'temperatura', 'modo'].includes(k)) { flags[k] = args[i + 1]; i += 1; } else flags[k] = true;
  }
  return flags;
}

const NODE_LINE = {
  baixado: ['Node.js 24 — baixado para .runtime/ e conferido', 'SHA-256'],
  pasta: ['Node.js 24 — em .runtime/', 'conferido ao baixar'],
  sistema: ['Node.js 24 — o do sistema', ''],
};

/** Verificações antes de abrir o assistente. Devolve false se algo impede continuar. */
export function preflight({ out, root, flags, env = process.env, run = spawnSync, reexec }) {
  const ver = currentVersionStatus(root);
  if (ver.ok) {
    out.ok(describeVersion(ver), 'chave do projeto');
  } else if (ver.reason === 'sem-tag' && !flags['sem-assinatura']) {
    // Clonou o main: fixa na versão assinada mais nova (se a pasta estiver limpa).
    const dirty = run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout?.trim();
    const newest = dirty ? null : signedReleaseTags(root)[0];
    if (newest && reexec) {
      out.step(`usando a versão assinada mais nova: ${newest}`);
      const co = run('git', ['-C', root, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', newest], { encoding: 'utf8' });
      if (co.status === 0) return reexec();
    }
    out.fail(describeVersion(ver));
    out.explain(
      dirty ? 'há arquivos alterados nesta pasta, então não troquei de versão sozinho.' : 'não encontrei nenhuma versão (tag) assinada pela chave do projeto.',
      'baixe de novo com o comando do README, ou, se você desenvolve o painel, rode com --sem-assinatura.',
    );
    return false;
  } else if (flags['sem-assinatura']) {
    out.warn(describeVersion(ver), 'seguindo por --sem-assinatura: só para quem desenvolve');
  } else {
    out.fail(describeVersion(ver));
    out.explain('a versão desta pasta não passou na conferência da assinatura.', 'não use esta cópia: baixe de novo com o comando do README.');
    return false;
  }

  const [nodeText, nodeNote] = NODE_LINE[env.DASHBOARD_NODE_ORIGEM] || [`Node.js ${process.versions.node.split('.')[0]}`, ''];
  out.ok(nodeText, nodeNote);

  const vendor = verifyVendor(root);
  if (!vendor.ok) {
    out.fail('arquivos de terceiros não conferem', vendor.bad.join(', '));
    out.explain('algum arquivo do pacote (uPlot ou fontes) foi alterado ou está faltando.', 'baixe de novo com o comando do README.');
    return false;
  }
  out.ok('nada para instalar com npm — tudo já vem no pacote', `uPlot e fontes conferidos · SHA-256`);

  const hasSsh = !run('ssh', ['-V'], { stdio: 'ignore' }).error && !run('ssh-keygen', ['-?'], { stdio: 'ignore' }).error;
  if (!hasSsh) {
    out.fail('falta o SSH nesta máquina');
    out.explain('o painel fala com o servidor por SSH (ssh, ssh-keygen e ssh-keyscan).', 'instale com: sudo apt install openssh-client (Debian/Ubuntu/Mint) ou sudo dnf install openssh-clients (Fedora).');
    return false;
  }
  ensureDataDirs(root);
  out.ok('pasta de dados data/ criada', 'só você lê · 0700');
  return true;
}

/** Abre o assistente no navegador e espera ele terminar. */
export async function runWizard({ out, root, inst, port, open = openBrowser, idleMs = IDLE_MS, log = () => {} }) {
  const code = makeSetupCode();
  let idleTimer = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const app = createWizardApp({
    inst,
    code: code.raw,
    log,
    onActivity: () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => resolveDone({ idle: true }), idleMs);
      idleTimer.unref?.();
    },
    onFinish: (prefs) => resolveDone({ prefs }),
  });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  idleTimer = setTimeout(() => resolveDone({ idle: true }), idleMs);
  idleTimer.unref?.();
  const url = `http://127.0.0.1:${port}/configurar`;
  out.line();
  out.step('abrindo o assistente no navegador…');
  out.line();
  out.line(`  ${out.c.bold(url)}`);
  out.line(`  ${out.c.dim(`código de uso único: ${code.shown} · vale por 30 min`)}`);
  out.line();
  const opened = open(`${url}#codigo=${code.raw}`);
  out.line(out.c.dim(opened ? 'O navegador não abriu? Copie o endereço acima.' : 'Abra o endereço acima no navegador desta máquina e digite o código.'));
  out.line(`${out.c.dim('Máquina sem tela? Rode:')} ./dashboard instalar --terminal`);
  out.line(out.c.dim('Deixe esta janela aberta até o fim do assistente.'));

  const onSignal = () => resolveDone({ cancel: true });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const result = await done;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  clearTimeout(idleTimer);
  inst.esquecerSenha();
  await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
  out.line();
  if (result.cancel || result.idle) {
    out.warn(result.idle ? 'assistente fechado depois de 1 hora parado' : 'assistente cancelado', 'nada foi gravado depois do último passo concluído');
    return 1;
  }
  out.ok('assistente concluído e desligado');
  const lig = await inst.ligarPainel(result.prefs);
  if (!lig.ok) {
    out.fail('o painel não subiu', lig.erro);
    out.explain('a configuração foi salva, mas o painel não iniciou.', 'rode ./dashboard diagnosticar para ver o motivo.');
    return 1;
  }
  if (lig.servico && lig.servico.ok) {
    out.ok('painel rodando como serviço de usuário', result.prefs.iniciarComComputador ? 'inicia com o computador' : 'liga quando você abrir o atalho');
    if (!lig.servico.hardening) out.warn('isolamento do systemd indisponível neste sistema', 'o serviço roda sem ProtectSystem/PrivateTmp');
  } else {
    out.ok('painel rodando em segundo plano', 'use ./dashboard abrir para abrir de novo');
  }
  out.ok(`painel em http://127.0.0.1:${port}`, 'só nesta máquina');
  out.line();
  out.line('Tudo pronto. Pode fechar esta janela.');
  return 0;
}

export async function instalar({ out, root, args, reconfigurar = false, deps = {} }) {
  const flags = parseFlags(args);
  out.title(reconfigurar ? 'Server Dashboard · reconfigurar' : 'Server Dashboard · instalação');
  const reexec = deps.reexec ?? (() => {
    const r = spawnSync(path.join(root, 'dashboard'), [reconfigurar ? 'reconfigurar' : 'instalar', ...args], { stdio: 'inherit' });
    return r.status ?? 1;
  });
  const pre = preflight({ out, root, flags, reexec });
  if (typeof pre === 'number') return pre;
  if (!pre) return 1;

  if (flags['importar-v1']) {
    const { importarV1 } = await import('./importar-v1.js');
    if (panelStatus({ root }).running && !flags.forcar) {
      out.warn('a V2 já está rodando nesta pasta');
      out.explain('', 'para importar de novo, pare a V2 (./dashboard parar) e repita.');
      return 1;
    }
    return importarV1({ out, root, dir: flags['importar-v1'] });
  }

  const st = panelStatus({ root });
  if (st.running) {
    if (!reconfigurar && !flags.forcar) {
      out.warn('o painel já está instalado e rodando');
      out.explain('', 'para trocar servidor, discos ou serviços, rode ./dashboard reconfigurar.');
      return 1;
    }
    await stopPanel({ root });
    out.ok('painel parado durante a reconfiguração', 'volta sozinho no fim');
  }
  const port = panelPort(root);
  if (!(await portFree(port))) {
    out.fail(`a porta ${port} está em uso por outro programa`);
    out.explain('o assistente e o painel usam a mesma porta, só nesta máquina.', 'feche o outro programa ou mude PORT no .env (ex.: PORT=3001).');
    return 1;
  }
  out.ok(`porta ${port} livre · painel só nesta máquina`, '127.0.0.1');

  const inst = deps.inst ?? new Instalacao({ root });
  if (flags.terminal) {
    const { runTui } = await import('../setup/tui.js');
    return runTui({ out, inst, root, open: deps.open ?? openBrowser });
  }
  if (flags['sem-interface']) {
    const { runHeadless } = await import('../setup/sem-interface.js');
    return runHeadless({ out, inst, flags });
  }
  return runWizard({ out, root, inst, port, open: deps.open ?? openBrowser });
}
