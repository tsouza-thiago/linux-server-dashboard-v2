// Manutenção do painel (ADR 0030): a engrenagem no topo com a versão instalada e "Procurar
// agora", o aviso de versão nova, o diálogo com as novidades e o botão Atualizar, com o progresso
// (ADR 0031), e o item Reconfigurar com o diálogo dele (ADR 0036), a espera do assistente e o motivo
// quando a reconfiguração não vale (ADR 0035). Não é uma tela: fica por cima de todas. A tela só pede a troca da versão detectada: quem troca é o `dashboard atualizar --registro`,
// fora do serviço (I11).
import { api } from '../core/api.js';
import { html, mount } from '../core/html.js';
import { blocosDeNovidade } from '../core/novidades.js';
import * as f from '../core/format.js';
import { icon, withBusy } from './common.js';

// Versão cujo aviso foi fechado neste navegador: ela só volta a aparecer no menu.
const DISPENSADA_KEY = 'dash_versao_dispensada';
// Sem o --terminal, o comando abriria esta mesma tela.
const COMANDO = './dashboard atualizar --terminal';
// Leitura do progresso: a cada 1 s, e até ~3 min de painel fora do ar antes de sugerir o terminal.
const LEITURA_MS = 1000;
const MAX_FALHAS = 180;
const RECARGA_MS = 3000;
// Espera do assistente depois do clique: parar o painel e subir o assistente leva segundos. Acima
// disso, a tela para de esperar e deixa o link, caso ele suba depois.
const ESPERA_ASSISTENTE_MS = 90000;
// Na volta do assistente, só uma falha deste tempo para cá é desta reconfiguração.
const VOLTA_RECENTE_MS = 10 * 60000;
// Por que não dá para atualizar, para dizer antes de a pessoa tentar.
const BLOQUEIOS = {
  'sem-login': 'Este painel não tem login. Sem sessão, o botão ficaria aberto a qualquer programa desta máquina.',
  rodando: 'Já há uma atualização rodando nesta pasta.',
  'arquivos-alterados': 'Há arquivos do painel alterados nesta pasta. Guarde ou desfaça as alterações antes de atualizar.',
  'sem-git': 'Esta pasta não veio de um git clone. Instale de novo pelo comando do README.',
  'outra-pasta': 'Este painel não roda da pasta da instalação. Rode o comando na pasta da instalação.',
};
// Por que não dá para reconfigurar. Só `sem-login` e `rodando` vêm do estado: os outros aparecem depois
// do clique (ADR 0036). `arquivos-alterados` e `sem-git` valem só para a troca de versão.
const COMANDO_RECONFIGURAR = './dashboard reconfigurar';
const IMPEDEM_RECONFIGURAR = ['sem-login', 'rodando'];
const BLOQUEIOS_RECONFIGURAR = {
  'sem-login': BLOQUEIOS['sem-login'],
  rodando: 'Já há uma atualização ou uma reconfiguração em andamento nesta pasta. Espere terminar e tente de novo.',
  'outra-pasta': BLOQUEIOS['outra-pasta'],
  'sem-assinatura': 'A versão desta pasta não passou na conferência da assinatura. Se você desenvolve o painel, use a opção --sem-assinatura no terminal; se não, baixe de novo com o comando do README.',
};
// O fim da reconfiguração quando ela não vale, com as linhas de falha de data/reconfigurar.log.
const NAO_VALEU = {
  recusou: 'O painel recusou a reconfiguração e continua no ar, com a configuração de agora.',
  voltou: 'A configuração nova não funcionou, e o painel voltou com a configuração de antes.',
};
const FASES = {
  iniciando: 'Iniciando a atualização…',
  procurando: 'Conferindo a versão e a assinatura…',
  trocando: 'Copiando os dados e trocando de versão…',
  ligando: 'Ligando a versão nova…',
  voltando: 'A versão nova falhou. Voltando para a anterior…',
};
const REINICIANDO = 'Reiniciando o painel…';
const RECONFIGURAR = 'Esta versão muda o script de coleta. Depois de atualizar, rode ./dashboard reconfigurar no terminal, com a senha do administrador do servidor. Até lá, alguns dados podem faltar. A Visão geral mostra o passo a passo.';
const ERROS = {
  'sem-acesso': 'Sem acesso ao GitHub na última procura. Tento de novo amanhã.',
  falhou: 'A última procura falhou. Tento de novo amanhã.',
};
const $ = (id) => document.getElementById(id);
const pausa = (ms) => new Promise((r) => { setTimeout(r, ms); });

