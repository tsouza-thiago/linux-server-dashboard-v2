# Bibliotecas de terceiros (versionadas no repositório)

Quem só usa o painel não roda `npm install` (D13). Por isso as bibliotecas do navegador
ficam aqui, com versão, origem e SHA-256 registrados em `vendor.json`. O teste
`test/unit/vendor.test.js` confere as somas a cada `npm run check`.

| Biblioteca | Versão | Licença | Uso |
|---|---|---|---|
| [uPlot](https://github.com/leeoniya/uPlot) | 1.6.32 | MIT | gráficos de séries temporais (ADR 0004) |

## Atualizar

1. `npm pack uplot@<versão>` numa pasta temporária e confira o `integrity` com `npm view uplot@<versão> dist.integrity`.
2. Copie `dist/uPlot.iife.min.js`, `dist/uPlot.min.css` e `LICENSE` (como `LICENSE.txt`) para `uplot/`.
3. Atualize versão, `integrity` e as somas em `vendor.json` (`sha256sum uplot/*`).
4. `npm run check` e teste a tela no navegador.
