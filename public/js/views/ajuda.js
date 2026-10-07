// 8. Ajuda: guia em linguagem simples, atalhos, configuração ativa (só leitura, sem
// segredos), versão e sessão.
import { html, mount } from '../core/html.js';
import * as f from '../core/format.js';
import { VIEWS } from '../core/router.js';
import { $ } from './common.js';

function config(c) {
  if (!c) return html`<p class="empty">Carregando configuração…</p>`;
  const row = (k, v, varName) => html`<tr><td>${k}</td><td><b>${v}</b></td><td><code>${varName}</code></td></tr>`;
  const t = c.thresholds || {};
  const list = (a) => (a && a.length ? a.join(' ') : '—');
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Item</th><th>Valor</th><th>Variável no .env</th></tr></thead>
    <tbody>
      ${row('Servidor (alias SSH)', c.sshHost, 'SSH_HOST')}
      ${row('Intervalo de coleta', f.duration(c.pollIntervalMs / 1000), 'POLL_INTERVAL')}
      ${row('Interface de rede', c.targets?.netIf || '—', 'NET_IF')}
      ${row('Pontos de montagem', list(c.targets?.mounts), 'DISK_MOUNTS')}
      ${row('Discos (I/O e SMART)', list(c.targets?.devs), 'DISK_DEVS')}
      ${row('Serviços', list(c.targets?.services), 'SERVICES')}
      ${row('Alerta de disco', f.pct(t.diskPct), 'ALERT_DISK_PCT')}
      ${row('Alerta de RAM', f.pct(t.ramPct), 'ALERT_RAM_PCT')}
      ${row('Alerta de temperatura', f.celsius(t.tempC), 'ALERT_TEMP_C')}
      ${row('Histerese', `${t.hysteresis}`, 'ALERT_HYSTERESIS')}
      ${row('Falhas até "inacessível"', `${t.offlineAfter}`, 'ALERT_OFFLINE_AFTER')}
    </tbody></table></div>
    <p class="hint">Para mudar, edite o <code>.env</code> na pasta do painel e reinicie. A tela não grava configuração (mais seguro).</p>
    <p class="hint">Versão ${c.version?.app} · amostra v${c.version?.schema} · coletor v${c.version?.collector}${c.collector?.hashMismatch ? ' · ⚠ comando do servidor desatualizado' : ''}</p>`;
}

export function render(ctx) {
  const session = ctx.state.session;
  mount(ctx.el, html`
    <section class="panel help">
      <h3 class="panel-title">Como usar</h3>
      <p>O painel lê o servidor <b>1 vez por minuto</b>, por SSH, só leitura. Nada é instalado nem gravado no servidor.
      Os dados ficam neste computador, em <code>data/</code> (72 h detalhadas e 90 dias resumidos).</p>
      <ul>
        <li><b>Visão geral</b> diz em uma frase se está tudo bem e por quê.</li>
        <li><b>Recursos</b>, <b>Armazenamento</b> e <b>Rede</b> mostram gráficos: arraste para aproximar um trecho, use a roda do mouse para zoom e clique duas vezes para voltar.</li>
        <li><b>Eventos</b> junta alertas, quedas e anotações. Anote manutenções ("troquei o disco") para entender os gráficos depois.</li>
        <li>Alertas só disparam no limiar e só se resolvem quando o valor cai abaixo dele com folga (sem piscar).</li>
      </ul>
      <p>Iniciar: <code>./start.sh</code> · Parar: <code>./stop.sh</code> · Guia completo: <code>TUTORIAL.md</code> na pasta do painel.</p>
    </section>
    <section class="panel">
      <h3 class="panel-title">Atalhos de teclado</h3>
      <div class="table-wrap"><table><tbody>
        ${VIEWS.map((v) => html`<tr><td><kbd>${v.key}</kbd></td><td>${v.title}</td></tr>`)}
        <tr><td><kbd>C</kbd></td><td>Coletar agora</td></tr>
        <tr><td><kbd>T</kbd></td><td>Tema claro/escuro</td></tr>
        <tr><td><kbd>N</kbd></td><td>Nova anotação</td></tr>
        <tr><td><kbd>/</kbd></td><td>Buscar processo</td></tr>
        <tr><td><kbd>?</kbd></td><td>Esta ajuda</td></tr>
      </tbody></table></div>
    </section>
    <section class="panel"><h3 class="panel-title">Configuração ativa</h3><div id="aj-config"></div></section>
    ${session?.authRequired ? html`<section class="panel">
      <h3 class="panel-title">Sessão</h3>
      <p>O acesso fica guardado neste navegador por 30 dias (renovado com o uso).</p>
      <p class="toolbar"><button class="btn-ghost" id="aj-logout">Sair deste navegador</button>
      <button class="btn-ghost" id="aj-logout-all">Encerrar todas as sessões</button></p>
    </section>` : ''}`);
  $('#aj-logout', ctx.el)?.addEventListener('click', () => ctx.act.logout(false));
  $('#aj-logout-all', ctx.el)?.addEventListener('click', () => ctx.act.logout(true));
  update(ctx);
}

export function update(ctx) {
  mount($('#aj-config', ctx.el), config(ctx.state.config));
}
