// Leitura de arquivo para os testes que conferem permissão E conteúdo.
//
// Conferir o modo com `statSync(caminho)` e depois ler com `readFileSync(caminho)` são dois
// acessos ao mesmo nome: entre um e outro o arquivo poderia ser trocado (TOCTOU, CWE-367;
// o CodeQL aponta como js/file-system-race). Aqui o arquivo é aberto uma vez só, e modo e
// conteúdo vêm do mesmo descritor.
import fs from 'node:fs';

/** `{ modo, texto }` do arquivo: modo são os bits de permissão (ex.: 0o600). */
export function lerComModo(arquivo) {
  const fd = fs.openSync(arquivo, 'r');
  try {
    return { modo: fs.fstatSync(fd).mode & 0o777, texto: fs.readFileSync(fd, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}
