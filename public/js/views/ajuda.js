// 8. Ajuda (prancheta "V2 · Ajuda"): o que fazer em cada alerta, como ler o painel, atalhos,
// configuração ativa (só leitura, sem segredos), acesso ao servidor (chave restrita e sudo do
// SMART, com a linha do sudoers pronta para copiar), versões e sessão.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { $, icon, iconBox, panelHead } from './common.js';

export const sub = () => 'Como ler o painel, o que fazer em cada alerta e como ele está configurado';

const TUTORIAL = 'https://github.com/tsouza-thiago/linux-server-dashboard-v2/blob/main/TUTORIAL.md';
export const actions = () => html`<a class="btn btn-surface" href="${TUTORIAL}" target="_blank" rel="noopener noreferrer">Abrir o tutorial completo <span class="ink-3 mono">TUTORIAL.md</span></a>`;

function whatToDo(t) {
  const row = (level, ic, title, text) => html`<div class="help-row">${iconBox(level, ic)}<div><span class="help-title">${title}</span><span class="help-text">${text}</span></div></div>`;
  return html`
    ${panelHead('O que fazer em cada alerta')}
    ${row('warn', 'warn', `Disco acima de ${f.pct(t.diskPct)}`, 'Libere espaço ou mova arquivos. Veja em Armazenamento quando ele enche no ritmo atual.')}
    ${row('warn', 'warn', `Memória acima de ${f.pct(t.ramPct)} · temperatura acima de ${f.celsius(t.tempC)}`, 'Veja quem consome em Processos. Para calor: ventilação, poeira e pasta térmica.')}
    ${row('crit', 'crit', 'SMART diferente de PASSED', html`<b>Faça backup agora.</b> O disco avisou que pode falhar.`)}
    ${row('crit', 'outage', 'Servidor inacessível · serviço parado', 'Confira se o servidor está ligado e na rede. O painel tenta de novo a cada coleta e se recupera sozinho.')}`;
}

function howToRead() {
  const k = (x) => html`<kbd>${x}</kbd>`;
  const sw = (c) => html`<span class="swatch c-${c}"></span>`;
  return html`
    ${panelHead('Como ler o painel')}
    <div class="help-read">
      <span><b>Saúde 0–100</b> — começa em 100 e perde pontos a cada problema; o motivo aparece logo ao lado do número.</span>
      <span><b>Cores fixas</b> — ${sw('s1')} ciano é processador, ${sw('s2')} violeta é memória, ${sw('s3')} magenta é disco, ${sw('s4')} azul é temperatura, em todas as telas.</span>
      <span><b>Status</b> — sempre com ícone e texto: <span class="ink-ok">${icon('check', 12, 3)} saudável</span>, <span class="ink-warn">${icon('warn', 12, 2.5)} atenção</span>, <span class="ink-crit">${icon('crit', 12, 2.5)} crítico</span>.</span>
      <span><b>Gráficos</b> — roda do mouse dá zoom, arrastar seleciona um intervalo, duplo clique volta ao período inteiro.</span>
    </div>
    <h3>Atalhos de teclado</h3>
    <div class="shortcuts">
      <span>${k('1')}–${k('8')} trocar de tela</span><span>${k('C')} coletar agora</span>
      <span>${k('T')} tema claro/escuro</span><span>${k('N')} nova anotação</span>
      <span>${k('/')} buscar processo</span><span>${k('?')} esta tela</span>
    </div>`;
}

function config(state) {
  const c = state.config;
  if (!c) return html`<p class="empty">Carregando configuração…</p>`;
  const t = c.thresholds || {};
  const list = (a) => (a && a.length ? a.join(' ') : '—');
  const row = (k, v, varName) => html`<tr><th scope="row">${k}</th><td class="num mono">${v}${varName ? html` <span class="ink-3">${varName}</span>` : ''}</td></tr>`;
  const r = c.retention;
  return html`<table class="table kv-table"><tbody>
    ${row('Servidor', c.sshHost, 'SSH_HOST')}
    ${row('Coleta', `a cada ${f.duration(c.pollIntervalMs / 1000)}`, 'POLL_INTERVAL')}
    ${row('Rede', c.targets?.netIf || '—', 'NET_IF')}
    ${row('Pontos de montagem', list(c.targets?.mounts), 'DISK_MOUNTS')}
    ${row('Discos', list(c.targets?.devs), 'DISK_DEVS')}
    ${row('Serviços', list(c.targets?.services), 'SERVICES')}
    ${row('Limiares', `disco ${f.pct(t.diskPct)} · RAM ${f.pct(t.ramPct)} · temp ${f.celsius(t.tempC)}`)}
    ${row('Histerese e queda', `${t.hysteresis} · inacessível após ${t.offlineAfter} falha${t.offlineAfter > 1 ? 's' : ''}`)}
    ${row('Histórico', r ? `${r.rawHours} h bruto · ${r.rollupDays} d agregado` : '—')}
    ${row('Token de acesso', state.session?.authRequired ? 'definido' : 'não definido', state.session?.authRequired ? '(nunca exibido)' : '')}
  </tbody></table>`;
}

