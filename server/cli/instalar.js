// `dashboard instalar` e `dashboard reconfigurar` (ADR 0011): confere a versão
// assinada, o Node 24, os arquivos de terceiros (SHA-256), o SSH e a porta, e abre o
// assistente no navegador — ou a TUI (--terminal) ou o modo sem perguntas (--sem-interface).
// `reconfigurar` sem opções, com o painel no ar, só abre o painel no diálogo do Reconfigurar (ADR 0039).
// Com --pela-tela (interna, ADR 0034 e 0035), quem chama é o painel: sem terminal, sem código novo.
// Desistir, ou um painel novo que não responde, religa o painel com a configuração anterior.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Instalacao } from '../setup/instalacao.js';
import { createWizardApp, makeSetupCode } from '../setup/web.js';
import { currentVersionStatus, describeVersion, signedReleaseTags, installTag } from '../setup/assinatura.js';
import { ensureDataDirs, guardarConfiguracao } from '../setup/local.js';
import { dataDe, pastasDe } from '../config.js';
import { LOG_PELA_TELA, retirarCodigoPelaTela } from '../setup/pela-tela.js';
import { emAndamento } from '../atualizacao/registro.js';
import { bloqueioDaReconfiguracao, versaoDaPasta } from '../atualizacao/procurar.js';
import { UNIT_NAME, motivoSemPainel, openBrowser, panelHealthy, panelPort, panelStatus, panelUrl, portFree, startPanel, stopPanel, systemctlUser } from './servico.js';
import { makeOutput, mostrarComando } from './saida.js';

// O assistente se desliga sozinho depois de 1 h sem nenhum pedido.
const IDLE_MS = 60 * 60 * 1000;
// Pela tela, a coleta está parada e não há terminal aberto: quem abandonou não volta para religar.
const IDLE_TELA_MS = 15 * 60 * 1000;

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

/**
 * Opções da linha de comando: `--chave=valor`, `--chave valor` (só para as opções que
 * levam valor, listadas abaixo) e `--chave` sozinha (= true). O resto vai para `_`.
 */
export function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) { flags._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (args[i + 1] && !args[i + 1].startsWith('--') && ['servidor', 'usuario', 'porta', 'pastas', 'smart', 'rede', 'servicos', 'identidade', 'importar-v1', 'disco', 'memoria', 'temperatura', 'modo', 'chave-ssh'].includes(k)) { flags[k] = args[i + 1]; i += 1; } else flags[k] = true;
  }
  return flags;
}

// Linha do Node na saída, conforme de onde o ./dashboard o tirou.
const NODE_LINE = {
  baixado: ['Node.js 24 — baixado para .runtime/ e conferido', 'SHA-256'],
  pasta: ['Node.js 24 — em .runtime/', 'conferido ao baixar'],
  sistema: ['Node.js 24 — o do sistema', ''],
  pacote: ['Node.js 24 — o do pacote', 'em /opt/server-dashboard/node'],
};

/**
 * A versão da pasta do clone: assinada pela chave do projeto ou, no main, trocada para a tag
 * assinada mais nova (devolve o código da nova execução). true segue, false para.
 */
