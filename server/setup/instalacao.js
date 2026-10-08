// Os 6 passos da instalação (seção 11 do plano), em um só lugar: o assistente no navegador
// (web.js) e a TUI (tui.js) só desenham e chamam estes métodos, então os textos, a ordem e
// as checagens são os mesmos nos dois.
//
// A senha do administrador fica só na memória deste objeto, do passo 3 até o fim do
// passo 5 (ou até o assistente fechar), e é descartada em seguida. Nunca é gravada.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile } from '../config.js';
import { collect as collectV2, runSSH } from '../collector/index.js';
import { normalizeTargets } from '../collector/builder.js';
import { SSH_ALIAS, validHost, validIp, validPort, validUser } from './acesso.js';
import { detectionScript, parseDetection, recommendedChoices, estimateCost } from './deteccao.js';
import { preparationPlan, assistedScript, completedSteps } from './preparo.js';
import { probePort, scanHostKeys, fingerprintBlocks, runAdmin, describeAdminError, hostKeyAlgorithms } from './remoto.js';
import {
  ensureDataDirs, ensureKey, writeKnownHosts, writeSshConfig, updateEnv, ensureToken, installService, installShortcut, removeShortcut,
} from './local.js';
import { currentVersionStatus, describeVersion } from './assinatura.js';
import { createLoginCode } from '../http/entrar.js';
import { hasSystemdUser, panelPort, startPanel, stopPanel, unitPath } from '../cli/servico.js';

export const STEPS = ['Boas-vindas', 'Servidor', 'Conectar', 'O que monitorar', 'Preparar servidor', 'Pronto'];
export const THRESHOLD_LIMITS = { diskPct: [50, 99, 90], ramPct: [50, 99, 90], tempC: [30, 110, 60] };

export class InstallError extends Error {
  constructor(message, { status = 400, field } = {}) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

const fail = (msg, opts) => { throw new InstallError(msg, opts); };

/** Endereço e porta atuais do data/ssh/config (para o reconfigurar já vir preenchido). */
export function currentServer(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'data', 'ssh', 'config'), 'utf8');
    const host = (/^\s*HostName\s+(\S+)/m.exec(text) || [])[1] || '';
    const port = Number((/^\s*Port\s+(\d+)/m.exec(text) || [])[1] || 22);
    return validHost(host) ? { host, port } : null;
  } catch {
    return null;
  }
}

export class Instalacao {
  constructor({ root, home = os.homedir(), deps = {}, log = () => {} } = {}) {
    this.root = root;
    this.home = home;
    this.log = log;
    this.deps = {
      probePort, scanHostKeys, runAdmin, collect: collectV2, runSSH, ensureKey, installService, installShortcut,
      startPanel, stopPanel, hasSystemdUser, versionStatus: () => currentVersionStatus(root), spawnSync,
      ...deps,
    };
    this.reset();
  }

  reset() {
    this.servidor = null;
    this.identidades = [];
    this.identidade = null;
    this.deteccao = null;
    this.escolhas = null;
    this.limiares = null;
    this.chave = null;
    this.plano = null;
    this.preparo = { feitos: [], concluido: false, modo: 'assistido', from: true, testes: {} };
    this.teste = null;
    this.tokenMostrado = false;
    this.concluida = false;
    this.#senha = '';
  }

  #senha = '';