const lerDispensada = () => { try { return localStorage.getItem(DISPENSADA_KEY); } catch { return null; } };
const gravarDispensada = (v) => { try { localStorage.setItem(DISPENSADA_KEY, v); } catch { /* armazenamento bloqueado */ } };

// Uma linha do CHANGELOG: `código` em fonte fixa, o resto como texto (sempre escapado).
const linha = (partes) => partes.map((p) => (p.codigo ? html`<code>${p.texto}</code>` : html`${p.texto}`));

/** Uma seção das novidades: versão, data e os blocos do texto. */
function secao(s) {
  const blocos = blocosDeNovidade(s.texto);
  return html`<section class="novidades-secao">
    <h3>v${s.versao}${s.data ? html` <span class="novidades-data">${s.data.split('-').reverse().join('/')}</span>` : ''}</h3>
    ${blocos.map((b) => (b.tipo === 'titulo' ? html`<h4>${linha(b.partes)}</h4>`
      : b.tipo === 'item' ? html`<p class="novidades-item">${linha(b.partes)}</p>` : html`<p>${linha(b.partes)}</p>`))}
  </section>`;
}

/**
 * Liga o menu, o aviso e o diálogo ao estado `atualizacao` do `store`. `pedidoDoTerminal`: a página
 * veio do `dashboard atualizar` (ADR 0032), que abre o menu, procura e mostra o diálogo.
 * `voltaDoAssistente`: a página veio do fim do assistente aberto pelo botão Reconfigurar.
 */
