// Carregado antes do uPlot. Com LANG=C, alguns Chromium informam navigator.language como
// "en-US@posix", que o Intl recusa; o uPlot chama Intl.NumberFormat(navigator.language) ao
// carregar e quebraria inteiro (sem nenhum gráfico). Nesse caso, usa pt-BR.
try {
  new Intl.NumberFormat(navigator.language);
} catch {
  Object.defineProperty(navigator, 'language', { get: () => 'pt-BR', configurable: true });
}