  /** Descarta a senha do administrador (fim do passo 5, cancelamento ou tempo esgotado). */
  esquecerSenha() { this.#senha = ''; }

  get temSenha() { return Boolean(this.#senha); }

  // ---- Passo 1: verificações deste computador --------------------------------------------

  verificarComputador() {
    const has = (cmd) => {
      const r = this.deps.spawnSync(cmd, ['-V'], { stdio: 'ignore' });
      return !r.error;
    };
    const ver = this.deps.versionStatus();
    const env = loadEnvFile(path.join(this.root, '.env'));
    return {
      versao: { ok: ver.ok, texto: ver.ok ? `versão ${ver.tag} assinada` : describeVersion(ver) },
      node: { ok: Number(process.versions.node.split('.')[0]) >= 24, texto: `Node.js ${process.versions.node.split('.')[0]} pronto` },
      ssh: { ok: has('ssh') && has('ssh-keygen'), texto: 'SSH disponível' },
      local: { ok: true, texto: 'painel só nesta máquina (127.0.0.1)' },
      systemd: this.deps.hasSystemdUser(),
      porta: panelPort(this.root),
      reconfigurar: Boolean(env.SSH_HOST && env.SSH_ACESSO),
      servidorAtual: currentServer(this.root),
    };
  }

  // ---- Passo 2: servidor -----------------------------------------------------------------

  async definirServidor({ host, user, port = 22 } = {}) {
    host = String(host ?? '').trim();
    user = String(user ?? '').trim();
    port = String(port ?? '22').trim() || '22';
    if (!validHost(host)) fail('Endereço inválido: use um IP (ex.: 192.0.2.10) ou um nome da rede.', { field: 'host' });
    if (!validUser(user)) fail('Usuário inválido: letras, números, ponto, _ e -.', { field: 'user' });
    if (!validPort(port)) fail('Porta inválida (1 a 65535).', { field: 'port' });
    const alcance = await this.deps.probePort(host, Number(port));
    if (!alcance.ok) {
      const msg = {
        'nome-desconhecido': 'Esse nome não foi encontrado na rede. Confira ou use o IP.',
        'porta-fechada': `O servidor respondeu, mas a porta ${port} está fechada. O SSH está ligado nele?`,
        inalcancavel: 'Não há caminho até esse endereço. Este computador está na mesma rede?',
        'sem-resposta': 'Ninguém respondeu nesse endereço. O servidor está ligado?',
      }[alcance.reason] || 'Não consegui falar com o servidor nesse endereço.';
      fail(msg, { field: 'host' });
    }
    const changed = !this.servidor || this.servidor.host !== host || this.servidor.port !== Number(port);
    if (changed) { this.identidades = []; this.identidade = null; this.deteccao = null; this.esquecerSenha(); }
    this.servidor = { host, user, port: Number(port) };
    return { ...this.servidor, ms: alcance.ms };
  }

  // ---- Passo 3: conectar -----------------------------------------------------------------

  async lerIdentidade() {
    if (!this.servidor) fail('Informe o servidor primeiro.');
    const keys = await this.deps.scanHostKeys(this.servidor.host, this.servidor.port);
    if (!keys.length) fail('O servidor não mostrou a identidade dele (o SSH está mesmo nessa porta?).');
    this.identidades = keys;
    const k = keys[0];
    return { type: k.type, fingerprint: k.fingerprint, blocos: fingerprintBlocks(k.fingerprint), conhecida: this.#identidadeConhecida(k) };
  }

  #identidadeConhecida(k) {
    try {
      return fs.readFileSync(path.join(this.root, 'data', 'ssh', 'known_hosts'), 'utf8').includes(`${k.type} ${k.key}`);
    } catch {
      return false;
    }
  }

  /**
   * Confirma a identidade (a pessoa comparou), grava no known_hosts do painel e abre a
   * única conexão de leitura: detecta discos, pastas, rede, serviços e o sudo.
   */
  async conectar({ senha = '', confirmo = false } = {}) {
    if (!this.servidor || !this.identidades.length) fail('Leia a identidade do servidor primeiro.');
    if (!confirmo) fail('Confirme que este é o seu servidor antes de enviar a senha.', { field: 'confirmo' });
    if (typeof senha !== 'string' || /[\r\n\0]/.test(senha) || senha.length > 1024) fail('Senha inválida.', { field: 'senha' });
    const k = this.identidades[0];
    ensureDataDirs(this.root);
    const knownHosts = writeKnownHosts(this.root, { host: this.servidor.host, port: this.servidor.port, type: k.type, key: k.key });
    this.identidade = k;
    const r = await this.deps.runAdmin({
      host: this.servidor.host, port: this.servidor.port, user: this.servidor.user, password: senha,
      knownHosts, hostKeyType: k.type, script: detectionScript({ password: senha }), timeoutMs: 60000,
    });
    if (r.code !== 0) fail(describeAdminError(r), { field: senha ? 'senha' : undefined, status: 422 });
    let det;
    try { det = parseDetection(r.stdout); } catch (err) { fail(`A leitura do servidor veio incompleta: ${err.message}`, { status: 422 }); }
    this.deteccao = det;
    this.#senha = senha;
    const rec = recommendedChoices(det);
    const env = loadEnvFile(path.join(this.root, '.env'));
    this.limiares = {
      diskPct: Number(env.ALERT_DISK_PCT) || 90,
      ramPct: Number(env.ALERT_RAM_PCT) || 90,
      tempC: Number(env.ALERT_TEMP_C) || 60,
    };
    this.escolhas = { ...rec };
    return this.resumoDeteccao();
  }

  resumoDeteccao() {
    const d = this.deteccao;
    if (!d) fail('Conecte ao servidor primeiro.');
    const diskByName = new Map(d.disks.map((x) => [x.name, x]));
    return {
      servidor: this.servidor,
      usuario: d.user,
      sudo: d.sudo,
      sudoTexto: { root: 'entrando como root', nopasswd: 'sudo disponível', senha: 'sudo disponível', nao: 'sem sudo para este usuário', ausente: 'sudo não instalado' }[d.sudo],
      podePreparar: ['root', 'nopasswd', 'senha'].includes(d.sudo),
      smartPossivel: d.smartPossible,
      smartMotivo: d.smartPossible ? '' : (!d.smartctl ? 'o smartctl não está instalado no servidor' : 'o sudo não está instalado no servidor'),
      os: d.os,
      hostname: d.hostname,
      clientIp: validIp(d.clientIp) ? d.clientIp : '',
      pastas: d.mounts.map((m) => {
        const disk = m.disk ? diskByName.get(m.disk) : null;
        return { ...m, virtual: Boolean(disk && disk.virtual), nota: m.recommended ? '' : 'pequena e quase nunca muda' };
      }),
      discos: d.disks,
      redes: d.nets,
      servicos: d.services,
      escolhas: this.escolhas,
      limiares: this.limiares,
      custo: estimateCost(this.#alvos(this.escolhas)),
    };
  }

  #alvos(e) {
    const mounts = e.mounts;
    const io = [...new Set(this.deteccao.mounts.filter((m) => mounts.includes(m.target)).map((m) => m.disk).filter(Boolean))];
    return normalizeTargets({ mounts, devs: io, smartDevs: e.smart, services: e.services, netIf: e.netIf });
  }

  // ---- Passo 4: o que monitorar ----------------------------------------------------------

  definirEscolhas({ mounts, smart = [], netIf = '', services = [], limiares = {} } = {}) {
    const d = this.deteccao;
    if (!d) fail('Conecte ao servidor primeiro.');
    const all = (list) => (Array.isArray(list) ? list : []).map(String);
    const validMounts = new Set(d.mounts.map((m) => m.target));
    const chosen = [...new Set(all(mounts))];
    if (!chosen.length) fail('Escolha pelo menos uma pasta.', { field: 'mounts' });
    if (!chosen.every((m) => validMounts.has(m))) fail('Pasta desconhecida no servidor.', { field: 'mounts' });
    const disks = new Set(d.mounts.filter((m) => chosen.includes(m.target)).map((m) => m.disk).filter(Boolean));
    const physical = new Set(d.disks.filter((x) => !x.virtual).map((x) => x.name));
    const smartList = [...new Set(all(smart))];
    if (smartList.length && !d.smartPossible) fail('O teste de saúde (SMART) não está disponível neste servidor.', { field: 'smart' });
    if (!smartList.every((x) => disks.has(x) && physical.has(x))) fail('SMART só em discos das pastas escolhidas.', { field: 'smart' });
    if (netIf && !d.nets.some((n) => n.name === netIf)) fail('Interface de rede desconhecida.', { field: 'netIf' });
    const svcNames = new Set(d.services.map((s) => s.name));
    const svc = [...new Set(all(services))];
    if (!svc.every((s) => svcNames.has(s))) fail('Serviço desconhecido no servidor.', { field: 'services' });
    const lim = {};
    for (const [key, [min, max, def]] of Object.entries(THRESHOLD_LIMITS)) {
      const v = limiares[key] === undefined || limiares[key] === '' ? (this.limiares?.[key] ?? def) : Number(limiares[key]);
      if (!Number.isInteger(v) || v < min || v > max) fail(`Valor fora da faixa (${min}–${max}).`, { field: key });
      lim[key] = v;
    }
    this.escolhas = { mounts: chosen, smart: smartList, io: [...disks], netIf: String(netIf || ''), services: svc };
    this.limiares = lim;
    this.plano = null;
    return { escolhas: this.escolhas, limiares: lim, custo: estimateCost(this.#alvos(this.escolhas)) };
  }

  // ---- Passo 5: preparar o servidor ------------------------------------------------------

  /** Plano com os comandos exatos (assistido) e os blocos (manual). */
  planoPreparo({ from = true } = {}) {
    if (!this.escolhas) fail('Escolha o que monitorar primeiro.');
    if (!this.chave) this.chave = this.deps.ensureKey({ home: this.home });
    const d = this.deteccao;
    const ip = validIp(d.clientIp) ? d.clientIp : '';
    this.preparo.from = Boolean(from && ip);
    this.plano = preparationPlan({
      adminUser: d.user || this.servidor.user,
      publicKey: this.chave.publicKey,
      targets: this.#alvos(this.escolhas),
      smartDevs: this.escolhas.smart,
      from: this.preparo.from ? ip : '',
      smartctl: d.smartctl || '/usr/sbin/smartctl',
    });
    return {
      acoes: this.plano.actions,
      comandos: this.plano.displayed,
      blocos: this.plano.manualBlocks,
      from: this.preparo.from,
      clientIp: ip,
      podeAssistido: ['root', 'nopasswd', 'senha'].includes(d.sudo) && (d.sudo !== 'senha' || this.temSenha),
      precisaSenha: d.sudo === 'senha' && !this.temSenha,
      sudo: d.sudo,
    };
  }

  /** Configuração local do painel (known_hosts já gravado no passo 3). */
  #configurarLocal() {
    const t = this.#alvos(this.escolhas);
    writeSshConfig(this.root, {
      host: this.servidor.host, port: this.servidor.port, keyFile: this.chave.file, hostKeyType: hostKeyAlgorithms(this.identidade.type),
    });
    updateEnv(this.root, {
      SSH_HOST: SSH_ALIAS,
      SSH_CONFIG: 'data/ssh/config',
      SSH_ACESSO: 'restrito',
      DISK_MOUNTS: t.mounts.join(' '),
      DISK_DEVS: t.devs.join(' '),
      SMART_DEVS: t.smartDevs.join(' '),
      NET_IF: t.netIf,
      SERVICES: t.services.join(' '),
      ALERT_DISK_PCT: this.limiares.diskPct,
      ALERT_RAM_PCT: this.limiares.ramPct,
      ALERT_TEMP_C: this.limiares.tempC,
    });
    return t;
  }

  /** Uma coleta de verdade com o usuário do painel, como vai ser todo minuto. */
  async testarColeta({ smart = false } = {}) {
    const t = this.#configurarLocal();
    const configFile = path.join(this.root, 'data', 'ssh', 'config');
    const targets = smart ? t : { ...t, smartDevs: [] };
    const res = await this.deps.collect({
      host: SSH_ALIAS, targets, access: 'restrito',
      runner: (h, c) => this.deps.runSSH(h, c, 30000, { configFile }),
    });
    if (!res.ok) return { ok: false, erro: `A coleta com o usuário dashmon falhou: ${res.error}` };
    const s = res.sample;
    if (!s.collector.complete) return { ok: false, erro: 'A coleta veio incompleta. Rode o teste de novo.' };
    if (s.collector.hashMismatch) return { ok: false, erro: 'O servidor ainda tem uma linha de chave antiga. Copie o bloco da chave de novo: ele já está atualizado.' };
    if (smart && t.smartDevs.length) {
      const semPermissao = (s.smart || []).filter((x) => x.status === 'SEM_PERMISSAO').map((x) => x.dev);
      const faltando = t.smartDevs.filter((dev) => !(s.smart || []).some((x) => x.dev === dev));
      const pendentes = [...new Set([...semPermissao, ...faltando])];
      if (pendentes.length) {
        return { ok: false, erro: `O servidor ainda não libera o teste de ${pendentes.join(', ')}. Copie o bloco de novo: ele já inclui ${t.smartDevs.length === 1 ? 'o disco' : `os ${t.smartDevs.length} discos`}.`, sample: s };
      }
    }
    this.teste = s;
    return { ok: true, sample: s, resumo: this.resumoTeste(s) };
  }

  resumoTeste(s = this.teste) {
    if (!s) return null;
    const ramPct = s.ram && s.ram.total ? Math.round((s.ram.used / s.ram.total) * 100) : null;
    const fullest = (s.disks || []).reduce((a, b) => (b.pct > (a?.pct ?? -1) ? b : a), null);
    const svc = Object.values(s.services || {});
    return {
      duracaoMs: s.collector.durationMs ?? null,
      bytes: s.collector.outputBytes ?? null,
      memoriaPct: ramPct,
      discoPct: fullest ? fullest.pct : null,
      discoMount: fullest ? fullest.mount : null,
      temperaturaC: s.tempC,
      servicosAtivos: svc.filter((x) => x === 'active').length,
      servicosTotal: svc.length,
    };
  }

  /** Modo assistido: 1 conexão administrativa, comandos exibidos antes, depois a coleta. */
  async prepararAssistido({ senha } = {}) {
    if (!this.plano) fail('Revise o plano primeiro.');
    const d = this.deteccao;
    if (typeof senha === 'string' && senha && !/[\r\n\0]/.test(senha)) this.#senha = senha;
    if (d.sudo === 'senha' && !this.#senha) fail('Digite a senha para o sudo.', { field: 'senha' });
    if (!['root', 'nopasswd', 'senha'].includes(d.sudo)) fail('Este usuário não pode usar sudo: use o modo "Prefiro fazer à mão" com um usuário que possa.');
    const script = assistedScript(this.plano.rootScript, { sudo: d.sudo, password: this.#senha });
    const r = await this.deps.runAdmin({
      host: this.servidor.host, port: this.servidor.port, user: this.servidor.user, password: this.#senha,
      knownHosts: path.join(this.root, 'data', 'ssh', 'known_hosts'), hostKeyType: this.identidade.type, script, timeoutMs: 120000,
    });
    const feitos = completedSteps(r.stdout);
    if (r.code !== 0 || !feitos.includes('chave') || !feitos.includes('sudoers')) {
      const senhaRecusada = /^@@erro senha$/m.test(r.stdout);
      this.preparo.feitos = senhaRecusada ? [] : ['sudo', ...feitos];
      if (senhaRecusada) this.esquecerSenha();
      const onde = this.plano.actions.find((a) => !this.preparo.feitos.includes(a.id));
      const motivo = senhaRecusada ? 'o sudo recusou a senha' : describeAdminError(r);
      return { ok: false, feitos: this.preparo.feitos, precisaSenha: senhaRecusada, erro: `Parou em "${onde ? onde.titulo : 'preparar'}": ${motivo}.` };
    }
    this.preparo.feitos = ['sudo', ...feitos];
    this.esquecerSenha();
    const teste = await this.testarColeta({ smart: true });
    if (!teste.ok) return { ok: false, feitos: this.preparo.feitos, erro: teste.erro };
    this.preparo.feitos.push('teste');
    this.preparo.concluido = true;
    this.preparo.modo = 'assistido';
    return { ok: true, feitos: this.preparo.feitos, resumo: teste.resumo };
  }

  /** Modo manual: o botão Testar de cada bloco confere sem mudar nada. */
  async testarBloco(id) {
    if (!this.plano) fail('Revise o plano primeiro.');
    let res;
    if (id === 'usuario') {
      const r = await this.deps.runAdmin({
        host: this.servidor.host, port: this.servidor.port, user: this.servidor.user, password: this.#senha,
        knownHosts: path.join(this.root, 'data', 'ssh', 'known_hosts'), hostKeyType: this.identidade.type,
        script: "id -u dashmon >/dev/null 2>&1 && echo '@@ok usuario'; getent passwd dashmon | cut -d: -f7\n", timeoutMs: 30000,
      });
      if (r.code !== 0) res = { ok: false, erro: describeAdminError(r) };
      else if (!completedSteps(r.stdout).includes('usuario')) res = { ok: false, erro: 'O usuário dashmon ainda não existe no servidor. Cole o bloco 1 de novo.' };
      else res = { ok: true };
    } else if (id === 'chave' || id === 'pronto') {
      res = await this.testarColeta({ smart: false });
    } else if (id === 'sudoers') {
      res = this.escolhas.smart.length ? await this.testarColeta({ smart: true }) : { ok: true };
    } else {
      fail('Bloco desconhecido.');
    }
    this.preparo.testes[id] = res.ok;
    const ids = this.plano.manualBlocks.map((b) => b.id);
    if (ids.every((b) => this.preparo.testes[b])) {
      this.preparo.concluido = true;
      this.preparo.modo = 'manual';
      this.preparo.feitos = ['sudo', ...this.plano.actions.map((a) => a.id)];
      this.esquecerSenha();
    }
    return { ...res, sample: undefined, conferidos: ids.filter((b) => this.preparo.testes[b]).length, total: ids.length, concluido: this.preparo.concluido };
  }

  // ---- Passo 6: pronto -------------------------------------------------------------------

  /** Token de reserva: mostrado uma vez só. */
  tokenReserva() {
    if (!this.preparo.concluido) fail('Termine a preparação primeiro.');
    if (this.tokenMostrado) fail('O token já foi mostrado. Para ver de novo, abra o .env desta pasta.', { status: 409 });
    this.tokenMostrado = true;
    return ensureToken(this.root).token;
  }

  /**
   * Conclui: grava o .env final, cria o token (se faltar), aplica as preferências (serviço
   * que inicia com o computador, atalho) e devolve o link de entrada de uso único. Quem
   * chama (web/TUI) fecha o assistente e só então liga o painel, que usa a mesma porta.
   */
  concluir({ iniciarComComputador = true, atalho = true } = {}) {
    if (!this.preparo.concluido) fail('Termine a preparação primeiro.');
    this.#configurarLocal();
    ensureToken(this.root);
    this.esquecerSenha();
    if (atalho) this.deps.installShortcut({ root: this.root, home: this.home });
    else removeShortcut({ home: this.home });
    this.concluida = true;
    return { iniciarComComputador: Boolean(iniciarComComputador), atalho: Boolean(atalho) };
  }

  /** Liga o painel depois que o assistente liberou a porta. */
  async ligarPainel({ iniciarComComputador = true } = {}) {
    let servico = null;
    // Com systemd de usuário, o serviço é (re)instalado; "iniciar com o computador" desligado
    // deixa o serviço sem `enable`, para ligar só quando a pessoa abrir o painel.
    if (this.deps.hasSystemdUser() && (iniciarComComputador || fs.existsSync(unitPath(this.home)))) {
      servico = await this.deps.installService({ root: this.root, home: this.home, enable: Boolean(iniciarComComputador) });
    }
    if (!servico || !servico.ok) {
      const r = await this.deps.startPanel({ root: this.root, home: this.home });
      if (!r.ok) return { ok: false, erro: r.error, servico };
    }
    const port = panelPort(this.root);
    const code = createLoginCode(path.join(this.root, 'data'));
    return { ok: true, servico, url: `http://127.0.0.1:${port}/entrar?codigo=${code}` };
  }
}
