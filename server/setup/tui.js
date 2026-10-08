// TUI reserva (D10, prancheta "TUI reserva"): os mesmos 6 passos do assistente no
// terminal, para máquinas sem tela ou acessadas por SSH. Feita em Node, sem dependências:
// setas, espaço, Tab e Enter; funciona sem cores (NO_COLOR ou terminal simples).
// Usa os mesmos métodos do assistente no navegador (instalacao.js).
import readline from 'node:readline';
import { STEPS } from './instalacao.js';

const fmtBytes = (b) => {
  if (!Number.isFinite(b) || b <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${u[i]}`;
};
const pad = (s, n) => String(s).padEnd(n);

export class Cancelled extends Error {}

/** Terminal: lê teclas (keypress) e redesenha a tela inteira a cada mudança. */
export class Screen {
  constructor({ input, output, color }) {
    this.input = input;
    this.output = output;
    this.color = color;
    this.queue = [];
    this.waiting = null;
    this.onKey = (str, key = {}) => {
      const k = { name: key.name || str, sequence: key.sequence ?? str, ctrl: Boolean(key.ctrl), shift: Boolean(key.shift) };
      if (k.ctrl && k.name === 'c') { this.cancelled = true; }
      if (this.waiting) { const w = this.waiting; this.waiting = null; w(k); } else this.queue.push(k);
    };
    input.on('keypress', this.onKey);
    this.step = 1;
  }

  paint(code, text) { return this.color ? `\x1b[${code}m${text}\x1b[0m` : String(text); }
  ok(t) { return this.paint('32', t); }
  warn(t) { return this.paint('33', t); }
  crit(t) { return this.paint('31', t); }
  accent(t) { return this.paint('36', t); }
  dim(t) { return this.paint('2', t); }
  bold(t) { return this.paint('1', t); }
  inverse(t) { return this.color ? `\x1b[7m${t}\x1b[0m` : t; }

  key() {
    if (this.cancelled) return Promise.reject(new Cancelled());
    if (this.queue.length) {
      const k = this.queue.shift();
      if (k.ctrl && k.name === 'c') return Promise.reject(new Cancelled());
      return Promise.resolve(k);
    }
    return new Promise((resolve, reject) => {
      this.waiting = (k) => (k.ctrl && k.name === 'c' ? reject(new Cancelled()) : resolve(k));
    });
  }

  header() {
    const marks = STEPS.map((name, i) => {
      const n = i + 1;
      if (n < this.step) return this.ok(`✓ ${name}`);
      if (n === this.step) return this.accent(this.bold(`● ${n} ${name}`));
      return this.dim(`○ ${n}`);
    }).join('  ');
    const line = '─'.repeat(70);
    return [this.accent(`╭─ Server Dashboard · configuração inicial ${line.slice(0, 28)}╮`), `  ${marks}`, this.accent(`╰${line}╯`), ''];
  }

  draw(body, hints = '') {
    const out = [...this.header(), ...body];
    if (hints) out.push('', this.dim('─'.repeat(72)), ` ${hints}`);
    this.output.write(`\x1b[2J\x1b[H${out.join('\n')}\n`);
  }

  close() { this.input.off('keypress', this.onKey); }

  /** Campo de texto (Enter confirma, Esc volta). `mask` esconde o que é digitado. */
  async text({ title, lines = [], label, value = '', mask = false, error = '', hint = '' }) {
    let v = String(value);
    for (;;) {
      const shown = mask ? '•'.repeat(v.length) : v;
      this.draw([
        `  ${this.bold(title)}`, ...lines.map((l) => `  ${l}`), '',
        `  ${label}: ${shown}${this.inverse(' ')}`,
        ...(hint ? [`  ${this.dim(hint)}`] : []),
        ...(error ? ['', `  ${this.crit(`✗ ${error}`)}`] : []),
      ], `${this.accent('Enter')} confirmar   ${this.accent('Esc')} voltar`);
      const k = await this.key();
      if (k.name === 'return' || k.name === 'enter') return v;
      if (k.name === 'escape') return null;
      if (k.name === 'backspace') { v = v.slice(0, -1); continue; }
      if (k.sequence && k.sequence.length === 1 && k.sequence >= ' ' && !k.ctrl) v += k.sequence;
    }
  }

  /** Mensagem com uma escolha s/n (ou só Enter para continuar). */
  async confirm({ title, lines = [], question, yesNo = true }) {
    this.draw([`  ${this.bold(title)}`, ...lines.map((l) => `  ${l}`), '', `  ${question}${yesNo ? ' [s/n]' : ''}`],
      yesNo ? `${this.accent('s')} sim   ${this.accent('n')} não   ${this.accent('Esc')} voltar` : `${this.accent('Enter')} continuar   ${this.accent('Esc')} voltar`);
    for (;;) {
      const k = await this.key();
      if (k.name === 'escape') return null;
      if (!yesNo && (k.name === 'return' || k.name === 'enter')) return true;
      if (yesNo && /^[sy]$/i.test(k.sequence || '')) return true;
      if (yesNo && /^n$/i.test(k.sequence || '')) return false;
    }
  }

  /**
   * Formulário em grupos (passo 4 e preferências do passo 6): ↑↓ movem, Tab pula de
   * grupo, espaço marca, "s" liga o SMART da linha, números editam os limiares.
   */
  async form({ title, lines = [], groups, footer = [], error = '', extraKeys = {} }) {
    const rows = groups.flatMap((g, gi) => g.rows.map((r) => ({ ...r, group: gi })));
    let cur = Math.max(0, rows.findIndex((r) => !r.disabled));
    for (;;) {
      const body = [`  ${this.bold(title)}`, ...lines.map((l) => `  ${this.dim(l)}`), ''];
      groups.forEach((g, gi) => {
        body.push(`  ${this.bold(g.label)}`);
        rows.forEach((r, i) => {
          if (r.group !== gi) return;
          const pointer = i === cur ? this.accent('❯') : ' ';
          const mark = r.type === 'radio' ? (r.get() ? '(•)' : '( )') : r.type === 'number' ? '   ' : (r.get() ? '[x]' : '[ ]');
          const text = r.type === 'number' ? `${pad(r.label, 24)} ${this.bold(r.get())}${r.unit}` : r.label;
          const line = ` ${pointer} ${mark} ${text}${r.extra ? `   ${r.extra()}` : ''}`;
          body.push(r.disabled ? this.dim(line) : i === cur ? this.bold(line) : line);
        });
        body.push('');
      });
      body.push(...footer.map((f) => `  ${this.dim(typeof f === 'function' ? f() : f)}`));
      if (error) body.push('', `  ${this.crit(`✗ ${error}`)}`);
      const row = rows[cur];
      const keys = [`${this.accent('↑↓')} mover`, `${this.accent('espaço')} marcar`];
      if (row && row.smart) keys.push(`${this.accent('s')} SMART`);
      if (row && row.type === 'number') keys.push(`${this.accent('0–9')} editar`);
      keys.push(`${this.accent('Tab')} próximo grupo`, `${this.accent('Enter')} continuar`, `${this.accent('Esc')} voltar`);
      this.draw(body, keys.join('   '));
      const k = await this.key();
      const move = (d) => {
        for (let j = 1; j <= rows.length; j += 1) {
          const n = (cur + d * j + rows.length) % rows.length;
          if (!rows[n].disabled) { cur = n; return; }
        }
      };
      if (k.name === 'up') move(-1);
      else if (k.name === 'down') move(1);
      else if (k.name === 'tab') {
        const g = rows[cur].group;
        const nextIdx = rows.findIndex((r, i) => i > cur && r.group !== g && !r.disabled);
        cur = nextIdx >= 0 ? nextIdx : Math.max(0, rows.findIndex((r) => !r.disabled));
      } else if (k.name === 'space' && row && !row.disabled && row.type !== 'number') row.toggle();
      else if (k.sequence === 's' && row && row.smart) row.smart();
      else if (row && row.type === 'number' && /^[0-9]$/.test(k.sequence || '')) row.type_(k.sequence);
      else if (row && row.type === 'number' && k.name === 'backspace') row.back();
      else if (k.name === 'return' || k.name === 'enter') return true;
      else if (k.name === 'escape') return null;
      else if (extraKeys[k.sequence]) extraKeys[k.sequence]();
      error = '';
    }
  }

  /** Tela de espera (ação em andamento). */
  busy(title, text) { this.draw([`  ${this.bold(title)}`, '', `  ${this.accent('…')} ${text}`]); }
}

// ---------------- Os 6 passos ----------------

async function step1(sc, inst) {
  sc.step = 1;
  const c = inst.verificarComputador();
  const chip = (item, text) => `${item.ok ? sc.ok('✓') : sc.warn('▲')} ${text}`;
  const r = await sc.confirm({
    title: c.reconfigurar ? 'Vamos revisar a ligação com o seu servidor' : 'Vamos ligar o painel ao seu servidor',
    lines: [
      'Em poucos passos este computador passa a acompanhar o seu servidor Linux,',
      '1 vez por minuto, sem instalar nada nele.', '',
      sc.bold('O que vamos fazer'), '  · criar uma chave de acesso só para o painel', '  · preparar no servidor um usuário que só consegue ler informações',
      '  · descobrir sozinhos seus discos, rede e serviços', '  · deixar o painel iniciando com o computador', '',
      sc.bold('O que nunca fazemos'), '  · instalar programas no servidor · guardar a senha do servidor',
      '  · pedir senha de administrador neste computador · abrir o painel para a rede', '',
      sc.bold('Tenha em mãos'), '  · o endereço do servidor (ex.: 192.0.2.10) · um usuário que possa usar sudo e a senha dele', '',
      [chip(c.versao, c.versao.texto), chip(c.node, c.node.texto), chip(c.ssh, c.ssh.texto)].join('   '),
    ],
    question: 'Começar?',
    yesNo: false,
  });
  if (r === null) throw new Cancelled();
}

async function step2(sc, inst, form) {
  sc.step = 2;
  let error = '';
  for (;;) {
    const lines = ['Informe o endereço e um usuário que você já usa para entrar nele.', 'Não sabe o endereço? No servidor, digite hostname -I (o primeiro número).'];
    const host = await sc.text({ title: 'Qual é o seu servidor?', lines, label: 'Endereço do servidor', value: form.host, error: error && error.field === 'host' ? error.message : '' });
    if (host === null) return 'back';
    form.host = host.trim();
    const user = await sc.text({ title: 'Qual é o seu servidor?', lines, label: 'Seu usuário no servidor', value: form.user, hint: 'precisa poder usar sudo · se você entra como root, escreva root', error: error && error.field === 'user' ? error.message : '' });
    if (user === null) continue;
    form.user = user.trim();
    const port = await sc.text({ title: 'Qual é o seu servidor?', lines, label: 'Porta SSH', value: form.port || '22', error: error && error.field === 'port' ? error.message : '' });
    if (port === null) continue;
    form.port = port.trim() || '22';
    sc.busy('Qual é o seu servidor?', `procurando ${form.host} na rede…`);
    try {
      await inst.definirServidor(form);
      return 'next';
    } catch (err) {
      error = err;
      if (!err.field) error = { field: 'host', message: err.message };
    }
  }
}

async function step3(sc, inst, form) {
  sc.step = 3;
  sc.busy(`Conectar a ${form.host}`, 'lendo a identidade do servidor…');
  let id;
  try { id = await inst.lerIdentidade(); } catch (err) {
    await sc.confirm({ title: `Conectar a ${form.host}`, lines: [sc.crit(`✗ ${err.message}`)], question: 'Voltar', yesNo: false });
    return 'back';
  }
  const blocks = [];
  for (let i = 0; i < id.blocos.length; i += 4) blocks.push(`  ${id.blocos.slice(i, i + 4).map((b) => `[ ${b} ]`).join(' ')}`);
  const ok = await sc.confirm({
    title: `Conectar a ${form.host}`,
    lines: [
      'Antes de enviar a senha, confirme que este é mesmo o seu servidor.', '',
      sc.bold(`Identidade do servidor ${id.conhecida ? '(já conhecida deste computador)' : '(primeira conexão deste computador)'}`),
      ...blocks, '',
      sc.dim('Para conferir, rode no servidor: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'),
      sc.dim('As letras devem ser iguais às de cima.'),
    ],
    question: 'Este é o meu servidor. Lembrar esta identidade e me avisar se ela mudar?',
  });
  if (ok === null || ok === false) return 'back';
  let error = '';
  for (;;) {
    const senha = await sc.text({
      title: `Conectar a ${form.host}`, mask: true, label: `Senha de ${form.user} no servidor`, error,
      lines: ['Ao continuar: 1 conexão só de leitura (discos, pastas, rede, serviços e sudo). Nada é alterado.'],
      hint: 'usada só agora, direto na conexão; não fica salva · já tem chave SSH? deixe em branco',
    });
    if (senha === null) return 'back';
    sc.busy(`Conectar a ${form.host}`, 'conectando e lendo o servidor (só leitura)…');
    try {
      await inst.conectar({ senha, confirmo: true });
      return 'next';
    } catch (err) {
      error = err.message;
    }
  }
}

async function step4(sc, inst) {
  sc.step = 4;
  const d = inst.resumoDeteccao();
  const ch = { mounts: new Set(d.escolhas.mounts), smart: new Set(d.escolhas.smart), netIf: d.escolhas.netIf, services: new Set(d.escolhas.services) };
  const lim = { ...d.limiares };
  const seen = new Set();
  const mountRows = d.pastas.map((p) => {
    const canSmart = p.disk && !seen.has(p.disk) && !p.virtual && d.smartPossivel;
    if (p.disk) seen.add(p.disk);
    const disk = p.disk;
    return {
      type: 'check',
      label: `${pad(p.target, 14)} ${pad(p.disk || '—', 6)} ${pad(fmtBytes(p.size), 8)} ${pad(p.pct !== null ? `${p.pct}%` : '', 5)}`,
      get: () => ch.mounts.has(p.target),
      toggle: () => { if (ch.mounts.has(p.target)) ch.mounts.delete(p.target); else ch.mounts.add(p.target); },
      smart: canSmart ? () => { if (ch.smart.has(disk)) ch.smart.delete(disk); else ch.smart.add(disk); } : null,
      extra: () => (canSmart ? `${ch.smart.has(disk) ? '[x]' : '[ ]'} SMART` : sc.dim(p.nota || (p.virtual ? 'disco virtual' : ''))),
    };
  });
  const netRows = [...d.redes.map((n) => ({
    type: 'radio', label: `${pad(n.name, 10)} ${sc.dim(`${n.wifi ? 'Wi-Fi' : 'cabo'} · ${n.up ? 'ativa' : 'desconectada'}`)}`,
    get: () => ch.netIf === n.name, toggle: () => { ch.netIf = n.name; },
  })), { type: 'radio', label: 'não acompanhar', get: () => ch.netIf === '', toggle: () => { ch.netIf = ''; } }];
  const svcRows = d.servicos.map((s) => ({
    type: 'check', label: `${pad(s.name, 18)} ${sc.dim(s.label)}`,
    get: () => ch.services.has(s.name), toggle: () => { if (ch.services.has(s.name)) ch.services.delete(s.name); else ch.services.add(s.name); },
  }));
  const num = (key, label, unit) => ({
    type: 'number', label, unit, get: () => lim[key],
    type_: (dgt) => { lim[key] = Number(`${String(lim[key]).length >= 3 ? '' : lim[key]}${dgt}`); },
    back: () => { lim[key] = Number(String(lim[key]).slice(0, -1)) || 0; },
  });
  const payload = () => {
    const disks = new Set(d.pastas.filter((p) => ch.mounts.has(p.target)).map((p) => p.disk));
    return { mounts: [...ch.mounts], smart: [...ch.smart].filter((x) => disks.has(x)), netIf: ch.netIf, services: [...ch.services], limiares: lim };
  };
  let error = '';
  for (;;) {
    const r = await sc.form({
      title: 'O que você quer acompanhar?',
      lines: [`conectado a ${d.servidor.host} como ${d.usuario} · ${d.sudoTexto}`, ...(d.smartPossivel ? [] : [`sem SMART: ${d.smartMotivo}`])],
      groups: [
        { label: 'Discos e pastas', rows: mountRows },
        { label: 'Rede', rows: netRows },
        { label: 'Serviços · avisar se pararem', rows: svcRows.length ? svcRows : [{ type: 'check', label: 'nenhum serviço em execução encontrado', disabled: true, get: () => false }] },
        { label: 'Quando avisar', rows: [num('diskPct', 'disco acima de', '%'), num('ramPct', 'memória acima de', '%'), num('tempC', 'temperatura acima de', ' °C')] },
      ],
      footer: ['Pode mudar tudo isso depois, em dashboard reconfigurar.'],
      error,
    });
    if (r === null) return 'back';
    try {
      const res = inst.definirEscolhas(payload());
      const ok = await sc.confirm({
        title: 'O que você quer acompanhar?',
        lines: [`pastas ${res.escolhas.mounts.length} · discos com SMART ${res.escolhas.smart.length} · rede ${res.escolhas.netIf || '—'} · serviços ${res.escolhas.services.length}`,
          `custo estimado: ~${String(res.custo.seconds).replace('.', ',')} s por minuto · resposta ~${Math.round(res.custo.kb)} KB`],
        question: 'Continuar com estas escolhas?',
        yesNo: false,
      });
      if (ok) return 'next';
    } catch (err) {
      error = err.message;
    }
  }
}

const shortKey = (text, hash) => text.replace(/command="(?:[^"\\]|\\.)*"/, `command="…coleta v2 · ${hash.slice(0, 6)}…"`);

async function step5(sc, inst, form) {
  sc.step = 5;
  let from = true;
  let plan = inst.planoPreparo({ from });
  for (;;) {
    let mode = 'assistido';
    const r = await sc.form({
      title: 'Preparar o servidor',
      lines: ['Nada é feito antes do seu "Confirmar", e tudo pode ser desfeito depois.'],
      groups: [
        { label: 'O que vai acontecer', rows: plan.acoes.map((a, i) => ({ type: 'number', label: `${i + 1} ${a.titulo}`, unit: '', get: () => '', disabled: true, extra: () => sc.dim(a.detalhe) })) },
        {
          label: 'Como',
          rows: [
            { type: 'radio', label: 'Assistido: executo os comandos depois do seu "Confirmar"', get: () => mode === 'assistido', toggle: () => { mode = 'assistido'; } },
            { type: 'radio', label: 'Prefiro fazer à mão: mostro os blocos para colar no servidor', get: () => mode === 'manual', toggle: () => { mode = 'manual'; } },
            ...(plan.clientIp ? [{ type: 'check', label: `Aceitar a chave só deste computador (${plan.clientIp})`, get: () => from, toggle: () => { from = !from; plan = inst.planoPreparo({ from }); } }] : []),
          ],
        },
      ],
      footer: [sc.bold('Comandos exatos que serão executados no servidor:'), ...shortKey(plan.comandos, plan.hash).split('\n')],
    });
    if (r === null) return 'back';
    if (mode === 'assistido') {
      if (!plan.podeAssistido && !plan.precisaSenha) {
        await sc.confirm({ title: 'Preparar o servidor', lines: [sc.warn(`O usuário ${form.user} não pode usar sudo neste servidor.`), 'Escolha "Prefiro fazer à mão" com um usuário que possa, ou volte e entre como root.'], question: 'Voltar', yesNo: false });
        continue;
      }
      let senha;
      if (plan.precisaSenha) {
        senha = await sc.text({ title: 'Preparar o servidor', mask: true, label: `Senha de ${form.user} para o sudo`, hint: 'usada uma vez, nesta conexão, e descartada em seguida' });
        if (senha === null) continue;
      }
      sc.busy('Preparar o servidor', '1 conexão · cerca de 10 segundos · não feche esta janela');
      const res = await inst.prepararAssistido({ senha });
      const marks = plan.acoes.map((a, i) => `${res.feitos.includes(a.id) ? sc.ok('✓') : sc.dim(String(i + 1))} ${a.titulo}`);
      if (res.ok) {
        await sc.confirm({ title: 'Preparar o servidor', lines: [...marks, '', sc.ok('Servidor pronto.'), 'A conexão administrativa foi encerrada e a senha descartada.', 'Daqui em diante o painel usa só o usuário dashmon.'], question: 'Continuar', yesNo: false });
        return 'next';
      }
      await sc.confirm({ title: 'Preparar o servidor', lines: [...marks, '', sc.crit(`✗ ${res.erro}`)], question: 'Voltar e tentar de novo', yesNo: false });
      plan = inst.planoPreparo({ from });
      continue;
    }
    // Manual: um bloco por vez; Enter testa sem mudar nada.
    for (const b of plan.blocos) {
      let error = '';
      for (;;) {
        const ok = await sc.confirm({
          title: `Preparar o servidor à mão · ${b.titulo}`,
          lines: [sc.dim(b.detalhe), '', b.id === 'pronto' ? 'Nada para colar: aperte Enter e fazemos uma coleta real.' : 'Cole no terminal DO SERVIDOR:', '', ...b.codigo.split('\n'), ...(error ? ['', sc.warn(`▲ ${error}`)] : [])],
          question: 'Aperte Enter para testar',
          yesNo: false,
        });
        if (ok === null) break;
        sc.busy('Preparar o servidor à mão', `testando "${b.titulo}"…`);
        const res = await inst.testarBloco(b.id);
        if (res.ok) break;
        error = res.erro;
      }
    }
    if (inst.preparo.concluido) return 'next';
  }
}

async function step6(sc, inst, out) {
  sc.step = 6;
  const r = inst.resumoTeste() || {};
  const systemd = inst.verificarComputador().systemd;
  const prefs = { boot: systemd, shortcut: true };
  const res = await sc.form({
    title: 'Tudo pronto. A primeira coleta já deu certo.',
    lines: [
      `memória ${r.memoriaPct ?? '—'}% · disco mais cheio ${r.discoPct ?? '—'}% · temperatura ${r.temperaturaC ?? '—'} °C · serviços ${r.servicosAtivos ?? 0}/${r.servicosTotal ?? 0}`,
      'CPU e rede aparecem na 2ª coleta.',
    ],
    groups: [{
      label: 'Do jeito que você preferir',
      rows: [
        { type: 'check', label: systemd ? 'Iniciar com o computador' : 'Iniciar com o computador (sem systemd de usuário neste sistema)', disabled: !systemd, get: () => prefs.boot, toggle: () => { prefs.boot = !prefs.boot; } },
        { type: 'check', label: 'Atalho no menu de aplicativos', get: () => prefs.shortcut, toggle: () => { prefs.shortcut = !prefs.shortcut; } },
      ],
    }],
    footer: ['No servidor: usuário dashmon, chave restrita e (se escolheu SMART) a regra de sudo para smartctl -H.', 'Para desfazer tudo, aqui e no servidor: dashboard desinstalar', 'Aperte "t" para ver o token de reserva (uma vez só).'],
    extraKeys: { t: () => { try { prefs.token = inst.tokenReserva(); } catch { /* já mostrado */ } } },
  });
  if (res === null) return 'back';
  sc.close();
  inst.concluir({ iniciarComComputador: prefs.boot, atalho: prefs.shortcut });
  return { prefs, token: prefs.token };
}

/** Roda os 6 passos no terminal. Devolve o código de saída. */
export async function runTui({ out, inst, input = process.stdin, output = process.stdout, open }) {
  if (!input.isTTY && input === process.stdin) {
    out.fail('a TUI precisa de um terminal interativo');
    out.explain('a entrada não é um terminal (veio de um pipe ou script).', 'para automatizar, use ./dashboard instalar --sem-interface (veja ./dashboard ajuda).');
    return 2;
  }
  if (input === process.stdin) {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
  }
  const sc = new Screen({ input, output, color: out.color });
  const form = { host: inst.servidor?.host || inst.verificarComputador().servidorAtual?.host || '', user: '', port: String(inst.verificarComputador().servidorAtual?.port || 22) };
  let result = null;
  try {
    let step = 1;
    while (step <= 6) {
      if (step === 1) { await step1(sc, inst); step = 2; continue; }
      const fn = { 2: () => step2(sc, inst, form), 3: () => step3(sc, inst, form), 4: () => step4(sc, inst), 5: () => step5(sc, inst, form), 6: () => step6(sc, inst, out) }[step];
      const r = await fn();
      if (r === 'back') step = Math.max(1, step - 1);
      else if (r === 'next') step += 1;
      else { result = r; break; }
    }
  } catch (err) {
    sc.close();
    if (input === process.stdin) { input.setRawMode(false); input.pause(); }
    output.write('\x1b[2J\x1b[H');
    inst.esquecerSenha();
    if (err instanceof Cancelled) { out.warn('configuração cancelada', 'nada foi gravado depois do último passo concluído'); return 1; }
    throw err;
  }
  if (input === process.stdin) { input.setRawMode(false); input.pause(); }
  output.write('\x1b[2J\x1b[H');
  out.title('Server Dashboard · instalação');
  out.ok('configuração concluída');
  if (result.token) {
    out.line(`  Token de reserva (aparece só agora): ${out.c.bold(result.token)}`);
    out.line();
  }
  const lig = await inst.ligarPainel(result.prefs);
  if (!lig.ok) { out.fail('o painel não subiu', lig.erro); return 1; }
  out.ok(lig.servico && lig.servico.ok ? 'painel rodando como serviço de usuário' : 'painel rodando em segundo plano');
  const opened = open ? open(lig.url) : false;
  if (!opened) {
    out.step('para abrir o painel já logado, use este link (vale uma vez, por 2 minutos):');
    out.line(`\n  ${lig.url}\n`);
    out.line(out.c.dim('Depois, use ./dashboard abrir para gerar outro.'));
  } else out.ok('painel aberto no navegador');
  return 0;
}
