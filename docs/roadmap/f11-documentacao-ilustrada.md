# F11 — README e TUTORIAL ilustrados

- **Nível:** M · **Versão:** sai nas notas da 2.4.0 · **Área:** documentação · **Issue:** #106

## Objetivo

Mostrar o painel antes de pedir a instalação. O README e o TUTORIAL ganham prints das telas e
outros elementos gráficos, para o projeto ficar mais ilustrativo e chamativo.

## Situação hoje

- O README e o TUTORIAL não têm nenhuma imagem.
- O `npm run painel-teste` sobe o painel com dados semeados e tem cenários (`normal`, `lacunas`,
  `offline`, `vazio`). Ele serve de fonte segura para os prints.
- O `playwright-core` já é devDependency e abre as telas no e2e.
- `test/unit/docs.test.js` confere os links, e `test/seguranca/segredos-osint.test.js` confere o
  texto do repositório. Nenhum dos 2 enxerga o conteúdo de uma imagem.

## Decisão

1. **Prints das telas:** as 8 telas do painel, nos 2 temas, mais o login e os passos do
   assistente. O README mostra a Visão geral em destaque e uma galeria curta. O TUTORIAL põe cada
   print no passo que ele ilustra.
2. **Só dados de teste:** todo print sai do painel de teste. Nenhuma imagem sai de uma instalação
   real. Antes do commit, cada imagem é conferida à mão: nada de IP real, nome de máquina ou
   caminho da pasta pessoal.
3. **Captura por script:** `scripts/capturar-telas.mjs` abre o painel de teste com o
   `playwright-core` e grava tudo em `docs/img/`. Quando uma tela mudar, basta rodar de novo.
4. **Tema do leitor:** `<picture>` com `prefers-color-scheme` mostra o print escuro ou o claro,
   conforme o tema do GitHub.
5. **Elementos gráficos além dos prints:**
   - banner no topo do README, com a marca do painel;
   - diagrama da arquitetura em SVG, no lugar do desenho em texto do README;
   - ícones nos títulos das seções principais, em SVG, nas 2 cores;
   - blocos de aviso do GitHub (`[!NOTE]`, `[!WARNING]`) no TUTORIAL;
   - animação curta da troca de tela e do hover, com poucos segundos.
6. **Imagens no repositório:** elas ficam em `docs/img/`, com caminho relativo e texto
   alternativo. Nada de hospedagem externa.
7. **Orçamento:** até 200 KB por print e 3 MB em `docs/img/`. As imagens não entram em `public/`,
   então o limite da página inicial não muda.

### Alternativas

- **Prints à mão:** ficam velhos a cada mudança de tela e podem levar um dado real por descuido.
- **Hospedagem externa de imagens:** o link pode quebrar, e a imagem fica fora do histórico.
- **Vídeo:** pesa mais e não abre direto no README. A animação curta cobre o movimento.

## Etapas

1. Script de captura com os prints do painel, nos 2 temas.
2. README: banner, Visão geral, galeria e diagrama da arquitetura.
3. TUTORIAL: um print por passo do assistente e por tela, com os blocos de aviso.
4. Ícones nos títulos e animação curta.
5. Teste novo: toda imagem citada existe, tem texto alternativo e respeita o orçamento.

## Testes

- `test/unit/docs.test.js`: imagem citada existe, tem texto alternativo e cabe no orçamento.
- `test/seguranca/segredos-osint.test.js`: continua verde, com os SVG incluídos.
- Revisão manual: abrir o README e o TUTORIAL no GitHub, nos 2 temas.

## Riscos

- **Vazamento em imagem:** nenhum teste lê um print. Mitigação: só o painel de teste e a
  conferência à mão do item 2.
- **Print velho:** a tela muda e a imagem fica para trás. Mitigação: o script refaz tudo, e a
  bateria de cada versão confere os prints.
- **Repositório pesado:** cada versão de imagem fica no histórico para sempre. Mitigação: o
  orçamento, e só refazer o print quando a tela mudar de forma visível.
- **Depende da F6:** o skeleton muda o que aparece nas telas, então os prints saem depois dela.
