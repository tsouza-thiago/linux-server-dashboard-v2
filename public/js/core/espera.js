// Espera visível (F6, ADR 0027): quando mostrar "carregando" e por quanto tempo. Resposta rápida
// não mostra nada, e o que apareceu fica o bastante para ser lido, sem piscar.

// Só aparece depois disto; uma vez visível, fica pelo menos isto.
export const ATRASO_MS = 150;
export const MINIMO_MS = 300;

/**
 * Chama `mostrar` depois do atraso e devolve `fim()`. Ao chamar `fim()`, o atraso é cancelado se
 * `mostrar` ainda não rodou. O retorno é quantos ms faltam para o tempo mínimo (0 = pode trocar).
 */
export function esperaVisivel(mostrar, { atraso = ATRASO_MS, minimo = MINIMO_MS } = {}) {
  let visivelEm = null;
  const timer = setTimeout(() => { visivelEm = Date.now(); mostrar(); }, atraso);
  return () => {
    clearTimeout(timer);
    return visivelEm === null ? 0 : Math.max(0, minimo - (Date.now() - visivelEm));
  };
}

/** Promessa que resolve depois de `ms`. */
export const pausa = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
