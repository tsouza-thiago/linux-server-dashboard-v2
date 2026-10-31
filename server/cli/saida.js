// Saída da CLI no estilo de lista de conferência da instalação: uma linha por
// verificação com ✓ / ▲ / ✗ e o texto em português simples. Cores só num terminal de
// verdade e sem NO_COLOR (funciona igual sem cores).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

/** 1º arquivo executável `dashboard` nas pastas do PATH (o que `command -v` acha), ou null. */
export function primeiroNoPath(env = process.env) {
  for (const dir of String(env.PATH || '').split(':')) {
    if (!dir) continue;
    const file = path.join(dir, 'dashboard');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* não está nesta pasta do PATH */ }
  }
  return null;
}

/**
 * Como citar o comando nas mensagens (ADR 0028): `dashboard` quando esse nome, digitado
 * agora, roda ESTA pasta; `./dashboard` nos outros casos (sem link, fora do PATH ou outro
 * programa antes dele no PATH).
 */
export function comandoDashboard({ root = ROOT, env = process.env } = {}) {
  const file = primeiroNoPath(env);
  try {
    if (file && fs.realpathSync(file) === fs.realpathSync(path.join(root, 'dashboard'))) return 'dashboard';
  } catch { /* link quebrado ou pasta sem o script */ }
  return './dashboard';
}

/**
 * Cria a saída da CLI sobre `stream` (os testes passam um stream em memória). Devolve
 * funções para cada tipo de linha: título, ✓ ok, ▲ aviso, ✗ falha, → passo e explicação.
 */
export function makeOutput({ stream = process.stdout, env = process.env, root = ROOT } = {}) {
  const color = Boolean(stream.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
  // Pinta com um código ANSI só quando há cor; sem cor, devolve o texto puro.
  const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  const c = {
    ok: paint('32'),
    warn: paint('33'),
    crit: paint('31'),
    accent: paint('36'),
    dim: paint('2'),
    bold: paint('1'),
  };
  const write = (line = '') => stream.write(`${line}\n`);
  // Detalhe entre parênteses, apagado, depois do texto principal.
  const note = (text) => (text ? ` ${c.dim(`(${text})`)}` : '');
  return {
    color,
    c,
    // Lido a cada mensagem: a instalação cria o link no meio da saída.
    get cmd() { return comandoDashboard({ root, env }); },
    line: write,
    title: (text) => { write(c.bold(text)); write(); },
    ok: (text, detail) => write(`${c.ok('✓')} ${text}${note(detail)}`),
    warn: (text, detail) => write(`${c.warn('▲')} ${text}${note(detail)}`),
    fail: (text, detail) => write(`${c.crit('✗')} ${text}${note(detail)}`),
    step: (text) => write(`${c.accent('→')} ${text}`),
    /** "O que aconteceu / Como resolver", recuado (o formato de toda explicação de problema). */
    explain: (what, how) => {
      write();
      if (what) write(`  ${c.bold('O que aconteceu:')} ${what}`);
      if (how) write(`  ${c.bold('Como resolver:')} ${how}`);
      write();
    },
  };
}

/** O que a instalação fez com o comando no PATH, a partir do resultado de `prepararComando`. */
export function mostrarComando(out, r) {
  if (!r) return;
  const { nome, caminho, estado, alvo, outroAntes, noPath, cuidadoPor, edicao, arquivo, linha } = r;
  if (estado === 'outro-programa') {
    out.warn('o comando dashboard não foi criado', `${nome} já é outro programa e ficou como está`);
    return;
  }
  if (estado === 'outra-pasta') {
    out.warn('o comando dashboard continua na outra pasta', alvo);
    out.explain('', `para ele valer aqui, apague o ${nome} e rode a instalação de novo.`);
    return;
  }
  if (estado === 'falhou') {
    out.warn('não consegui criar o comando dashboard', 'use ./dashboard nesta pasta');
    return;
  }
  if (estado === 'trocado') out.ok('comando dashboard trocado', 'agora vale para esta pasta');
  else out.ok('comando dashboard pronto', nome);
  if (outroAntes) out.warn('outro dashboard vem antes no PATH', `vai rodar ${outroAntes}`);
  if (noPath) return;
  if (edicao?.estado === 'editado') {
    out.ok(`PATH acrescentado em ~/${edicao.arquivo}`, edicao.copia ? `cópia em ~/${edicao.copia}` : 'arquivo novo');
  } else if (!cuidadoPor) {
    out.warn('~/.local/bin não está no PATH', `acrescente esta linha no ~/${arquivo}: ${linha}`);
    return;
  }
  out.line(out.c.dim(`O comando vale no próximo login. Neste terminal, use o caminho completo: ${caminho}`));
}
