// Formato do servidor para os esqueletos (ADR 0033): quantas pastas, discos, linhas SMART e
// serviços a última amostra trouxe. Antes da 1ª amostra de uma página recarregada, só o navegador
// sabe disso. Guarda apenas as contagens, nenhum nome: é um palpite para desenhar blocos, e a
// amostra de verdade sempre vence.

const FORMATO_KEY = 'dash_formato';
// Sem nada guardado (1ª visita, armazenamento bloqueado), a tela supõe o menor servidor.
const PADRAO = Object.freeze({ pastas: 1, discos: 1, smart: 1, servicos: 1 });
// Teto do valor lido: o que vem do armazenamento não decide quantos blocos a tela cria.
const MAXIMO = 32;

const contar = (sample) => ({
  pastas: Math.max(1, sample.disks?.length || 0),
  discos: Math.max(1, sample.io?.length || 0),
  smart: Math.max(1, sample.smart?.length || 0),
  servicos: Math.max(1, Object.keys(sample.services || {}).length),
});

const valido = (n) => Number.isInteger(n) && n >= 1 && n <= MAXIMO;

function lido() {
  try {
    const salvo = JSON.parse(localStorage.getItem(FORMATO_KEY));
    return Object.keys(PADRAO).every((k) => valido(salvo?.[k])) ? salvo : PADRAO;
  } catch {
    return PADRAO; // armazenamento bloqueado ou texto que não é JSON
  }
}

/** Contagens para o esqueleto: as da amostra, se já veio; senão, as lembradas. */
export const formatoDe = (sample) => (sample ? contar(sample) : lido());

/** Lembra as contagens da amostra. Só grava quando mudam: a amostra chega a cada minuto. */
export function lembrarFormato(sample) {
  if (!sample) return;
  const novo = JSON.stringify(contar(sample));
  try {
    if (localStorage.getItem(FORMATO_KEY) !== novo) localStorage.setItem(FORMATO_KEY, novo);
  } catch { /* armazenamento bloqueado */ }
}
