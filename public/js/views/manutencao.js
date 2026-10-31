// Manutenção do painel (ADR 0030): a engrenagem no topo com a versão instalada e "Procurar
// agora", o aviso de versão nova e o diálogo com as novidades. Não é uma tela: fica por cima de
// todas. Só mostra e procura; a troca de versão continua no terminal.
import { api } from '../core/api.js';
import { html, mount } from '../core/html.js';
import { blocosDeNovidade } from '../core/novidades.js';
import * as f from '../core/format.js';
import { icon, withBusy } from './common.js';

// Versão cujo aviso foi fechado neste navegador: ela só volta a aparecer no menu.
const DISPENSADA_KEY = 'dash_versao_dispensada';
const COMANDO = './dashboard atualizar';
// Por que o comando do terminal vai parar, para dizer antes de a pessoa tentar.
const BLOQUEIOS = {
  'arquivos-alterados': 'Há arquivos do painel alterados nesta pasta. Guarde ou desfaça as alterações antes de atualizar.',
  'sem-git': 'Esta pasta não veio de um git clone. Instale de novo pelo comando do README.',
  'outra-pasta': 'Este painel não roda da pasta da instalação. Rode o comando na pasta da instalação.',
};
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

  const fecharMenu = () => {
    menu.hidden = true;
    botao.setAttribute('aria-expanded', 'false');
  };

  /** O diálogo com as novidades da versão nova e o comando para atualizar. */
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
      <p class="dialogo-comando">Para atualizar, rode no terminal, na pasta do painel: <span class="mono">${COMANDO}</span></p>
      <div class="dialogo-acoes"><button class="btn btn-primary" type="submit" autofocus>Fechar</button></div>
    </form>`);
    dialogo.showModal();
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
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.manut')) fecharMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { fecharMenu(); botao.focus(); }
  });
  store.subscribe((_, mudou) => { if ('atualizacao' in mudou) render(); });
  render();
}