export function iniciarManutencao({ store, toast, pedidoDoTerminal = false, voltaDoAssistente = false }) {
  const botao = $('manutBtn');
  const menu = $('manutMenu');
  const aviso = $('avisoVersao');
  const dialogo = $('novidadesDialog');
  mount(botao, icon('gear', 18));
  // Há uma leitura de progresso ligada nesta aba.
  let acompanhando = false;

  const fecharMenu = () => {
    menu.hidden = true;
    botao.setAttribute('aria-expanded', 'false');
  };

  /** O diálogo com as novidades da versão nova e o botão, ou o motivo e o comando do terminal. */
  function abrirNovidades() {
    const { nova, novidades, bloqueio, exigeReconfigurar } = store.get().atualizacao || {};
    if (!nova) return;
    fecharMenu();
    mount(dialogo, html`<form method="dialog" class="dialogo-corpo">
      <h2 id="novidadesTitulo">Novidades da ${nova}</h2>
      <div class="novidades" tabindex="0">
        ${novidades?.secoes?.length ? novidades.secoes.map(secao) : html`<p>As novidades desta versão não estão disponíveis aqui.</p>`}
        ${novidades?.cortado ? html`<p class="novidades-corte">O texto é longo. O restante está no CHANGELOG da versão.</p>` : ''}
      </div>
      ${exigeReconfigurar ? html`<p class="dialogo-aviso" id="avisoReconfigurar">${icon('warn', 16)}<span>${RECONFIGURAR}</span></p>` : ''}
      ${BLOQUEIOS[bloqueio] ? html`<p class="dialogo-aviso">${icon('warn', 16)}<span>${BLOQUEIOS[bloqueio]}</span></p>` : ''}
      ${bloqueio && bloqueio !== 'rodando' ? html`<p class="dialogo-comando">Para atualizar, rode no terminal, na pasta do painel: <span class="mono">${COMANDO}</span></p>`
    : bloqueio ? '' : html`<p class="dialogo-comando">O painel fica fora do ar por alguns segundos. Os dados ganham uma cópia antes da troca, e o painel volta sozinho para a versão atual se a nova falhar.</p>`}
      <div class="dialogo-acoes">
        <button class="btn btn-soft" type="submit" autofocus>Fechar</button>
        ${bloqueio ? html`<button class="btn btn-primary" type="button" disabled>Atualizar agora</button>`
    : html`<button class="btn btn-primary" type="button" data-manut="atualizar">Atualizar agora</button>`}
      </div>
    </form>`);
    if (!dialogo.open) dialogo.showModal();
  }

  /**
   * O diálogo que explica a reconfiguração antes de parar a coleta. `motivo` é o bloqueio que veio
   * depois do clique; `erro`, a recusa sem bloqueio, em que tentar de novo pode dar certo.
   */
  function abrirReconfigurar({ motivo = null, erro = null } = {}) {
    const doEstado = store.get().atualizacao?.bloqueio;
    const bloqueio = motivo ?? (IMPEDEM_RECONFIGURAR.includes(doEstado) ? doEstado : null);
    const aviso = BLOQUEIOS_RECONFIGURAR[bloqueio] ?? erro;
    fecharMenu();
    delete dialogo.dataset.resultado;
    mount(dialogo, html`<form method="dialog" class="dialogo-corpo">
      <h2 id="novidadesTitulo">Reconfigurar o painel</h2>
      <p>O assistente troca o servidor, as pastas, os discos, os serviços e os limites dos alertas. Tenha em mãos a senha do administrador do servidor.</p>
      <p>A coleta pausa durante a reconfiguração, e o painel volta sozinho no fim. Se o assistente ficar parado por 15 min, o painel volta com a configuração de agora.</p>
      ${aviso ? html`<p class="dialogo-aviso">${icon('warn', 16)}<span>${aviso}</span></p>` : ''}
      ${bloqueio && bloqueio !== 'rodando' ? html`<p class="dialogo-comando">Para reconfigurar, rode no terminal, na pasta do painel: <span class="mono">${COMANDO_RECONFIGURAR}</span></p>` : ''}
      <div class="dialogo-acoes">
        <button class="btn btn-soft" type="submit" autofocus>Fechar</button>
        ${bloqueio ? html`<button class="btn btn-primary" type="button" disabled>Reconfigurar agora</button>`
    : html`<button class="btn btn-primary" type="button" data-manut="reconfigurar-agora">Reconfigurar agora</button>`}
      </div>
    </form>`);
    if (!dialogo.open) dialogo.showModal();
  }

  /**
   * O fim que não valeu: o motivo vem das linhas de falha do log do comando, nunca do log inteiro.
   * `link`: o código ainda pode servir, se o assistente subir depois da espera.
   */
  function naoValeu({ titulo, texto, motivos = [], link = null }) {
    acompanhando = false;
    mount(dialogo, html`<div class="dialogo-corpo">
      <h2 id="novidadesTitulo">${titulo}</h2>
      <p class="dialogo-aviso" role="status">${icon('warn', 16)}<span>${texto}</span></p>
      ${motivos.length ? html`<pre class="registro mono" id="reconfigurarMotivos" tabindex="0">${motivos.join('\n')}</pre>
        <p class="dialogo-comando">O registro completo fica em <span class="mono">data/reconfigurar.log</span>. Para reconfigurar pelo terminal, rode na pasta do painel: <span class="mono">${COMANDO_RECONFIGURAR}</span></p>` : ''}
      <div class="dialogo-acoes">
        <button class="btn btn-soft" type="button" data-manut="fechar">Fechar</button>
        ${link ? html`<a class="btn btn-primary" id="abrirAssistente" href="${link}">Abrir o assistente</a>` : ''}
      </div>
    </div>`);
    if (!dialogo.open) dialogo.showModal();
    ($('abrirAssistente') ?? dialogo.querySelector('[data-manut="fechar"]')).focus();
  }

  /**
   * Espera o assistente tomar o lugar do painel. O assistente responde `/` com um redirecionamento
   * para /configurar, e o painel nunca: sem seguir o redirecionamento, a resposta diz quem está na
   * porta, sem erro no console. Enquanto o painel responde, o comando pode ter recusado: as falhas
   * do log mais novas que o clique dizem isso.
   */
  async function esperarAssistente(inicio) {
    // Quem respondeu por último: no fim da espera, o texto muda se o painel nem chegou a parar.
    let painelNoAr = true;
    while (Date.now() - inicio < ESPERA_ASSISTENTE_MS) {
      await pausa(LEITURA_MS);
      let res;
      try {
        res = await fetch('/', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
      } catch { painelNoAr = false; continue; } // nem o painel nem o assistente: a troca está no meio
      if (res.type === 'opaqueredirect') return { assistente: true };
      painelNoAr = true;
      let estado;
      try { estado = await api.atualizacao(); } catch (err) {
        if (err.status === 401) return { sessaoPerdida: true };
        continue;
      }
      store.set({ atualizacao: estado });
      const r = estado.reconfiguracao;
      if (r?.motivos?.length && Date.parse(r.em) >= inicio) return { motivos: r.motivos };
    }
    return { esgotou: true, painelNoAr };
  }

  /**
   * Pede o assistente e entra nele sozinho, com o código no fragmento (não vai ao servidor nem ao
   * histórico: o assistente o tira do endereço). O código só existe nesta resposta e nesta aba.
   */
  async function reconfigurarAgora(el) {
    // Antes do pedido: o SSE "rodando" pode chegar antes da resposta.
    acompanhando = true;
    const inicio = Date.now();
    let codigo;
    try {
      ({ codigo } = await withBusy(el, api.iniciarReconfiguracao()));
    } catch (err) {
      acompanhando = false;
      // Sessão perdida: o login aparece, e ele não fura o diálogo.
      if (err.status === 401) dialogo.close();
      else abrirReconfigurar({ motivo: err.bloqueio, erro: err.message });
      return;
    }
    mount(dialogo, html`<div class="dialogo-corpo">
      <h2 id="novidadesTitulo">Abrindo o assistente</h2>
      <p class="registro-fase" id="reconfigurarFase" role="status"><span class="spinner"></span><span>O painel está parando para dar lugar ao assistente. Esta página entra nele sozinha em alguns segundos.</span></p>
    </div>`);
    const fim = await esperarAssistente(inicio);
    const link = `/configurar#codigo=${codigo}`;
    if (fim.assistente) { location.assign(link); return; }
    if (fim.sessaoPerdida) { acompanhando = false; dialogo.close(); return; }
    if (fim.motivos) { naoValeu({ titulo: 'A reconfiguração não começou', texto: NAO_VALEU.recusou, motivos: fim.motivos }); return; }
    naoValeu({
      titulo: 'O assistente não abriu',
      texto: fim.painelNoAr
        ? `O painel continua no ar, e o assistente não subiu. Se ele subir agora, este link entra nele. Se não, tente de novo daqui a 1 minuto ou rode no terminal, na pasta do painel: ${COMANDO_RECONFIGURAR}`
        : 'O assistente não respondeu a tempo. Se ele subir agora, este link entra nele. Se nada subir, o painel volta sozinho, com a configuração de agora, em até 15 minutos.',
      link,
    });
  }

  /** De volta do assistente: diz se a configuração nova valeu ou o motivo da volta. */
  async function atenderVolta() {
    await recarregarEstado();
    const r = store.get().atualizacao?.reconfiguracao;
    if (r?.motivos?.length && Date.now() - Date.parse(r.em) < VOLTA_RECENTE_MS) {
      naoValeu({ titulo: 'A reconfiguração não valeu', texto: NAO_VALEU.voltou, motivos: r.motivos });
    } else {
      toast('Painel reconfigurado. A coleta segue com a configuração nova.');
    }
  }

  /** Busca o estado de novo; se falhar, fica o que veio do SSE. */
  async function recarregarEstado() {
    try { store.set({ atualizacao: await api.atualizacao() }); } catch { /* painel fora do ar */ }
  }

  /** Mostra o resultado. Com a versão nova no ar, recarrega para carregar a interface dela. */
  function terminar(r, fase, acoes) {
    acompanhando = false;
    const textos = {
      atualizado: `Atualizado para ${r.alvo}. Recarregando a página…`,
      'ja-na-mais-nova': 'Você já está na versão mais nova.',
      voltou: `A versão ${r.alvo} não funcionou aqui. O painel voltou para a versão ${r.de}, com os dados de antes.`,
      falhou: 'A atualização parou. Veja o motivo no registro acima.',
      interrompida: 'A atualização foi interrompida antes de terminar. Rode `./dashboard diagnosticar` no terminal.',
    };
    $('novidadesTitulo').textContent = 'Fim da atualização';
    mount(fase, html`<span>${textos[r.resultado] ?? textos.falhou}</span>`);
    dialogo.dataset.resultado = r.resultado ?? 'falhou';
    if (r.resultado === 'atualizado') {
      mount(acoes, html`<button class="btn btn-primary" type="button" data-manut="recarregar" autofocus>Recarregar agora</button>`);
      setTimeout(() => location.reload(), RECARGA_MS);
    } else {
      mount(acoes, html`<button class="btn btn-primary" type="button" data-manut="fechar" autofocus>Fechar</button>`);
      recarregarEstado();
    }
    acoes.querySelector('button').focus();
  }

  /**
   * Progresso da atualização: lê o registro a cada 1 s. Leitura periódica sobrevive à queda do
   * painel no meio da troca, e o log continua de onde parou: ele fica fora de data/.
   */
  function acompanhar(alvo) {
    acompanhando = true;
    delete dialogo.dataset.resultado;
    mount(dialogo, html`<div class="dialogo-corpo">
      <h2 id="novidadesTitulo">Atualizando para ${alvo}</h2>
      <p class="registro-fase" id="registroFase" role="status"><span class="spinner"></span><span>${FASES.iniciando}</span></p>
      <pre class="registro mono" id="registroLog" tabindex="0"></pre>
      <div class="dialogo-acoes" id="registroAcoes"></div>
    </div>`);
    if (!dialogo.open) dialogo.showModal();
    const fase = $('registroFase');
    const log = $('registroLog');
    const mostrarFase = (texto) => { fase.lastElementChild.textContent = texto; };
    let desde = 0;
    let falhas = 0;
    const ler = async () => {
      let r;
      try {
        r = await api.registroAtualizacao(desde);
      } catch (err) {
        // Sessão perdida: o login aparece, e ele não fura o diálogo.
        if (err.status === 401) { acompanhando = false; dialogo.close(); return; }
        falhas += 1;
        mostrarFase(falhas > MAX_FALHAS ? 'O painel não voltou. Rode ./dashboard diagnosticar no terminal.' : REINICIANDO);
        setTimeout(ler, LEITURA_MS);
        return;
      }
      falhas = 0;
      if (r.texto) {
        log.textContent += r.texto;
        log.scrollTop = log.scrollHeight;
      }
      desde = r.proximo;
      if (r.fase === 'fim') { terminar(r, fase, $('registroAcoes')); return; }
      mostrarFase(FASES[r.fase] ?? FASES.iniciando);
      setTimeout(ler, LEITURA_MS);
    };
    ler();
  }

  /** Pede a troca da versão detectada. O bloqueio pode ter mudado: em 409, o diálogo se refaz. */
  async function atualizarAgora(el) {
    const { nova } = store.get().atualizacao || {};
    // Antes do pedido: o SSE "rodando" pode chegar antes da resposta.
    acompanhando = true;
    try {
      await withBusy(el, api.iniciarAtualizacao(nova));
    } catch (err) {
      acompanhando = false;
      toast(err.message, { level: 'warn' });
      await recarregarEstado();
      abrirNovidades();
      return;
    }
    acompanhar(nova);
  }

  // Atualização pedida em outra aba ou antes de recarregar a página: continua aqui. A do terminal
  // só trava o botão; ela não escreve o registro.
  async function retomar() {
    acompanhando = true;
    let r = null;
    try { r = await api.registroAtualizacao(0); } catch { /* o painel caiu: a próxima procura decide */ }
    if (r?.rodando && r.fase && r.fase !== 'fim') acompanhar(r.alvo);
    else acompanhando = false;
  }

  /** Conteúdo do menu: versão instalada, última procura, versão nova e "Procurar agora". */
  function renderMenu() {
    const a = store.get().atualizacao;
    mount(menu, html`<h2 class="manut-titulo">Manutenção</h2>
      <dl class="manut-dados">
        <div><dt>Versão instalada</dt><dd class="mono">${a?.instalada ?? '—'}</dd></div>
        <div><dt>Última procura</dt><dd>${a?.verificadoEm ? f.dateTime(a.verificadoEm) : 'ainda não houve'}</dd></div>
      </dl>
      ${ERROS[a?.erro] ? html`<p class="manut-erro">${ERROS[a.erro]}</p>` : ''}
      ${a?.nova ? html`<button class="btn btn-soft btn-block" type="button" data-manut="novidades">Ver novidades da ${a.nova}</button>` : ''}
      <button class="btn btn-soft btn-block" type="button" data-manut="procurar">Procurar agora</button>
      <button class="btn btn-soft btn-block" type="button" data-manut="reconfigurar">Reconfigurar</button>`);
  }

  /** Aviso no topo e ponto na engrenagem, conforme o estado. */
  function render() {
    const a = store.get().atualizacao;
    botao.classList.toggle('tem-novidade', Boolean(a?.nova));
    botao.setAttribute('aria-label', a?.nova ? `Manutenção do painel: versão ${a.nova} disponível` : 'Manutenção do painel');
    const mostrar = Boolean(a?.nova) && lerDispensada() !== a.nova;
    aviso.hidden = !mostrar;
    if (mostrar) {
      mount(aviso, html`${icon('download', 16)}<span>Versão <b class="mono">${a.nova}</b> disponível${a.exigeReconfigurar ? ' · exige reconfigurar o acesso ao servidor' : ''}</span>
        <button class="btn-link" type="button" data-manut="novidades">Ver novidades</button>
        <button class="icon-btn aviso-fechar" type="button" data-manut="dispensar" aria-label="Fechar o aviso da versão ${a.nova}">${icon('fechar', 14)}</button>`);
    }
    if (!menu.hidden) renderMenu();
    if (a?.bloqueio === 'rodando' && !acompanhando) retomar();
  }

  async function procurarAgora(el) {
    try {
      const estado = await withBusy(el, api.verificarAtualizacao());
      store.set({ atualizacao: estado });
      if (estado.erro) toast(ERROS[estado.erro] ?? 'A procura falhou', { level: 'warn' });
      else toast(estado.nova ? `Versão ${estado.nova} disponível` : 'Você está na versão mais nova');
    } catch (err) { toast(err.message, { level: 'warn' }); }
  }

  // Cliques do menu e do aviso: as ações vêm do atributo, e os dois são redesenhados à vontade.
  function onAcao(e) {
    const el = e.target.closest('[data-manut]');
    if (!el) return;
    const acao = el.dataset.manut;
    if (acao === 'novidades') abrirNovidades();
    else if (acao === 'procurar') procurarAgora(el);
    else if (acao === 'atualizar') atualizarAgora(el);
    else if (acao === 'reconfigurar') abrirReconfigurar();
    else if (acao === 'reconfigurar-agora') reconfigurarAgora(el);
    else if (acao === 'recarregar') location.reload();
    else if (acao === 'fechar') { acompanhando = false; dialogo.close(); }
    else if (acao === 'dispensar') { gravarDispensada(store.get().atualizacao?.nova); render(); }
  }

  async function abrirMenu() {
    renderMenu();
    menu.hidden = false;
    botao.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
    await recarregarEstado();
  }

  // Quem pediu pelo terminal quer a versão de agora, não a da última procura. A trava de 1 por
  // minuto só deixa o estado como está; a retomada de uma troca em andamento tem a preferência.
  async function atenderTerminal() {
    await abrirMenu();
    await procurarAgora(menu.querySelector('[data-manut="procurar"]'));
    if (!acompanhando) abrirNovidades();
  }

  botao.addEventListener('click', () => { if (menu.hidden) abrirMenu(); else fecharMenu(); });
  menu.addEventListener('click', onAcao);
  aviso.addEventListener('click', onAcao);
  dialogo.addEventListener('click', onAcao);
  // Durante a troca, o Esc não fecha: o resultado e a recarga precisam aparecer. Na espera do
  // assistente, também não: a espera tem fim, e ele traz o Fechar.
  dialogo.addEventListener('cancel', (e) => { if (acompanhando) e.preventDefault(); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.manut')) fecharMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { fecharMenu(); botao.focus(); }
  });
  store.subscribe((_, mudou) => { if ('atualizacao' in mudou) render(); });
  render();
  if (pedidoDoTerminal) atenderTerminal();
  else if (voltaDoAssistente) atenderVolta();
}
