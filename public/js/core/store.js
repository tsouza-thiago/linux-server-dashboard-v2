// Estado central da tela: um objeto só, atualizado por `set` e observado por `subscribe`.
export function createStore(initial = {}) {
  let state = { ...initial };
  const subscribers = new Set();
  return {
    get: () => state,
    // Junta o pedaço novo ao estado e avisa cada inscrito (estado completo + o que mudou).
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of subscribers) fn(state, next);
    },
    // Devolve a função que cancela a inscrição.
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
