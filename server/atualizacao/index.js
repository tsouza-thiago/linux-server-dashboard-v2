// Atualização pelo painel (ADR 0030): procura versão nova 1 vez por dia, guarda o resultado em
// data/atualizacao.json e avisa as telas. O trabalho pesado fica em procurar.js, num processo à
// parte; aqui só há a agenda e o estado. A troca de versão só é disparada daqui (ADR 0031): quem
// a faz é o `dashboard atualizar --registro`, num processo fora do serviço. A reconfiguração pela
// tela sai pelo mesmo caminho (ADR 0036): as 2 disputam a pasta, e uma precisa barrar a outra.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../stores.js';
import { compareVersions } from '../setup/assinatura.js';
import { criarCodigoPelaTela, lerResultadoPelaTela, retirarCodigoPelaTela } from '../setup/pela-tela.js';
import { emAndamento, lerRegistro, prepararRegistro, registrarFalha } from './registro.js';

const DIA_MS = 24 * 3600000;
// 1º teste ~5 min depois de o painel ligar, com até 1 h de atraso aleatório: as instalações
// não caem todas no mesmo minuto.
const PRIMEIRA_MS = 5 * 60000;
const ESPALHO_MS = 3600000;
// "Procurar agora": no máximo 1 vez por minuto.
export const MANUAL_MS = 60000;
// Teto do processo: um pouco acima dos 2 min do git dentro dele.
const TETO_PROCESSO_MS = 150000;
const MAX_SAIDA = 256 * 1024;
// Depois de disparar o `--pela-tela`, o painel cai em segundos, e nada mais dispara nesse tempo. Se
// o comando recusar, o painel fica no ar e, passado este tempo, o botão volta a valer (ADR 0036).
export const RECONFIGURAR_MS = 60000;
const PROCURAR_JS = fileURLToPath(new URL('./procurar.js', import.meta.url));

/**
 * Milissegundos até a próxima procura. Reiniciar o painel não adianta a procura: conta da
 * última verificação guardada, 1 vez por dia, e nunca antes dos ~5 min depois de ligar.
 */
export function esperaAteProcurar({ agora, verificadoEm, aleatorio }) {
  const ultima = Date.parse(verificadoEm);
  const falta = Number.isFinite(ultima) ? ultima + DIA_MS - agora : 0;
  return Math.max(PRIMEIRA_MS, falta) + Math.floor(aleatorio * ESPALHO_MS);
}

/** Roda o procurar.js com prioridade baixa e devolve o resultado; falha vira `erro`, sem exceção. */
export function procurarEmProcesso({ script = PROCURAR_JS, spawnFn = spawn, tetoMs = TETO_PROCESSO_MS } = {}) {
  return new Promise((resolve) => {
    let saida = '';
    const filho = spawnFn('nice', ['-n', '19', process.execPath, script], { cwd: path.dirname(script), stdio: ['ignore', 'pipe', 'ignore'], timeout: tetoMs });
    filho.stdout.on('data', (c) => { if (saida.length < MAX_SAIDA) saida += c; });
    filho.on('error', () => resolve({ erro: 'falhou' }));
    filho.on('close', () => {
      try { resolve(JSON.parse(saida)); } catch { resolve({ erro: 'falhou' }); }
    });
  });
}

// data/atualizacao.json: um objeto, não uma lista como os outros arquivos de JsonStore.
class ArquivoDeEstado extends JsonStore {
  load() {
    try {
      const salvo = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = salvo && typeof salvo === 'object' && !Array.isArray(salvo) ? salvo : {};
    } catch {
      this.data = {};
    }
  }
}

/** Estado da verificação de versão, com a agenda diária. */
export class Atualizacao {
  constructor({ file, instalada, loginExigido, procurar, acessoRestrito = false, root = path.dirname(file), modo = null, executar = null, conferirPasta = () => null, executarReconfiguracao = null, conferirReconfiguracao = () => null, procDir = '/proc', onChange = () => {}, log = () => {}, agora = Date.now, aleatorio = Math.random }) {
    this.instalada = instalada;
    this.loginExigido = loginExigido;
    this.procurar = procurar;
    this.acessoRestrito = acessoRestrito;
    this.root = root;
    this.modo = modo;
    this.executar = executar;
    this.conferirPasta = conferirPasta;
    this.executarReconfiguracao = executarReconfiguracao;
    this.conferirReconfiguracao = conferirReconfiguracao;
    this.procDir = procDir;
    this.onChange = onChange;
    this.log = log;
    this.agora = agora;
    this.aleatorio = aleatorio;
    this.arquivo = new ArquivoDeEstado({ file, defaults: {} });
    this.manualEm = 0;
    this.emCurso = null;
    this.reconfigurandoAte = 0;
    this.timer = null;
  }

  /** O que /api/atualizacao e o evento SSE mandam. Depois de atualizar, a versão guardada caduca. */
  estado() {
    const d = this.arquivo.data;
    const temNova = typeof d.nova === 'string' && compareVersions(d.nova, this.instalada) > 0;
    return {
      instalada: this.instalada,
      nova: temNova ? d.nova : null,
      novidades: temNova ? d.novidades ?? null : null,
      // Só o acesso restrito guarda o script no servidor; no direto, o painel manda o script novo.
      exigeReconfigurar: temNova && this.acessoRestrito && Boolean(d.novidades?.exigeReconfigurar),
      verificadoEm: d.verificadoEm ?? null,
      erro: d.erro ?? null,
      modo: this.modo,
      bloqueio: this.bloqueio(),
      // As falhas da última reconfiguração pela tela: a tela compara o instante com o do clique.
      reconfiguracao: lerResultadoPelaTela(path.join(this.root, 'data')),
    };
  }

