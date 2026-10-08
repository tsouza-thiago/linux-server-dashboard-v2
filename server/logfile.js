// Log do painel (data/dashboard.log) com rotação simples: passou do limite, o atual vira
// dashboard.log.1 (o .1 anterior é descartado). Assim o log nunca cresce sem fim.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Gira o arquivo se ele passou de `maxBytes`. Devolve true quando girou. */
export function rotateIfNeeded(file, maxBytes = LOG_MAX_BYTES) {
  let size;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;
  fs.renameSync(file, `${file}.1`);
  try { fs.chmodSync(`${file}.1`, 0o600); } catch { /* best-effort */ }
  return true;
}

/**
 * Logger que grava em `file` (0600) e gira quando passa de `maxBytes`. A escrita é
 * síncrona (1 linha por minuto, em média): a conta de bytes e o giro ficam exatos.
 */
export function createLogFile(file, { maxBytes = LOG_MAX_BYTES } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  rotateIfNeeded(file, maxBytes);
  let fd = null;
  let bytes = 0;
  const open = () => {
    fd = fs.openSync(file, 'a', 0o600);
    try { fs.fchmodSync(fd, 0o600); } catch { /* best-effort */ }
    bytes = fs.fstatSync(fd).size;
  };
  open();
  return {
    write(line) {
      const text = Buffer.from(`${line}\n`);
      if (bytes > 0 && bytes + text.length > maxBytes) {
        fs.closeSync(fd);
        rotateIfNeeded(file, 0);
        open();
      }
      try {
        fs.writeSync(fd, text);
        bytes += text.length;
      } catch { /* disco cheio etc.: o painel continua, só sem log */ }
    },
    close() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  };
}
