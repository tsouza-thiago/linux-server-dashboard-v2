// Saída da CLI no estilo das pranchetas "Instalação · 1 comando no terminal": uma linha por
// verificação com ✓ / ▲ / ✗ e o texto em português simples. Cores só num terminal de
// verdade e sem NO_COLOR (funciona igual sem cores).

export function makeOutput({ stream = process.stdout, env = process.env } = {}) {
  const color = Boolean(stream.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
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
  const note = (text) => (text ? ` ${c.dim(`(${text})`)}` : '');
  return {
    color,
    c,
    line: write,
    title: (text) => { write(c.bold(text)); write(); },
    ok: (text, detail) => write(`${c.ok('✓')} ${text}${note(detail)}`),
    warn: (text, detail) => write(`${c.warn('▲')} ${text}${note(detail)}`),
    fail: (text, detail) => write(`${c.crit('✗')} ${text}${note(detail)}`),
    step: (text) => write(`${c.accent('→')} ${text}`),
    /** "O que aconteceu / Como resolver", recuado, como no diagnóstico das pranchetas. */
    explain: (what, how) => {
      write();
      if (what) write(`  ${c.bold('O que aconteceu:')} ${what}`);
      if (how) write(`  ${c.bold('Como resolver:')} ${how}`);
      write();
    },
  };
}
