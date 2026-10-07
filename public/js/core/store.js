// Estado central da tela: um objeto só, atualizado por `set` e observado por `subscribe`.
export function createStore(initial = {}) {
  let state = { ...initial };
  const subscribers = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of subscribers) fn(state, next);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

/**
 * Acrescenta uma amostra nova à lista, em ordem e sem repetir (backfill do SSE manda o que
 * a tela pode já ter). Mantém só o que cabe no período.
 */
export function appendSample(list, sample, { periodMs, max = 5000 } = {}) {
  if (!sample || !sample.ts) return list;
  const last = list.length ? list[list.length - 1].ts : '';
  if (sample.ts <= last) return list;
  const out = [...list, sample];
  if (periodMs) {
    const cutoff = Date.parse(sample.ts) - periodMs;
    while (out.length && Date.parse(out[0].ts) < cutoff) out.shift();
  }
  if (out.length > max) out.splice(0, out.length - max);
  return out;
}
