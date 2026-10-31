// Manutenção do painel (ADR 0030): a engrenagem no topo com a versão instalada e "Procurar
// agora", o aviso de versão nova, o diálogo com as novidades e o botão Atualizar, com o progresso
// (ADR 0031). Não é uma tela: fica por cima de todas. A tela só pede a troca da versão detectada:
// quem troca é o `dashboard atualizar --registro`, fora do serviço (I11).
import { api } from '../core/api.js';
import { html, mount } from '../core/html.js';
import { blocosDeNovidade } from '../core/novidades.js';
import * as f from '../core/format.js';
import { icon, withBusy } from './common.js';

// Versão cujo aviso foi fechado neste navegador: ela só volta a aparecer no menu.
const DISPENSADA_KEY = 'dash_versao_dispensada';
const COMANDO = './dashboard atualizar';
// Leitura do progresso: a cada 1 s, e até ~3 min de painel fora do ar antes de sugerir o terminal.
const LEITURA_MS = 1000;
const MAX_FALHAS = 180;
const RECARGA_MS = 3000;
// Por que não dá para atualizar, para dizer antes de a pessoa tentar.
const BLOQUEIOS = {
  'sem-login': 'Este painel não tem login. Sem sessão, o botão ficaria aberto a qualquer programa desta máquina.',
  rodando: 'Já há uma atualização rodando nesta pasta.',
  'arquivos-alterados': 'Há arquivos do painel alterados nesta pasta. Guarde ou desfaça as alterações antes de atualizar.',
  'sem-git': 'Esta pasta não veio de um git clone. Instale de novo pelo comando do README.',
  'outra-pasta': 'Este painel não roda da pasta da instalação. Rode o comando na pasta da instalação.',
};
const FASES = {
  iniciando: 'Iniciando a atualização…',
  procurando: 'Conferindo a versão e a assinatura…',
  trocando: 'Copiando os dados e trocando de versão…',
  ligando: 'Ligando a versão nova…',
  voltando: 'A versão nova falhou. Voltando para a anterior…',
};
const REINICIANDO = 'Reiniciando o painel…';
const ERROS = {
  'sem-acesso': 'Sem acesso ao GitHub na última procura. Tento de novo amanhã.',
  falhou: 'A última procura falhou. Tento de novo amanhã.',
};
const $ = (id) => document.getElementById(id);

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

/** Liga o menu, o aviso e o diálogo ao estado `atualizacao` do `store`. */
export function iniciarManutencao({ store, toast }) {
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
    const { nova, novidades, bloqueio } = store.get().atualizacao || {};
    if (!nova) return;
    fecharMenu();
    mount(dialogo, html`<form method="dialog" class="dialogo-corpo">
      <h2 id="novidadesTitulo">Novidades da ${nova}</h2>
      <div class="novidades" tabindex="0">
        ${novidades?.secoes?.length ? novidades.secoes.map(secao) : html`<p>As novidades desta versão não estão disponíveis aqui.</p>`}
        ${novidades?.cortado ? html`<p class="novidades-corte">O texto é longo. O restante está no CHANGELOG da versão.</p>` : ''}
      </div>
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
      <button class="btn btn-soft btn-block" type="button" data-manut="procurar">Procurar agora</button>`);
  }

  /** Aviso no topo e ponto na engrenagem, conforme o estado. */
  function render() {
    const a = store.get().atualizacao;
    botao.classList.toggle('tem-novidade', Boolean(a?.nova));
    botao.setAttribute('aria-label', a?.nova ? `Manutenção do painel: versão ${a.nova} disponível` : 'Manutenção do painel');
    const mostrar = Boolean(a?.nova) && lerDispensada() !== a.nova;
    aviso.hidden = !mostrar;
    if (mostrar) {
      mount(aviso, html`${icon('download', 16)}<span>Versão <b class="mono">${a.nova}</b> disponível</span>
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
    else if (acao === 'recarregar') location.reload();
    else if (acao === 'fechar') dialogo.close();
    else if (acao === 'dispensar') { gravarDispensada(store.get().atualizacao?.nova); render(); }
  }

  botao.addEventListener('click', async () => {
    if (!menu.hidden) { fecharMenu(); return; }
    renderMenu();
    menu.hidden = false;
    botao.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
    try { store.set({ atualizacao: await api.atualizacao() }); } catch { /* fica o que veio do SSE */ }
  });
  menu.addEventListener('click', onAcao);
  aviso.addEventListener('click', onAcao);
  dialogo.addEventListener('click', onAcao);
  // Durante a troca, o Esc não fecha: o resultado e a recarga precisam aparecer.
  dialogo.addEventListener('cancel', (e) => { if (acompanhando) e.preventDefault(); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.manut')) fecharMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { fecharMenu(); botao.focus(); }
  });
  store.subscribe((_, mudou) => { if ('atualizacao' in mudou) render(); });
  render();
}
