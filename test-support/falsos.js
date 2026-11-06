// Dublês simples de `res` (Express-like) e de `spawn`, usados por vários testes unitários.
import { EventEmitter } from 'node:events';

/** `res` falso: guarda cabeçalhos (em minúsculas), `statusCode` e o corpo de `json()`. */
export function fakeRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    json: (obj) => { res.body = obj; return res; },
    status(code) { res.statusCode = code; return res; },
    headers,
  };
  return res;
}

/**
 * `spawn` falso: registra cada chamada em `chamadas` e chama `fim(filho)` no turno seguinte.
 * `unref()` marca a chamada com `unref: true` (quem dispara o processo solto chama isso).
 */
export function espiao(fim) {
  const chamadas = [];
  const spawnFn = (cmd, args, opts) => {
    chamadas.push({ cmd, args, opts });
    const filho = new EventEmitter();
    filho.unref = () => { chamadas.at(-1).unref = true; };
    setImmediate(() => fim(filho));
    return filho;
  };
  return { chamadas, spawnFn };
}
