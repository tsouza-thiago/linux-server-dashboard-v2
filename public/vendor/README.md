# Bibliotecas de terceiros (versionadas no repositório)

Quem só usa o painel não roda `npm install` (D13). Por isso as bibliotecas do navegador
ficam aqui, com versão, origem e SHA-256 registrados em `vendor.json`. O teste
`test/unit/vendor.test.js` confere as somas a cada `npm run check`.

| Biblioteca | Versão | Licença | Uso |
|---|---|---|---|
| [uPlot](https://github.com/leeoniya/uPlot) | 1.6.32 | MIT | gráficos de séries temporais (ADR 0004) |
| [Geist e Geist Mono](https://github.com/vercel/geist-font) | 1.7.2 | OFL 1.1 | fontes da tela (D1), em `public/fonts/` (`dir: ../fonts`) |

## Atualizar

**uPlot**

1. `npm pack uplot@<versão>` numa pasta temporária e confira o `integrity` com `npm view uplot@<versão> dist.integrity`.
2. Copie `dist/uPlot.iife.min.js`, `dist/uPlot.min.css` e `LICENSE` (como `LICENSE.txt`) para `uplot/`.
3. Atualize versão, `integrity` e as somas em `vendor.json` (`sha256sum uplot/*`).
4. `npm run check` e teste a tela no navegador.

**Geist**

1. `npm pack geist@<versão>` numa pasta temporária e confira o `integrity` com `npm view geist@<versão> dist.integrity`.
2. Copie `dist/fonts/geist-sans/Geist-Variable.woff2` como `geist-variable.woff2`,
   `dist/fonts/geist-mono/GeistMono-Variable.woff2` como `geist-mono-variable.woff2` e
   `LICENSE.txt` como `OFL.txt` para `public/fonts/`.
3. Atualize versão, `integrity` e as somas em `vendor.json` (`sha256sum public/fonts/*`).
