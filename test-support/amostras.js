// Amostras mínimas e relógio fixo para os testes de armazenamento e de histórico.

/** Gera `at(min)`: o instante ISO de `base` + `min` minutos. */
export function relogio(base) {
  return (min) => new Date(base + min * 60000).toISOString();
}

/** Amostra mínima de `at(min)`, com temperatura (padrão 40) e carga fixa. */
export function amostraMin(at) {
  return (min, tempC = 40) => ({ ts: at(min), host: 'srv', tempC, load: [0.1, 0.1, 0.1] });
}

/** Log mudo, para o `log` dos stores. */
export const silent = () => {};
