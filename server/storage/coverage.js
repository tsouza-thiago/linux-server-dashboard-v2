// Tempo medido (ADR 0018): intervalos [início, fim) em ms em que o painel estava coletando.
// Vêm das faixas de 5 min com amostra (brutas e agregadas) e das quedas registradas, e
// viram uma lista curta, ordenada e sem sobreposição: com o painel ligado o tempo todo, é
// 1 intervalo só, por mais dias que sejam.

/** Junta intervalos [a, b) que se tocam ou se sobrepõem; descarta os vazios ou inválidos. */
export function mergeSpans(spans) {
  const list = spans
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of list) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Corta os intervalos à janela [fromMs, toMs]. */
export function clipSpans(spans, fromMs, toMs) {
  const out = [];
  for (const [a, b] of spans) {
    const x = Math.max(a, fromMs);
    const y = Math.min(b, toMs);
    if (y > x) out.push([x, y]);
  }
  return out;
}

/** Soma (ms) dos intervalos. */
export const spansMs = (spans) => spans.reduce((n, [a, b]) => n + (b - a), 0);

/** Intervalos em ISO, como a API devolve: [{ from, to }]. */
export const spansToIso = (spans) => spans.map(([a, b]) => ({ from: new Date(a).toISOString(), to: new Date(b).toISOString() }));