  /** O que impede os 2 botões, Atualizar e Reconfigurar; null se nada impede. */
  impedimento() {
    // Sem login não há sessão, e qualquer programa da máquina poderia apertar o botão.
    if (!this.loginExigido) return 'sem-login';
    if (emAndamento(this.root, { agora: this.agora(), procDir: this.procDir })) return 'rodando';
    if (this.agora() < this.reconfigurandoAte) return 'rodando';
    return null;
  }

  /** Por que a tela não pode trocar de versão agora; null se pode. */
  bloqueio() {
    return this.impedimento() ?? this.arquivo.data.bloqueio ?? null;
  }

  /**
   * O botão Atualizar (I11): a versão do pedido só é comparada com a detectada, e nada dela vai
   * para o comando. Até o `prepararRegistro` não há `await`: 2 pedidos seguidos não passam
   * juntos. Devolve `{ status, corpo }`.
   */
  async trocarVersao(versao) {
    if (!this.executar) return { status: 409, corpo: { error: 'este painel não atualiza pela tela' } };
    const { nova, instalada, bloqueio } = this.estado();
    if (bloqueio) return { status: 409, corpo: { error: 'não dá para atualizar agora', bloqueio } };
    if (!nova || versao !== nova) return { status: 409, corpo: { error: 'esta não é a versão nova detectada' } };
    // O bloqueio guardado é da última procura: a pasta pode ter mudado de lá para cá.
    const agoraNaPasta = this.conferirPasta();
    if (agoraNaPasta) {
      this.arquivo.data = { ...this.arquivo.data, bloqueio: agoraNaPasta };
      await this.arquivo.save();
      this.onChange(this.estado());
      return { status: 409, corpo: { error: 'não dá para atualizar agora', bloqueio: agoraNaPasta } };
    }
    prepararRegistro(this.root, { alvo: nova, de: instalada, agora: this.agora() });
    this.onChange(this.estado());
    let iniciou;
    try { iniciou = await this.executar(); } catch { iniciou = { ok: false }; }
    if (!iniciou?.ok) {
      registrarFalha(this.root, 'não consegui iniciar a atualização', this.agora());
      this.log('[atualização] não consegui iniciar a troca de versão');
      this.onChange(this.estado());
      return { status: 503, corpo: { error: 'não consegui iniciar a atualização' } };
    }
    this.log(`[atualização] troca de versão iniciada: ${nova}`);
    return { status: 202, corpo: { alvo: nova } };
  }

  /**
   * O botão Reconfigurar (I11, ADR 0034 e 0036): nada do pedido chega aqui, e o código só sai nesta
   * resposta. Até `reconfigurandoAte` não há `await`: 2 pedidos seguidos não passam juntos, e um
   * 2º código não invalida o 1º. Devolve `{ status, corpo }`.
   */
  async reconfigurar() {
    if (!this.executarReconfiguracao) return { status: 409, corpo: { error: 'este painel não reconfigura pela tela' } };
    const bloqueio = this.impedimento() ?? this.conferirReconfiguracao();
    if (bloqueio) return { status: 409, corpo: { error: 'não dá para reconfigurar agora', bloqueio } };
    this.reconfigurandoAte = this.agora() + RECONFIGURAR_MS;
    const dados = path.join(this.root, 'data');
    try {
      const codigo = criarCodigoPelaTela(dados);
      if ((await this.executarReconfiguracao())?.ok) {
        this.log('[reconfiguração] assistente pedido pela tela');
        return { status: 202, corpo: { codigo } };
      }
    } catch { /* mesma saída de quando o executor não sobe */ }
    // Ninguém recebeu este código: ele não pode ficar valendo no disco.
    retirarCodigoPelaTela(dados);
    this.reconfigurandoAte = 0;
    this.log('[reconfiguração] não consegui iniciar o assistente');
    return { status: 503, corpo: { error: 'não consegui iniciar a reconfiguração' } };
  }

  /** O pedaço novo do log e o estado da troca de versão, para a tela de progresso. */
  registro(desde) {
    return lerRegistro(this.root, desde, { agora: this.agora(), procDir: this.procDir });
  }

  /** Uma procura; pedidos durante outra esperam a mesma. Nunca rejeita. */
  verificar() {
    this.emCurso ??= this._verificar().finally(() => { this.emCurso = null; });
    return this.emCurso;
  }

  async _verificar() {
    let r;
    try { r = await this.procurar(); } catch { r = { erro: 'falhou' }; }
    const anterior = this.arquivo.data;
    // Procura que falhou inteira (sem `nova`) mantém o que já se sabia.
    this.arquivo.data = { ...anterior, ...r, verificadoEm: new Date(this.agora()).toISOString() };
    await this.arquivo.save();
    const e = this.estado();
    if (e.nova && e.nova !== anterior.nova) this.log(`[atualização] versão nova disponível: ${e.nova}`);
    if (e.erro) this.log(`[atualização] não consegui procurar versão nova (${e.erro})`);
    this.onChange(e);
    return e;
  }

  /** "Procurar agora": null se ainda não passou 1 minuto da última. */
  verificarAgora() {
    if (this.agora() - this.manualEm < MANUAL_MS) return null;
    this.manualEm = this.agora();
    return this.verificar();
  }

  /** Liga a agenda: a procura seguinte só é marcada quando esta termina. */
  iniciar() {
    const espera = esperaAteProcurar({ agora: this.agora(), verificadoEm: this.arquivo.data.verificadoEm, aleatorio: this.aleatorio() });
    this.timer = setTimeout(() => { this.verificar().then(() => this.iniciar()); }, espera);
    this.timer.unref();
  }

  /** Desliga a agenda (encerramento do painel). */
  parar() {
    clearTimeout(this.timer);
  }

  flush() {
    return this.arquivo.flush();
  }
}
