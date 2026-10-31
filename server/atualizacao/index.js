// Atualização pelo painel (ADR 0030): procura versão nova 1 vez por dia, guarda o resultado em
// data/atualizacao.json e avisa as telas. O trabalho pesado fica em procurar.js, num processo à
// parte; aqui só há a agenda e o estado.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../stores.js';
import { compareVersions } from '../setup/assinatura.js';

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
  constructor({ file, instalada, loginExigido, procurar, onChange = () => {}, log = () => {}, agora = Date.now, aleatorio = Math.random }) {
    this.instalada = instalada;
    this.loginExigido = loginExigido;
    this.procurar = procurar;
    this.onChange = onChange;
    this.log = log;
    this.agora = agora;
    this.aleatorio = aleatorio;
    this.arquivo = new ArquivoDeEstado({ file, defaults: {} });
    this.manualEm = 0;
    this.emCurso = null;
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
      verificadoEm: d.verificadoEm ?? null,
      erro: d.erro ?? null,
      // Sem login não há sessão, e qualquer programa da máquina poderia pedir a troca de versão.
      bloqueio: this.loginExigido ? d.bloqueio ?? null : 'sem-login',
    };
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