function access(state) {
  const c = state.config;
  const s = state.sample;
  const devs = c?.targets?.devs || [];
  const smart = s?.smart || [];
  const ok = (text) => html`<span class="status-ink ink-ok">${icon('check', 14, 3)}${text}</span>`;
  const warn = (text) => html`<span class="status-ink ink-warn">${icon('warn', 14, 2.5)}${text}</span>`;
  const hm = s?.collector?.hashMismatch;
  const allowed = smart.filter((x) => x.status === 'PASSED' || x.status === 'FAILED').map((x) => x.dev);
  const denied = smart.filter((x) => x.status === 'SEM_PERMISSAO').map((x) => x.dev);
  const line = devs.length ? `dashmon ALL=(root) NOPASSWD: ${devs.map((d) => `/usr/sbin/smartctl -H /dev/${d}`).join(', ')}` : '';
  const v = c?.version || {};
  const exp = state.session?.expiresAt ? Math.max(0, Math.round((Date.parse(state.session.expiresAt) - Date.now()) / 86400e3)) : null;
  return html`
    ${panelHead('Acesso ao servidor')}
    <div class="kv-list">
      <div class="kv"><span class="ink-2">Comando de coleta no servidor</span>${!s ? html`<span class="ink-3">aguardando coleta</span>` : hm ? warn('desatualizado') : ok('em dia')}</div>
      ${allowed.length ? html`<div class="kv"><span class="ink-2">SMART via sudo · ${allowed.join(', ')}</span>${ok('liberado')}</div>` : ''}
      ${denied.length ? html`<div class="kv"><span class="ink-2">SMART via sudo · ${denied.join(', ')}</span>${warn('falta a linha')}</div>` : ''}
      ${!devs.length ? html`<div class="kv"><span class="ink-2">SMART</span><span class="ink-3">nenhum disco em DISK_DEVS</span></div>` : ''}
    </div>
    ${line ? html`<div class="field">
      <span class="note">Cole no servidor com <span class="mono">sudo visudo -f /etc/sudoers.d/dashboard</span> (troque <span class="mono">dashmon</span> pelo usuário SSH, se for outro):</span>
      <pre class="code" id="aj-sudo">${line}</pre>
      <button class="btn btn-soft btn-sm align-start" type="button" id="aj-copy">${icon('copy', 14)} Copiar linha</button>
    </div>` : ''}
    <div class="chips sep">
      <span class="chip mono">painel v${v.app || '—'}</span>
      <span class="chip mono">coletor v${v.collector || '—'}${s?.collector?.hash ? ` · ${s.collector.hash.slice(0, 6)}` : ''}</span>
      <span class="chip mono">formato da amostra ${v.schema || '—'}</span>
      ${c?.runtime?.node ? html`<span class="chip mono">Node ${c.runtime.node.split('.')[0]}</span>` : ''}
    </div>
    ${state.session?.authRequired ? html`<div class="session-row">
      <span class="note">${exp === null ? 'Sessão deste navegador ativa' : `Sessão neste navegador expira em ${exp} dia${exp === 1 ? '' : 's'}`}</span>
      <button class="btn btn-sm" type="button" id="aj-logout">Sair</button>
      <button class="btn btn-sm btn-danger" type="button" id="aj-logout-all">Encerrar todas as sessões</button>
    </div>` : ''}`;
}

export function render(ctx) {
  mount(ctx.el, html`
    <div class="grid-2">
      <section class="panel" aria-label="O que fazer em cada alerta" id="aj-todo"></section>
      <section class="panel" aria-label="Como ler o painel">${howToRead()}</section>
    </div>
    <div class="grid-2">
      <section class="panel flush" aria-label="Configuração ativa">
        <div class="panel-head"><div><h2>Configuração ativa</h2><span class="hint">somente leitura · para mudar, edite o <span class="mono">.env</span> e reinicie o painel</span></div></div>
        <div id="aj-config"></div>
      </section>
      <section class="panel" aria-label="Acesso ao servidor e versão" id="aj-access"></section>
    </div>`);
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'aj-logout') ctx.act.logout(false);
    else if (b.id === 'aj-logout-all') ctx.act.logout(true);
    else if (b.id === 'aj-copy') {
      const text = $('#aj-sudo', ctx.el)?.textContent || '';
      try { await navigator.clipboard.writeText(text); ctx.act.toast('Linha copiada'); } catch {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents($('#aj-sudo', ctx.el));
        sel.removeAllRanges();
        sel.addRange(range);
        ctx.act.toast('Linha selecionada: copie com Ctrl+C', { level: 'warn' });
      }
    }
  });
  update(ctx);
}

export function update(ctx) {
  const t = ctx.state.meta?.thresholds || ctx.state.config?.thresholds || {};
  mount($('#aj-todo', ctx.el), whatToDo(t));
  mount($('#aj-config', ctx.el), config(ctx.state));
  mount($('#aj-access', ctx.el), access(ctx.state));
}
