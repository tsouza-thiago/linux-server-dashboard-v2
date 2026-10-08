// Assistente de instalação no navegador (D10): os 6 passos das pranchetas "Instalação ·
// Passo 1–6". Cada passo chama /api/configurar/* (server/setup/web.js), que usa os mesmos
// métodos da TUI (server/setup/instalacao.js). Toda interpolação passa pelo `html` com
// escape; nada de style="" (CSP).
import { html, raw, mount } from '../core/html.js';

const THEME_KEY = 'dash_theme';
const $ = (id) => document.getElementById(id);
const root = $('wz-main');

const ICON = {
  check: '<polyline points="5 12 10 17 19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  list: '<path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
const icon = (name, size = 14, stroke = 3) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`);

// ---------------- Estado ----------------
const st = {
  gate: false,
  gateError: '',
  step: 1,
  busy: false,
  error: '',
  field: '',
  computer: null,
  passos: ['Boas-vindas', 'Servidor', 'Conectar', 'O que monitorar', 'Preparar servidor', 'Pronto'],
  form: { host: '', user: '', port: '22' },
  reach: null,
  ident: null,
  confirm: false,
  showPass: false,
  det: null,
  ch: null,
  lim: { diskPct: 90, ramPct: 90, tempC: 60 },
  cost: null,
  allServices: false,
  plan: null,
  mode: 'assistido',
  prep: { state: 'revisar', feitos: [], error: '', precisaSenha: false },
  manual: { tests: {}, errors: {}, busy: '' },
  result: null,
  prefs: { boot: true, shortcut: true, notify: false },
  token: '',
  opening: false,
  pastHelp: false,
};

// ---------------- API ----------------
async function api(path, body) {
  const opts = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/configurar/${path}`, opts);
  let data = null;
  try { data = await res.json(); } catch { /* sem JSON */ }
  if (res.status === 401 && data && data.codigo) { st.gate = true; render(); }
  if (!res.ok) {
    const err = new Error((data && data.error) || `erro ${res.status}`);
    err.field = data && data.field;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function run(fn) {
  st.busy = true;
  st.error = '';
  st.field = '';
  render();
  try {
    await fn();
  } catch (err) {
    st.error = err.message;
    st.field = err.field || '';
  } finally {
    st.busy = false;
    render();
  }
}

function go(step) {
  st.step = step;
  st.error = '';
  st.field = '';
  render();
  const h = root.querySelector('h1');
  if (h) h.focus();
  window.scrollTo({ top: 0 });
  $('wzLive').textContent = `Passo ${step} de 6: ${st.passos[step - 1]}`;
}

// ---------------- Pedaços comuns ----------------
const fmtBytes = (b) => {
  if (!Number.isFinite(b) || b <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${u[i]}`;
};
const fmtSec = (s) => String(s).replace('.', ',');

function stepsBar() {
  return html`<ol class="wz-steps" aria-label="Passos da configuração">${st.passos.map((nome, i) => {
    const n = i + 1;
    const done = n < st.step;
    const cur = n === st.step;
    return html`<li class="${done ? 'is-done' : ''}" aria-current="${cur ? 'step' : 'false'}">
      <span class="wz-step-mark">${done ? icon('check', 14, 3.2) : n}</span>
      <span class="wz-step-text"><span class="wz-step-name">${nome}</span><span class="wz-step-state">${done ? 'concluído' : cur ? 'agora' : ''}</span></span>
      <span class="wz-step-rail"></span>
    </li>`;
  })}</ol>`;
}

function meta() {
  const el = $('wzMeta');
  el.className = 'wz-meta';
  if (st.gate) { el.textContent = ''; return; }
  if (st.step === 4 && st.det) {
    el.className = 'wz-meta is-ok';
    mount(el, html`<span class="wz-dot"></span>conectado a ${st.det.servidor.host} como ${st.det.usuario} · ${st.det.sudoTexto}`);
    return;
  }
  el.textContent = st.step === 1 ? 'passo 1 de 6 · cerca de 5 minutos' : st.step === 6 ? 'tudo pronto' : `passo ${st.step} de 6`;
}

const alertBox = (msg, warn = false) => (msg ? html`<div class="wz-alert ${warn ? 'is-warn' : ''}" role="alert">${icon('alert', 16, 2.2)}<span>${msg}</span></div>` : '');
const back = (to) => html`<button type="button" class="wz-back" data-go="${to}">← Voltar</button>`;
const next = (label, act, { disabled = false, big = false } = {}) => html`<button type="button" class="wz-next ${big ? 'big' : ''}" data-act="${act}" ${disabled || st.busy ? raw('disabled') : ''}>${st.busy ? 'Aguarde…' : label}${st.busy ? '' : raw(' <span aria-hidden="true">→</span>')}</button>`;

// ---------------- Passo 0: código de uso único ----------------
function viewGate() {
  return html`<main class="wz-card md wz-gate">
    <div class="wz-title"><h1 class="wz-h1 sm" tabindex="-1">Digite o código do terminal</h1>
    <p class="wz-lead sm">Por segurança, o assistente só abre com o código de uso único que o <span class="mono">./dashboard instalar</span> mostrou no terminal.</p></div>
    <form class="wz-field" data-form="gate">
      <label for="codigo">Código de uso único</label>
      <input id="codigo" class="wz-input ${st.gateError ? 'is-invalid' : ''}" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABC-123" ${st.gateError ? raw('aria-invalid="true" aria-describedby="codigoErr"') : ''}>
      ${st.gateError ? html`<span class="wz-hint is-err" id="codigoErr">${st.gateError}</span>` : html`<span class="wz-hint">vale uma vez, por 30 minutos</span>`}
      <div class="wz-foot"><span class="grow"></span><button class="wz-next" type="submit">Entrar <span aria-hidden="true">→</span></button></div>
    </form>
  </main>`;
}

async function enterCode(code) {
  try {
    await api('entrar', { codigo: code });
    st.gate = false;
    st.gateError = '';
    await loadState();
  } catch (err) {
    st.gate = true;
    st.gateError = err.message;
    render();
  }
}

// ---------------- Passo 1 ----------------
function viewStep1() {
  const c = st.computer;
  const chip = (item, text) => html`<span class="wz-chk ${item && item.ok ? '' : 'is-warn'}">${icon(item && item.ok ? 'check' : 'alert', 12, 3)}${text}</span>`;
  return html`<main class="wz-card">
    <div class="wz-title">
      <h1 class="wz-h1" tabindex="-1">${c && c.reconfigurar ? 'Vamos revisar a ligação com o seu servidor' : 'Vamos ligar o painel ao seu servidor'}</h1>
      <p class="wz-lead">Em poucos passos este computador passa a acompanhar o seu servidor Linux, 1 vez por minuto, sem instalar nada nele. Você pode voltar a qualquer passo antes de confirmar.</p>
    </div>
    <div class="wz-tiles">
      <section class="wz-tile"><h2><span class="wz-ico ok">${icon('check')}</span>O que vamos fazer</h2>
        <ul class="wz-list"><li>Criar uma chave de acesso só para o painel</li><li>Preparar no servidor um usuário que só consegue <b>ler</b> informações</li><li>Descobrir sozinhos seus discos, rede e serviços</li><li>Deixar o painel iniciando com o computador</li></ul></section>
      <section class="wz-tile"><h2><span class="wz-ico crit">${icon('x')}</span>O que nunca fazemos</h2>
        <ul class="wz-list"><li>Instalar programas no servidor</li><li>Guardar a senha do servidor</li><li>Pedir senha de administrador neste computador</li><li>Abrir o painel para a rede: ele só existe aqui</li></ul></section>
      <section class="wz-tile"><h2><span class="wz-ico accent">${icon('list', 14, 2.4)}</span>Tenha em mãos</h2>
        <ul class="wz-list"><li>O endereço do servidor <span class="ink-3">(ex.: 192.0.2.10)</span></li><li>Um usuário do servidor que possa usar <span class="mono">sudo</span></li><li>A senha desse usuário <span class="ink-3">(usada uma vez)</span></li><li>O servidor ligado e na mesma rede</li></ul></section>
    </div>
    ${st.pastHelp ? html`<div class="wz-tip">Já tem chave SSH para o servidor? No passo 3, deixe a senha em branco: usamos a sua chave. Vindo da V1? Pare a V1 e rode no terminal <span class="mono">./dashboard instalar --importar-v1 /pasta/da/v1</span>: o histórico e as configurações vêm junto.</div>` : ''}
    <section class="wz-checks" aria-label="Verificações deste computador">
      ${c ? [chip(c.versao, c.versao.texto), chip(c.node, c.node.texto), chip(c.ssh, c.ssh.ok ? c.ssh.texto : 'falta o SSH (openssh-client)'), chip(c.local, c.local.texto)] : ''}
    </section>
  </main>
  <footer class="wz-foot">
    <button type="button" class="wz-linkbtn" data-act="pastHelp" aria-expanded="${st.pastHelp}">Já configurei um servidor antes</button>
    <span class="grow"></span>
    <button type="button" class="wz-next" data-go="2" ${c && !c.ssh.ok ? raw('disabled') : ''}>Começar <span aria-hidden="true">→</span></button>
  </footer>`;
}

// ---------------- Passo 2 ----------------
function viewStep2() {
  const f = st.form;
  const inv = (name) => (st.field === name ? raw(`aria-invalid="true" aria-describedby="${name}Err"`) : '');
  return html`<div class="wz-cols">
    <main class="wz-card md">
      <div class="wz-title"><h1 class="wz-h1 sm" tabindex="-1">Qual é o seu servidor?</h1>
        <p class="wz-lead sm">Informe o endereço e um usuário que você já usa para entrar nele. Esse usuário só serve para preparar o acesso; o painel vai usar um usuário próprio, sem poderes.</p></div>
      <form class="wz-body" data-form="servidor" novalidate>
        <div class="wz-field">
          <label for="host">Endereço do servidor</label>
          <input id="host" name="host" class="wz-input ${st.reach ? 'is-ok' : st.field === 'host' ? 'is-invalid' : ''}" value="${f.host}" autocomplete="off" spellcheck="false" placeholder="192.0.2.10" ${inv('host')}>
          ${st.field === 'host' ? html`<span class="wz-hint is-err" id="hostErr">${st.error}</span>`
    : st.reach ? html`<span class="wz-hint is-ok">${icon('check', 13)}encontrado na rede · respondeu em ${st.reach.ms} ms · porta ${st.reach.port} aberta</span>` : ''}
        </div>
        <div class="wz-field">
          <label for="user">Seu usuário no servidor</label>
          <input id="user" name="user" class="wz-input ${st.field === 'user' ? 'is-invalid' : ''}" value="${f.user}" autocomplete="username" spellcheck="false" ${inv('user')}>
          ${st.field === 'user' ? html`<span class="wz-hint is-err" id="userErr">${st.error}</span>` : html`<span class="wz-hint">precisa poder usar <span class="mono">sudo</span> · se você entra como <span class="mono">root</span>, escreva root</span>`}
        </div>
        <details class="wz-adv" ${f.port !== '22' || st.field === 'port' ? raw('open') : ''}>
          <summary>Opções avançadas · porta SSH (padrão 22)</summary>
          <div><label for="port">Porta</label><input id="port" name="port" class="wz-input sm ${st.field === 'port' ? 'is-invalid' : ''}" inputmode="numeric" value="${f.port}" ${inv('port')}>
          ${st.field === 'port' ? html`<span class="wz-hint is-err" id="portErr">${st.error}</span>` : ''}</div>
        </details>
        ${st.error && !['host', 'user', 'port'].includes(st.field) ? alertBox(st.error) : ''}
        <button type="submit" hidden></button>
      </form>
    </main>
    <aside class="wz-aside" aria-label="Como descobrir o endereço">
      <h2>Não sabe o endereço?</h2>
      <div class="wz-help"><span class="wz-num">1</span><span>No próprio servidor, digite <span class="mono">hostname -I</span>. O primeiro número é o endereço.</span></div>
      <div class="wz-help"><span class="wz-num">2</span><span>Ou veja a lista de aparelhos conectados na página do seu roteador.</span></div>
      <div class="wz-help"><span class="wz-num">3</span><span>Se o servidor tem nome na rede, ele também vale, por exemplo <span class="mono">meu-servidor.local</span>.</span></div>
      <div class="wz-tip">Dica: configure no roteador um endereço fixo para o servidor. Assim ele não muda e o painel não perde a conexão.</div>
    </aside>
  </div>
  <footer class="wz-foot">${back(1)}<span class="grow"></span>${next('Continuar', 'servidor')}</footer>`;
}

// ---------------- Passo 3 ----------------
function viewStep3() {
  const s = st.form;
  const id = st.ident;
  return html`<div class="wz-cols">
    <main class="wz-card md">
      <div class="wz-title"><h1 class="wz-h1 sm" tabindex="-1">Conectar a <span class="mono">${s.host}</span></h1>
        <p class="wz-lead sm">Antes de enviar a senha, confirme que este é mesmo o seu servidor.</p></div>
      <section class="wz-ident" aria-label="Identidade do servidor">
        <div class="wz-ident-head"><span class="wz-ico accent lg">${icon('shield', 16, 2.2)}</span><h2>Identidade do servidor</h2>
          <span class="wz-hint">${id && id.conhecida ? 'já conhecida deste computador' : 'primeira conexão deste computador'}</span></div>
        ${id ? html`<div class="wz-fp" aria-label="Impressão digital ${id.fingerprint}">${id.blocos.map((b) => html`<span>${b}</span>`)}</div>` : html`<div class="wz-hint">lendo a identidade…</div>`}
        <details><summary>Como conferir no servidor</summary>
          <p>No próprio servidor, rode o comando abaixo. As letras devem ser iguais às de cima${id && id.type !== 'ssh-ed25519' ? ` (chave ${id.type})` : ''}.</p>
          <pre class="wz-code">${id && id.type !== 'ssh-ed25519' ? `ssh-keygen -lf /etc/ssh/ssh_host_${id.type.startsWith('ecdsa') ? 'ecdsa' : 'rsa'}_key.pub` : 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'}</pre>
        </details>
        <div class="wz-confirm"><input id="confio" type="checkbox" data-act="confirm" ${st.confirm ? raw('checked') : ''} ${st.field === 'confirmo' ? raw('aria-invalid="true"') : ''}>
          <label for="confio">Este é o meu servidor. Lembrar esta identidade e me avisar se ela mudar.</label></div>
      </section>
      <form class="wz-field" data-form="conectar">
        <label for="senha">Senha de <span class="mono">${s.user}</span> no servidor</label>
        <div class="wz-pass">
          <input id="senha" class="wz-input pass ${st.field === 'senha' ? 'is-invalid' : ''}" type="${st.showPass ? 'text' : 'password'}" autocomplete="current-password" ${st.field === 'senha' ? raw('aria-invalid="true"') : ''}>
          <button type="button" class="wz-eye" data-act="showPass" aria-label="${st.showPass ? 'Esconder senha' : 'Mostrar senha'}" aria-pressed="${st.showPass}">${icon(st.showPass ? 'eyeOff' : 'eye', 18, 2)}</button>
        </div>
        <span class="wz-hint">${icon('lock', 13, 2.2)}usada só agora, direto na conexão; não fica salva em lugar nenhum</span>
        <button type="submit" hidden></button>
      </form>
      ${alertBox(st.error)}
    </main>
    <aside class="wz-aside" aria-label="O que acontece ao conectar">
      <h2>Ao clicar em Conectar</h2>
      <ol class="wz-list ol"><li>Uma única conexão é aberta</li><li>Lemos quais discos, pastas, rede e serviços existem (só leitura)</li><li>Conferimos se seu usuário pode usar sudo</li><li>Nada é alterado no servidor ainda</li></ol>
      <div class="wz-okbox"><strong>${icon('check', 13)}Já tem chave SSH para este servidor?</strong><span>Deixe a senha em branco: usamos a sua chave normalmente.</span></div>
    </aside>
  </div>
  <footer class="wz-foot">${back(2)}<span class="grow"></span>${next('Conectar', 'conectar', { disabled: !id || !st.confirm })}</footer>`;
}

// ---------------- Passo 4 ----------------
function choicePayload() {
  const disks = new Set(st.det.pastas.filter((p) => st.ch.mounts.has(p.target)).map((p) => p.disk).filter(Boolean));
  return {
    mounts: [...st.ch.mounts],
    smart: [...st.ch.smart].filter((d) => disks.has(d)),
    netIf: st.ch.netIf,
    services: [...st.ch.services],
    limiares: st.lim,
  };
}

let costTimer = null;
function scheduleCost() {
  clearTimeout(costTimer);
  costTimer = setTimeout(async () => {
    try {
      const r = await api('escolhas', choicePayload());
      st.cost = r.custo;
      if (st.field && ['mounts', 'smart', 'netIf', 'services', 'diskPct', 'ramPct', 'tempC'].includes(st.field)) { st.error = ''; st.field = ''; }
    } catch (err) {
      st.error = err.message;
      st.field = err.field || '';
    }
    render();
  }, 250);
}

function viewStep4() {
  const d = st.det;
  const seenDisk = new Set();
  const rows = d.pastas.map((p, i) => {
    const id = `d${i}`;
    let smartCell;
    if (!p.disk) smartCell = html`<span class="wz-row-note">disco não identificado</span>`;
    else if (seenDisk.has(p.disk)) smartCell = html`<span class="wz-row-note">${p.nota || `mesmo disco (${p.disk})`}</span>`;
    else if (p.virtual) smartCell = html`<span class="wz-row-note">disco virtual: sem teste de saúde</span>`;
    else if (!d.smartPossivel) smartCell = html`<span class="wz-row-note">sem SMART: ${d.smartMotivo}</span>`;
    else smartCell = html`<span class="wz-row-smart"><input id="s${i}" type="checkbox" data-smart="${p.disk}" ${st.ch.smart.has(p.disk) ? raw('checked') : ''}><label for="s${i}">testar saúde (SMART) de ${p.disk}</label></span>`;
    if (p.disk) seenDisk.add(p.disk);
    const kind = p.target === '/' ? 'sistema · ' : '';
    return html`<div class="wz-row">
      <input id="${id}" type="checkbox" data-mount="${p.target}" ${st.ch.mounts.has(p.target) ? raw('checked') : ''}>
      <label for="${id}"><span class="wz-row-name">${p.target}</span><span class="wz-row-sub">${kind}${p.disk ? `disco ${p.disk}` : p.source}</span></label>
      <span class="wz-row-size">${fmtBytes(p.size)}${p.pct !== null ? ` · ${p.pct}% usado` : ''}</span>
      ${smartCell}
    </div>`;
  });
  const nets = d.redes.map((n) => html`<label class="wz-radio"><input type="radio" name="rede" value="${n.name}" data-net="${n.name}" ${st.ch.netIf === n.name ? raw('checked') : ''}><span><span class="wz-row-name">${n.name}</span><span class="wz-row-sub">${n.wifi ? 'Wi-Fi' : 'cabo'} · ${n.up ? 'ativa' : 'desconectada'}${n.default ? ' · usada pelo servidor' : ''}</span></span></label>`);
  nets.push(html`<label class="wz-radio"><input type="radio" name="rede" value="" data-net="" ${st.ch.netIf === '' ? raw('checked') : ''}><span><span class="wz-row-name plain">Não acompanhar a rede</span><span class="wz-row-sub">a tela Rede fica oculta</span></span></label>`);
  const svcsShown = st.allServices ? d.servicos : d.servicos.filter((s, i) => s.recommended || s.label || st.ch.services.has(s.name) || i < 6);
  const hidden = d.servicos.length - svcsShown.length;
  const svcs = svcsShown.map((s) => html`<label class="wz-svc"><input type="checkbox" data-svc="${s.name}" ${st.ch.services.has(s.name) ? raw('checked') : ''}>${s.name}${s.label ? html` <small>${s.label}</small>` : ''}</label>`);
  const lim = (key, label, unit) => html`<div class="wz-lim"><label for="lim-${key}">${label}</label><div><input id="lim-${key}" type="text" inputmode="numeric" data-lim="${key}" value="${st.lim[key]}" class="${st.field === key ? 'is-invalid' : ''}" ${st.field === key ? raw('aria-invalid="true"') : ''}><span>${unit}</span></div></div>`;
  const payload = choicePayload();
  const cost = st.cost || d.custo;
  return html`<div class="wz-cols">
    <main class="wz-card md">
      <div class="wz-title"><h1 class="wz-h1 sm" tabindex="-1">O que você quer acompanhar?</h1>
        <p class="wz-lead sm">Encontramos isto no servidor. Já deixamos marcado o que recomendamos; ajuste se quiser.</p></div>
      <fieldset class="wz-fs"><legend>Discos e pastas</legend>${rows}</fieldset>
      <fieldset class="wz-fs"><legend>Rede</legend><div class="wz-radios">${nets}</div></fieldset>
      <fieldset class="wz-fs"><legend>Serviços <small>· avisar se pararem</small></legend>
        <div class="wz-svcs">${svcs.length ? svcs : html`<span class="wz-hint">nenhum serviço em execução encontrado</span>`}${hidden > 0 ? html`<button type="button" class="wz-more" data-act="allServices">ver os ${d.servicos.length} serviços em execução</button>` : ''}</div></fieldset>
      <fieldset class="wz-fs"><legend>Quando avisar <small>· valores recomendados</small></legend>
        <div class="wz-lims">${lim('diskPct', 'Disco acima de', '%')}${lim('ramPct', 'Memória acima de', '%')}${lim('tempC', 'Temperatura acima de', '°C')}</div></fieldset>
      ${alertBox(st.error)}
    </main>
    <aside class="wz-aside" aria-label="Resumo das escolhas">
      <h2>Resumo</h2>
      <div class="wz-sum">
        <div><span>pastas</span><span>${payload.mounts.length}</span></div>
        <div><span>discos com SMART</span><span>${payload.smart.length}</span></div>
        <div><span>rede</span><span>${payload.netIf || '—'}</span></div>
        <div><span>serviços</span><span>${payload.services.length}</span></div>
      </div>
      <div class="wz-cost"><span class="cap">custo estimado no servidor</span><span class="val">~${fmtSec(cost.seconds)} s <small>por minuto</small></span><span class="cap">resposta de ~${Math.round(cost.kb)} KB · 1 conexão por minuto</span></div>
      <span class="wz-aside-note">Pode mudar tudo isso depois, em <span class="mono">dashboard reconfigurar</span>.</span>
    </aside>
  </div>
  <footer class="wz-foot">${back(3)}<span class="grow"></span>${next('Continuar', 'escolhas', { disabled: !payload.mounts.length })}</footer>`;
}

// ---------------- Passo 5 ----------------
function shortCommands(text, hash) {
  return text.split('\n').map((line) => {
    const short = line.replace(/command="(?:[^"\\]|\\.)*"/, `command="…coleta v2 · ${hash.slice(0, 6)}…"`);
    return line.startsWith('#') ? html`<span class="c">${short}</span>\n` : html`${short}\n`;
  });
}

function viewStep5() {
  const p = st.plan;
  if (!p) return html`<main class="wz-card md"><h1 class="wz-h1 sm" tabindex="-1">Preparar o servidor</h1><p class="wz-hint">montando o plano…</p>${alertBox(st.error)}</main><footer class="wz-foot">${back(4)}</footer>`;
  const seg = html`<div class="wz-seg" role="group" aria-label="Modo">
    <button type="button" data-mode="assistido" aria-pressed="${st.mode === 'assistido'}">Assistido</button>
    <button type="button" data-mode="manual" aria-pressed="${st.mode === 'manual'}">Prefiro fazer à mão</button></div>`;
  return st.mode === 'manual' ? viewManual(p, seg) : viewAssisted(p, seg);
}

function viewAssisted(p, seg) {
  const pr = st.prep;
  const done = new Set(pr.feitos);
  const running = pr.state === 'executando';
  const firstPending = p.acoes.find((a) => !done.has(a.id));
  const acts = p.acoes.map((a, i) => {
    const isDone = done.has(a.id);
    const isNow = running && a === firstPending;
    const isFail = pr.state === 'erro' && a === firstPending;
    return html`<li class="wz-act ${isDone ? 'is-done' : isNow ? 'is-now' : isFail ? 'is-fail' : ''}">
      <span class="wz-act-mark">${isDone ? icon('check', 14, 3.2) : i + 1}</span>
      <span class="wz-act-text"><span class="wz-act-title">${a.titulo}</span><span class="wz-act-sub">${a.detalhe}</span></span>
      <span class="wz-act-status">${isDone ? 'feito' : isNow ? raw('<span class="spinner" aria-hidden="true"></span> em andamento…') : isFail ? 'parou aqui' : ''}</span>
    </li>`;
  });
  const review = pr.state !== 'concluido' ? html`<div class="wz-review">
    ${p.clientIp ? html`<label class="wz-from"><input type="checkbox" data-act="from" ${p.from ? raw('checked') : ''} ${running ? raw('disabled') : ''}>
      <span><strong>Aceitar a chave só deste computador <small>(${p.clientIp})</small></strong><em>Mais seguro: mesmo que a chave vaze, ela não funciona de outro lugar. Se o endereço deste computador mudar, rode <span class="mono">dashboard reconfigurar</span>.</em></span></label>` : ''}
    ${p.precisaSenha || pr.precisaSenha ? html`<div class="wz-field"><label for="sudoSenha">Senha de <span class="mono">${st.form.user}</span> para o sudo</label>
      <input id="sudoSenha" class="wz-input pass ${st.field === 'senha' ? 'is-invalid' : ''}" type="password" autocomplete="current-password">
      <span class="wz-hint">${icon('lock', 13, 2.2)}usada uma vez, nesta conexão, e descartada em seguida</span></div>` : ''}
    <details ${raw('open')}><summary>Ver os comandos exatos que serão executados no servidor</summary>
      <pre class="wz-pre">${shortCommands(p.comandos, p.hash)}</pre>
      <details><summary>Ver a linha completa da chave (com o comando de coleta inteiro)</summary><pre class="wz-pre">${p.linhaChave}</pre></details>
    </details>
  </div>` : html`<div class="wz-done" role="status"><span class="wz-done-mark">${icon('check', 18, 3)}</span>
      <span><strong>Servidor pronto</strong><em>A conexão administrativa foi encerrada e a senha descartada. Daqui em diante o painel usa só o usuário dashmon.</em></span></div>`;
  const podeAssistido = p.podeAssistido || p.precisaSenha;
  const btn = pr.state === 'concluido'
    ? html`<button type="button" class="wz-next" data-go="6">Continuar <span aria-hidden="true">→</span></button>`
    : running ? html`<button type="button" class="wz-next" disabled>Aguarde…</button>`
      : html`<button type="button" class="wz-next" data-act="preparar" ${podeAssistido ? '' : raw('disabled')}>${pr.state === 'erro' ? 'Tentar de novo' : 'Confirmar e preparar'}</button>`;
  return html`<main class="wz-card md">
    <div class="wz-title row"><div><h1 class="wz-h1 sm" tabindex="-1">Preparar o servidor</h1>
      <p class="wz-lead sm">Confira o que vai acontecer. Nada é feito antes do seu "Confirmar", e tudo pode ser desfeito depois.</p></div>${seg}</div>
    <ol class="wz-acts">${acts}</ol>
    ${!podeAssistido ? alertBox(`O usuário ${st.form.user} não pode usar sudo neste servidor. Use "Prefiro fazer à mão" com um usuário que possa, ou volte e entre como root.`, true) : ''}
    ${review}
    ${alertBox(pr.error)}
  </main>
  <footer class="wz-foot">${running ? '' : back(4)}<span class="grow wz-foot-note">${running ? 'não feche esta janela' : pr.state === 'concluido' ? '' : '1 conexão · cerca de 10 segundos'}</span>${btn}</footer>`;
}

function viewManual(p, seg) {
  const m = st.manual;
  const total = p.blocos.length;
  const ok = p.blocos.filter((b) => m.tests[b.id]).length;
  const blocks = p.blocos.map((b, i) => {
    const passed = m.tests[b.id] === true;
    const failed = m.tests[b.id] === false;
    return html`<section class="wz-block ${passed ? 'is-ok' : failed ? 'is-err' : ''}" aria-label="${b.titulo}">
      <div class="wz-block-head">
        <span class="wz-act-mark">${passed ? icon('check', 14, 3.2) : i + 1}</span>
        <span class="wz-act-text"><span class="wz-act-title">${b.titulo}</span><span class="wz-act-sub">${b.detalhe}</span></span>
        <span class="wz-block-status">${passed ? 'conferido' : failed ? 'falta um ajuste' : 'aguardando'}</span>
        ${b.id === 'pronto' ? '' : html`<button type="button" class="wz-mini" data-copy="${b.id}">Copiar</button>`}
        <button type="button" class="wz-mini soft" data-test="${b.id}" ${m.busy ? raw('disabled') : ''}>${m.busy === b.id ? 'Testando…' : 'Testar'}</button>
      </div>
      <pre class="wz-pre">${b.codigo}</pre>
      ${failed && m.errors[b.id] ? html`<div class="wz-block-err" role="alert">${m.errors[b.id]}</div>` : ''}
    </section>`;
  });
  return html`<main class="wz-card md">
    <div class="wz-title row"><div><h1 class="wz-h1 sm" tabindex="-1">Preparar o servidor à mão</h1>
      <p class="wz-lead sm">Abra um terminal <b>no servidor</b> e cole um bloco por vez. Depois de cada bloco, clique em Testar: conferimos sem mudar nada.</p></div>${seg}</div>
    <div class="wz-blocks">${blocks}</div>
  </main>
  <footer class="wz-foot">${back(4)}<span class="grow wz-foot-note">${ok} de ${total} blocos conferidos</span>
    <button type="button" class="wz-next" data-go="6" ${ok === total ? '' : raw('disabled')}>Continuar <span aria-hidden="true">→</span></button></footer>`;
}

// ---------------- Passo 6 ----------------
function viewStep6() {
  const r = st.result || {};
  const val = (v, unit) => (v === null || v === undefined ? html`<span class="val soft">sem dado</span>` : html`<span class="val">${v}${unit === '%' ? '%' : ` ${unit}`}</span>`);
  return html`<main class="wz-card ok-hero">
    <div class="wz-hero"><span class="wz-hero-mark">${icon('check', 26, 3)}</span>
      <div><h1 class="wz-h1" tabindex="-1">Tudo pronto. A primeira coleta já deu certo.</h1>
      <p class="wz-lead">Primeira coleta feita agora${r.duracaoMs ? `, em ${fmtSec((r.duracaoMs / 1000).toFixed(1))} s` : ''}. Ao abrir o painel, ele passa a coletar 1 vez por minuto, sozinho.</p></div></div>
    <section class="wz-read" aria-label="Primeira leitura">
      <div><span class="cap">Memória</span>${val(r.memoriaPct, '%')}</div>
      <div><span class="cap">Disco mais cheio</span>${val(r.discoPct, '%')}</div>
      <div><span class="cap">Temperatura</span>${val(r.temperaturaC, '°C')}</div>
      <div><span class="cap">Serviços</span>${r.servicosTotal ? html`<span class="val">${r.servicosAtivos}/${r.servicosTotal} <small>ativos</small></span>` : html`<span class="val soft">nenhum escolhido</span>`}</div>
      <div><span class="cap">CPU e rede</span><span class="val soft">aparecem na 2ª coleta</span></div>
    </section>
    <div class="wz-two">
      <section class="wz-box tight" aria-label="Preferências"><h2>Do jeito que você preferir</h2>
        <label class="wz-switch"><span><span>Iniciar com o computador</span><span>${st.computer && st.computer.systemd === false ? 'este sistema não tem systemd de usuário: use o atalho' : 'nunca precisa deixar um terminal aberto'}</span></span><input type="checkbox" role="switch" data-pref="boot" ${st.prefs.boot ? raw('checked') : ''} ${st.computer && st.computer.systemd === false ? raw('disabled') : ''}></label>
        <label class="wz-switch"><span><span>Atalho no menu de aplicativos</span><span>"Server Dashboard", com ícone</span></span><input type="checkbox" role="switch" data-pref="shortcut" ${st.prefs.shortcut ? raw('checked') : ''}></label>
        <label class="wz-switch"><span><span>Avisar no navegador quando algo for crítico</span><span>o navegador vai pedir permissão</span></span><input type="checkbox" role="switch" data-pref="notify" ${st.prefs.notify ? raw('checked') : ''}></label>
      </section>
      <section class="wz-box" aria-label="O que foi criado"><h2>O que foi criado</h2>
        <div class="wz-made"><span>Neste computador</span><span>pasta <span class="mono">data/</span> do projeto · chave <span class="mono">${st.plan ? st.plan.chave : '~/.ssh/dashboard_ed25519'}</span> · ${st.prefs.boot ? 'serviço de usuário · ' : ''}${st.prefs.shortcut ? 'atalho' : 'sem atalho'}</span>
          <span>No servidor</span><span>usuário <span class="mono">dashmon</span> · chave restrita · ${st.plan && st.plan.temSmart ? html`regra de sudo para <span class="mono">smartctl -H</span>` : 'sem regra de sudo'}</span></div>
        <span class="wz-hint">Para desfazer tudo, aqui e no servidor: <span class="mono">dashboard desinstalar</span></span>
        <div class="wz-token"><span>Token de reserva, para entrar de outro navegador</span>
          ${st.token ? html`<code>${st.token}</code>` : html`<button type="button" class="wz-mini" data-act="token">Mostrar uma vez</button>`}</div>
      </section>
    </div>
    ${alertBox(st.error)}
  </main>
  <footer class="wz-foot"><span class="wz-foot-note grow">${st.opening ? 'ligando o painel…' : 'o assistente se desliga ao abrir o painel'}</span>
    <button type="button" class="wz-next big" data-act="abrir" ${st.opening ? raw('disabled') : ''}>${st.opening ? 'Abrindo…' : raw('Abrir o painel <span aria-hidden="true">→</span>')}</button></footer>`;
}

// ---------------- Render ----------------
function render() {
  meta();
  mount($('wzSteps'), st.gate ? '' : stepsBar());
  const views = { 1: viewStep1, 2: viewStep2, 3: viewStep3, 4: viewStep4, 5: viewStep5, 6: viewStep6 };
  // Preserva o que a pessoa está digitando (o render refaz o HTML).
  const typing = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
  const senha = $('senha') ? $('senha').value : null;
  const sudo = $('sudoSenha') ? $('sudoSenha').value : null;
  mount(root, st.gate ? viewGate() : views[st.step]());
  if (senha !== null && $('senha')) $('senha').value = senha;
  if (sudo !== null && $('sudoSenha')) $('sudoSenha').value = sudo;
  if (typing && $(typing)) {
    const el = $(typing);
    el.focus();
    if (typeof el.value === 'string' && el.setSelectionRange && el.type === 'text') { const n = el.value.length; el.setSelectionRange(n, n); }
  }
}

// ---------------- Ações ----------------
async function loadState() {
  const s = await api('estado');
  st.computer = s.computador;
  st.passos = s.passos;
  if (s.computador.systemd === false) st.prefs.boot = false;
  if (s.computador.servidorAtual && !st.form.host) {
    st.form.host = s.computador.servidorAtual.host;
    st.form.port = String(s.computador.servidorAtual.port);
  }
  render();
}

async function submitServer() {
  const f = st.form;
  f.host = $('host').value.trim();
  f.user = $('user').value.trim();
  f.port = ($('port').value || '22').trim();
  await run(async () => {
    st.reach = null;
    const r = await api('servidor', { host: f.host, user: f.user, port: f.port });
    st.reach = { ms: r.ms, port: r.port };
    st.ident = null;
    st.confirm = false;
    go(3);
    st.ident = await api('identidade', {});
    if (st.ident.conhecida) st.confirm = true;
  });
}

async function submitConnect() {
  const senha = $('senha').value;
  await run(async () => {
    const det = await api('conectar', { senha, confirmo: st.confirm });
    st.det = det;
    st.ch = { mounts: new Set(det.escolhas.mounts), smart: new Set(det.escolhas.smart), netIf: det.escolhas.netIf, services: new Set(det.escolhas.services) };
    st.lim = { ...det.limiares };
    st.cost = det.custo;
    st.plan = null;
    st.prep = { state: 'revisar', feitos: [], error: '', precisaSenha: false };
    st.manual = { tests: {}, errors: {}, busy: '' };
    go(4);
  });
}

async function loadPlan(from = true) {
  const p = await api('plano', { from });
  st.plan = p;
  render();
}

async function submitChoices() {
  await run(async () => {
    await api('escolhas', choicePayload());
    st.plan = null;
    st.prep = { state: 'revisar', feitos: [], error: '', precisaSenha: false };
    st.manual = { tests: {}, errors: {}, busy: '' };
    go(5);
    await loadPlan(true);
  });
}

async function prepare() {
  const senhaEl = $('sudoSenha');
  const senha = senhaEl ? senhaEl.value : undefined;
  st.prep = { ...st.prep, state: 'executando', error: '' };
  render();
  try {
    const r = await api('preparar', senha ? { senha } : {});
    st.prep.feitos = r.feitos || [];
    if (r.ok) {
      st.prep.state = 'concluido';
      st.result = r.resumo;
      $('wzLive').textContent = 'Servidor pronto.';
    } else {
      st.prep.state = 'erro';
      st.prep.error = r.erro;
      st.prep.precisaSenha = Boolean(r.precisaSenha);
    }
  } catch (err) {
    st.prep.state = 'erro';
    st.prep.error = err.message;
    st.field = err.field || '';
  }
  render();
}

async function testBlock(id) {
  st.manual.busy = id;
  render();
  try {
    const r = await api('testar', { bloco: id });
    st.manual.tests[id] = Boolean(r.ok);
    st.manual.errors[id] = r.ok ? '' : r.erro;
    if (r.resumo) st.result = r.resumo;
  } catch (err) {
    st.manual.tests[id] = false;
    st.manual.errors[id] = err.message;
  }
  st.manual.busy = '';
  render();
}

async function copyBlock(id) {
  const b = st.plan.blocos.find((x) => x.id === id);
  try {
    await navigator.clipboard.writeText(`${b.codigo}\n`);
    $('wzLive').textContent = 'Copiado. Cole no terminal do servidor.';
    const btn = root.querySelector(`[data-copy="${id}"]`);
    if (btn) { btn.textContent = 'Copiado'; setTimeout(() => { btn.textContent = 'Copiar'; }, 2000); }
  } catch {
    $('wzLive').textContent = 'Não consegui copiar: selecione o texto do bloco e copie.';
  }
}

async function openPanel() {
  st.opening = true;
  st.error = '';
  render();
  let url;
  try {
    url = (await api('concluir', { iniciarComComputador: st.prefs.boot, atalho: st.prefs.shortcut })).url;
  } catch (err) {
    st.opening = false;
    st.error = err.message;
    render();
    return;
  }
  // O assistente fecha e o painel sobe na mesma porta: espera ele responder.
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      const body = await res.json();
      if (body && 'authRequired' in body) { location.href = url; return; }
    } catch { /* ainda subindo */ }
  }
  st.opening = false;
  st.error = 'O painel não respondeu. No terminal, rode ./dashboard abrir.';
  render();
}

root.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target.dataset.form;
  if (form === 'gate') enterCode($('codigo').value);
  else if (form === 'servidor') submitServer();
  else if (form === 'conectar' && st.ident && st.confirm) submitConnect();
});

root.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go],[data-act],[data-mode],[data-copy],[data-test]');
  if (!t || t.disabled) return;
  if (t.dataset.go) {
    const to = Number(t.dataset.go);
    if (to === 6 && st.step === 5 && !st.result) return;
    go(to);
    return;
  }
  if (t.dataset.mode) { st.mode = t.dataset.mode; render(); return; }
  if (t.dataset.copy) { copyBlock(t.dataset.copy); return; }
  if (t.dataset.test) { testBlock(t.dataset.test); return; }
  switch (t.dataset.act) {
    case 'pastHelp': st.pastHelp = !st.pastHelp; render(); break;
    case 'servidor': submitServer(); break;
    case 'conectar': submitConnect(); break;
    case 'showPass': st.showPass = !st.showPass; render(); $('senha').focus(); break;
    case 'allServices': st.allServices = true; render(); break;
    case 'escolhas': submitChoices(); break;
    case 'preparar': prepare(); break;
    case 'token': api('token', {}).then((r) => { st.token = r.token; render(); }, (err) => { st.error = err.message; render(); }); break;
    case 'abrir': openPanel(); break;
    default: break;
  }
});

root.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.act === 'confirm') { st.confirm = t.checked; render(); return; }
  if (t.dataset.act === 'from') { loadPlan(t.checked).catch((err) => { st.error = err.message; render(); }); return; }
  if (t.dataset.mount !== undefined) { if (t.checked) st.ch.mounts.add(t.dataset.mount); else st.ch.mounts.delete(t.dataset.mount); scheduleCost(); render(); return; }
  if (t.dataset.smart !== undefined) { if (t.checked) st.ch.smart.add(t.dataset.smart); else st.ch.smart.delete(t.dataset.smart); scheduleCost(); render(); return; }
  if (t.dataset.net !== undefined) { st.ch.netIf = t.dataset.net; scheduleCost(); render(); return; }
  if (t.dataset.svc !== undefined) { if (t.checked) st.ch.services.add(t.dataset.svc); else st.ch.services.delete(t.dataset.svc); scheduleCost(); render(); return; }
  if (t.dataset.pref) {
    st.prefs[t.dataset.pref] = t.checked;
    if (t.dataset.pref === 'notify' && t.checked) {
      if (typeof Notification === 'undefined') { st.prefs.notify = false; st.error = 'Este navegador não tem notificações.'; render(); return; }
      Notification.requestPermission().then((p) => { st.prefs.notify = p === 'granted'; if (p !== 'granted') st.error = 'O navegador não liberou as notificações. Dá para ligar depois, na Ajuda do painel.'; render(); });
    }
    render();
  }
});

root.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.lim) {
    const v = Number(t.value);
    if (Number.isInteger(v)) { st.lim[t.dataset.lim] = v; scheduleCost(); }
  }
  if (st.step === 2 && ['host', 'user', 'port'].includes(t.id)) {
    st.form[t.id] = t.value;
    if (t.id === 'host' || t.id === 'port') st.reach = null;
  }
});

// ---------------- Tema e início ----------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* bloqueado */ }
  const dark = theme === 'dark';
  mount($('wzTheme'), icon(dark ? 'moon' : 'sun', 18, 2));
  $('wzTheme').setAttribute('aria-label', dark ? 'Usar tema claro' : 'Usar tema escuro');
}
let theme = 'dark';
try { theme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { /* bloqueado */ }
applyTheme(theme);
$('wzTheme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

(async () => {
  const m = /codigo=([A-Za-z0-9-]+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    await enterCode(m[1]);
    return;
  }
  try {
    await loadState();
  } catch {
    st.gate = true;
    render();
  }
})();