function conferirVersaoDoClone({ out, root, flags, run, reexec }) {
  const ver = currentVersionStatus(root);
  // A pasta tem arquivo do painel alterado? (nesse caso, nunca troca de versão sozinho)
  const isDirty = () => Boolean(run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout?.trim());
  // Troca para a tag e roda o ./dashboard de novo (null se o checkout falhar).
  const pin = (tag, label) => {
    out.step(`${label}: ${tag}`);
    const co = run('git', ['-C', root, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', tag], { encoding: 'utf8' });
    return co.status === 0 ? reexec() : null;
  };
  // Clone do main parado numa pré-versão (o último merge tem tag -rc): quem instala do zero
  // fica na estável. Quem escolheu a tag (git checkout <tag>, HEAD solto) continua nela.
  if (ver.ok && ver.tag.includes('-') && !flags.pre && reexec
      && run('git', ['-C', root, 'symbolic-ref', '-q', 'HEAD'], { encoding: 'utf8' }).status === 0 && !isDirty()) {
    const stable = installTag(signedReleaseTags(root));
    if (stable && !stable.includes('-')) {
      const r = pin(stable, 'usando a versão estável assinada mais nova');
      if (r !== null) return r;
    }
  }
  if (ver.ok) {
    out.ok(describeVersion(ver), 'chave do projeto');
  } else if (ver.reason === 'sem-tag' && !flags['sem-assinatura']) {
    // Clonou o main: fixa na versão assinada mais nova (se a pasta estiver limpa); a estável,
    // se houver uma (pré-versão só com --pre).
    const dirty = isDirty();
    const newest = dirty ? null : installTag(signedReleaseTags(root), { pre: Boolean(flags.pre) });
    if (newest && reexec) {
      const r = pin(newest, 'usando a versão assinada mais nova');
      if (r !== null) return r;
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
  return true;
}

/**
 * Verificações antes de abrir o assistente: versão assinada (fixa na tag certa se for um
 * clone do main), Node, arquivos de terceiros, SSH e a pasta data/. Devolve true para seguir,
 * false se algo impede continuar, ou o código de saída da nova execução depois de trocar de
 * versão (o ./dashboard da tag escolhida roda de novo, com o Node que ela pede).
 */
export function preflight({ out, root, flags, env = process.env, run = spawnSync, reexec }) {
  // Pacote .deb (modo sistema, ADR 0043): o código em /opt veio do pacote ou do executor, que
  // conferem a assinatura (ADR 0042). Aqui não há git e a versão nunca é trocada.
  if (pastasDe(root).modo === 'sistema') {
    out.ok(`versão ${versaoDaPasta(root)}`, 'instalada pelo pacote .deb');
  } else {
    const versao = conferirVersaoDoClone({ out, root, flags, run, reexec });
    if (versao !== true) return versao;
  }

  // Depois de trocar de versão (reexec), o Node baixado agora há pouco aparece como "da pasta".
  const origem = env.DASHBOARD_NODE_BAIXADO === '1' ? 'baixado' : env.DASHBOARD_NODE_ORIGEM;
  const [nodeText, nodeNote] = NODE_LINE[origem] || [`Node.js ${process.versions.node.split('.')[0]}`, ''];
  out.ok(nodeText, nodeNote);

  // uPlot e fontes: as somas SHA-256 do vendor.json precisam bater (cadeia de suprimentos).
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
  const { data } = ensureDataDirs(root);
  out.ok('pasta de dados data/ criada', `só você lê · 0700${pastasDe(root).modo === 'sistema' ? ` · ${data}` : ''}`);
  return true;
}

/**
 * Abre o assistente no navegador (servidor temporário na porta do painel, com código de uso
 * único) e espera ele terminar, ser cancelado (Ctrl+C) ou ficar 1 h parado. No fim, a senha
 * é esquecida, o assistente se desliga e o painel é ligado com as escolhas feitas. `pelaTela`
 * ({ codigo, desistir, ligarNovo, voltar }) troca o código novo pelo do arquivo; ao cancelar ou
 * abandonar, chama `desistir`; no fim, liga por `ligarNovo` e, se falhar, chama `voltar`.
 */
export async function runWizard({ out, root, inst, port, open = openBrowser, idleMs = IDLE_MS, log = () => {}, pelaTela = null }) {
  const code = pelaTela ? null : makeSetupCode();
  let idleTimer = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const app = createWizardApp({
    inst,
    ...(pelaTela
      ? { codeHash: pelaTela.codigo.hash, codeTtlMs: pelaTela.codigo.exp - Date.now(), onCancel: () => resolveDone({ cancel: true }) }
      : { code: code.raw }),
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
  if (pelaTela) {
    // O navegador que pediu já tem o código: nada para abrir nem mostrar.
    out.step('assistente no ar, esperando o navegador');
  } else {
    out.step('abrindo o assistente no navegador…');
    out.line();
    out.line(`  ${out.c.bold(url)}`);
    out.line(`  ${out.c.dim(`código de uso único: ${code.shown} · vale por 30 min`)}`);
    out.line();
    const opened = open(`${url}#codigo=${code.raw}`);
    out.line(out.c.dim(opened ? 'O navegador não abriu? Copie o endereço acima.' : 'Abra o endereço acima no navegador desta máquina e digite o código.'));
    out.line(`${out.c.dim('Máquina sem tela? Rode:')} ${out.cmd} instalar --terminal`);
    out.line(out.c.dim('Deixe esta janela aberta até o fim do assistente.'));
  }

  // Ctrl+C ou SIGTERM durante o assistente: cancela de forma limpa.
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
    if (pelaTela) {
      out.warn(result.idle ? 'assistente fechado depois de 15 minutos parado' : 'assistente cancelado');
      return pelaTela.desistir();
    }
    out.warn(result.idle ? 'assistente fechado depois de 1 hora parado' : 'assistente cancelado', 'nada foi gravado depois do último passo concluído');
    return 1;
  }
  out.ok('assistente concluído e desligado');
  mostrarComando(out, inst.comando);
  const lig = await (pelaTela ? pelaTela.ligarNovo(result.prefs) : inst.ligarPainel(result.prefs));
  if (!lig.ok) {
    if (pelaTela) return pelaTela.voltar(lig.erro);
    out.fail('o painel não subiu', lig.erro);
    out.explain('a configuração foi salva, mas o painel não iniciou.', `rode ${out.cmd} diagnosticar para ver o motivo.`);
    return 1;
  }
  if (lig.servico && lig.servico.ok) {
    out.ok('painel rodando como serviço de usuário', result.prefs.iniciarComComputador ? 'inicia com o computador' : 'liga quando você abrir o atalho');
    if (!lig.servico.hardening) out.warn('isolamento do systemd indisponível neste sistema', 'o serviço roda sem ProtectSystem/PrivateTmp');
  } else {
    out.ok('painel rodando em segundo plano', `use ${out.cmd} abrir para abrir de novo`);
  }
  out.ok(`painel em http://127.0.0.1:${port}`, 'só nesta máquina');
  out.line();
  out.line('Tudo pronto. Pode fechar esta janela.');
  return 0;
}

/**
 * Passos do `--pela-tela`, com a saída já no log. Tudo o que pode recusar vem antes de parar o
 * painel: quem recusa aqui deixa o painel no ar. Nenhuma opção entra: o comando é fixo (I11).
 */
async function assistentePelaTela({ out, root, home, deps }) {
  const parar = deps.stopPanel ?? stopPanel;
  const ligar = deps.startPanel ?? startPanel;
  const responde = deps.healthy ?? panelHealthy;
  // Sem `reexec`: um clique na tela nunca troca a versão da pasta.
  if ((deps.preflight ?? preflight)({ out, root, flags: {} }) !== true) return 1;
  if (emAndamento(root)) {
    out.fail('há uma atualização em andamento', 'o painel continua no ar');
    return 1;
  }
  const codigo = retirarCodigoPelaTela(dataDe(root));
  if (!codigo) {
    out.fail('sem código válido da tela', 'o painel continua no ar');
    return 1;
  }
  // O assistente pode trocar o "iniciar com o computador": a volta precisa saber como estava.
  const antes = (deps.panelStatus ?? panelStatus)({ root, home });
  const parado = await parar({ root, home });
  if (!parado.ok) {
    out.fail('não consegui parar o painel');
    return 1;
  }
  const restaurar = guardarConfiguracao(root);
  const desistir = async () => {
    restaurar();
    const r = await ligar({ root, home });
    if (!r.ok) {
      out.fail('o painel não voltou', r.error);
      return 1;
    }
    out.ok('painel de volta com a configuração anterior');
    return 0;
  };
  // A configuração nova foi escolhida, mas o painel não subiu com ela (ADR 0035).
  const voltar = async (erro) => {
    out.fail('o painel não subiu com a configuração nova', erro);
    // Ele pode ter ficado de pé sem responder: ligar de novo só diria "já está rodando".
    const novo = await parar({ root, home });
    if (!novo.ok) out.warn('não consegui parar o painel novo');
    await desistir();
    if (antes.mode === 'servico') (deps.systemctl ?? systemctlUser)([antes.enabled ? 'enable' : 'disable', UNIT_NAME]);
    return 1;
  };
  const port = panelPort(root);
  // Depois do assistente, só este processo traz o painel de volta, e a cópia morreria com ele: o
  // SIGTERM espera. Durante o assistente, quem atende o sinal é o `runWizard`.
  const esperaOFim = () => {};
  process.on('SIGTERM', esperaOFim);
  try {
    const inst = deps.inst ?? new Instalacao({ root, home });
    // O painel novo só vale depois de responder. A porta vem do .env novo.
    const ligarNovo = async (prefs) => {
      try {
        const lig = await inst.ligarPainel(prefs);
        if (!lig.ok || await responde(panelPort(root))) return lig;
        return { ok: false, erro: 'o painel não respondeu' };
      } catch (err) {
        return { ok: false, erro: err.message };
      }
    };
    return await runWizard({ out, root, inst, port, idleMs: deps.idleMs ?? IDLE_TELA_MS, pelaTela: { codigo, desistir, ligarNovo, voltar } });
  } catch (err) {
    // Na troca painel ↔ assistente, outro programa pode ter tomado a porta.
    out.fail('o assistente não subiu', err.message);
    return desistir();
  } finally {
    process.off('SIGTERM', esperaOFim);
  }
}

/** `./dashboard reconfigurar --pela-tela` (interna): sem terminal, a saída vai para data/. */
async function reconfigurarPelaTela({ root, home, deps }) {
  const dataDir = dataDe(root);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(dataDir, LOG_PELA_TELA), 'w', 0o600);
  fs.fchmodSync(fd, 0o600);
  const out = makeOutput({ stream: { isTTY: false, write: (texto) => fs.writeSync(fd, texto) }, root });
  try {
    return await assistentePelaTela({ out, root, home, deps });
  } finally {
    fs.closeSync(fd);
  }
}

// A tela que o `dashboard reconfigurar` abre: a Visão geral, com o diálogo do Reconfigurar (ADR 0039).
const TELA_DE_RECONFIGURAR = '#/visao-geral?reconfigurar=1';
// O que a rota do painel recusaria depois do clique (ADR 0036). Recusar aqui evita a volta ao terminal,
// que abriria a mesma tela de novo.
const PASTA_RECUSADA = {
  'outra-pasta': 'o serviço do painel roda de outra pasta',
  'sem-assinatura': 'a versão desta pasta não passou na conferência da assinatura',
};

/**
 * Com o painel no ar, o `reconfigurar` sem opções termina pela tela: abre o link de uso único no
 * diálogo do Reconfigurar, e quem para o painel é o `--pela-tela`, depois do clique. false: segue
 * pelo caminho de hoje (preflight e assistente daqui), depois de dizer o motivo.
 */
async function abrirNoPainel({ out, root, home, deps }) {
  const motivo = await motivoSemPainel({ root, home, deps })
    ?? PASTA_RECUSADA[bloqueioDaReconfiguracao(root, home, deps.gitRun)] ?? null;
  if (motivo) {
    out.line(out.c.dim(`${motivo}: sigo pelo assistente daqui.`));
    return false;
  }
  if (!(deps.open ?? openBrowser)(panelUrl(root, panelPort(root), TELA_DE_RECONFIGURAR).url)) {
    out.warn('não consegui abrir o navegador', 'sigo pelo assistente daqui');
    return false;
  }
  out.ok('painel aberto no navegador', 'a reconfiguração continua no diálogo do Reconfigurar');
  out.line(out.c.dim(`Prefere o terminal? Rode ${out.cmd} reconfigurar --terminal.`));
  return true;
}

/**
 * `./dashboard instalar` e `./dashboard reconfigurar`: preflight, depois o caminho escolhido
 * (--importar-v1, --terminal, --sem-interface ou o assistente no navegador).
 */
export async function instalar({ out, root, args, home, reconfigurar = false, deps = {} }) {
  const flags = parseFlags(args);
  if (flags['pela-tela']) {
    if (!reconfigurar || flags.terminal || flags['sem-interface'] || flags['importar-v1']) {
      out.fail('--pela-tela é interna do reconfigurar', 'quem a usa é o painel');
      return 2;
    }
    return reconfigurarPelaTela({ root, home, deps });
  }
  out.title(reconfigurar ? 'Server Dashboard · reconfigurar' : 'Server Dashboard · instalação');
  // Qualquer opção segue pelo caminho de hoje: a tela não leva opção ao comando fixo do executor (I11).
  if (reconfigurar && args.length === 0 && await abrirNoPainel({ out, root, home, deps })) return 0;
  // Roda o ./dashboard de novo com os mesmos argumentos (depois de trocar de versão).
  const reexec = deps.reexec ?? (() => {
    const env = { ...process.env, ...(process.env.DASHBOARD_NODE_ORIGEM === 'baixado' ? { DASHBOARD_NODE_BAIXADO: '1' } : {}) };
    const r = spawnSync(path.join(root, 'dashboard'), [reconfigurar ? 'reconfigurar' : 'instalar', ...args], { stdio: 'inherit', env });
    return r.status ?? 1;
  });
  const pre = preflight({ out, root, flags, reexec });
  if (typeof pre === 'number') return pre;
  if (!pre) return 1;

  if (flags['importar-v1']) {
    const { importarV1 } = await import('./importar-v1.js');
    if (panelStatus({ root, home }).running && !flags.forcar) {
      out.warn('a V2 já está rodando nesta pasta');
      out.explain('', `para importar de novo, pare a V2 (${out.cmd} parar) e repita.`);
      return 1;
    }
    return importarV1({ out, root, dir: flags['importar-v1'] });
  }

  const st = panelStatus({ root, home });
  if (st.running) {
    if (!reconfigurar && !flags.forcar) {
      out.warn('o painel já está instalado e rodando');
      out.explain('', `para trocar servidor, discos ou serviços, rode ${out.cmd} reconfigurar.`);
      return 1;
    }
    await stopPanel({ root, home });
    out.ok('painel parado durante a reconfiguração', 'volta sozinho no fim');
  }
  // O assistente usa a porta do painel: ela precisa estar livre.
  const port = panelPort(root);
  if (!(await portFree(port))) {
    out.fail(`a porta ${port} está em uso por outro programa`);
    out.explain('o assistente e o painel usam a mesma porta, só nesta máquina.', 'feche o outro programa ou mude PORT no .env (ex.: PORT=3001).');
    return 1;
  }
  out.ok(`porta ${port} livre · painel só nesta máquina`, '127.0.0.1');

  const inst = deps.inst ?? new Instalacao({ root, home });
  // No pacote .deb, o comando e o autocomplete vêm do pacote (/usr/bin, /usr/share): sem link pessoal.
  inst.semLink = Boolean(flags['sem-link']) || pastasDe(root).modo === 'sistema';
  if (flags.terminal) {
    const { runTui } = await import('../setup/tui.js');
    return runTui({ out, inst, open: deps.open ?? openBrowser });
  }
  if (flags['sem-interface']) {
    const { runHeadless } = await import('../setup/sem-interface.js');
    return runHeadless({ out, inst, flags });
  }
  return runWizard({ out, root, inst, port, open: deps.open ?? openBrowser });
}
