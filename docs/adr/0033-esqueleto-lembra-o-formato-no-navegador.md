# ADR 0033 — Esqueleto lembra o formato do servidor no navegador

- **Status:** Aceita
- **Data:** 01/11/2026
- **Complementa:** a [ADR 0027](0027-esqueleto-no-formato-final-so-em-espera-longa.md) (esqueleto no
  formato final), na consequência que supunha 1 disco antes da 1ª amostra

## Contexto

A ADR 0027 aceitou um limite: antes da 1ª amostra, o esqueleto supõe 1 disco. Ao recarregar a página
de um servidor com vários discos, esse limite vira um pulo. Com 4 pastas em 3 discos, o painel
Atividade dos discos tinha 212 px no esqueleto e 364 px no fim, e a Saúde SMART descia 155 px (#121).
A tabela SMART e os cartões de pasta tinham o mesmo erro. O esqueleto também contava pastas onde
deviam entrar discos, então errava mesmo com a amostra na mão.

CSS não resolve: o número de blocos é um dado. A resposta da API que traria esse dado é a mesma
que o esqueleto espera.

## Decisão

1. **Contagens no navegador:** `core/formato.js` guarda em `localStorage` (`dash_formato`) quantas
   pastas, discos, linhas SMART e serviços a última amostra trouxe. Grava só quando elas mudam.
2. **Só números:** nenhum nome de pasta, disco ou serviço. O armazenamento do navegador fica fora
   das proteções de `data/`, então nada da rede interna entra nele. A regra estática CWE-922, que
   limita o que o navegador guarda, passou a aceitar só esta chave a mais, e os testes conferem o
   conteúdo: a unidade olha o formato, e o e2e olha o que ficou no navegador de verdade.
3. **A amostra vence:** com amostra, as contagens vêm dela. O valor guardado é um palpite para
   desenhar blocos. Valor inválido ou fora de 1–32 volta ao padrão (1 de cada), e armazenamento
   bloqueado também.
4. **Contagens separadas:** cartões usam as pastas; faixas de atividade usam os discos; a tabela e
   as etiquetas de saúde usam as linhas SMART.
5. **Estrutura real nos cartões da Visão geral:** o bloco de altura fixa saiu (`.card-skel` ficou só
   no esqueleto de reserva). A nota de exemplo quebra de linha onde o texto final quebraria, então
   a altura acerta em qualquer largura. Ícones finais guardam o lugar com `.skel-selo`, sem aparecer.
6. **Descartados:** incluir as contagens em `/api/session`, porque a rota responde sem login; e
   adiar o esqueleto até a configuração chegar, porque ela vem junto com o status.

## Consequências

- A 1ª visita de um navegador ainda supõe 1 disco. Depois da 1ª amostra, o formato fica certo.
- Um disco novo no servidor só muda o esqueleto depois da amostra seguinte, e isso é só um palpite
  errado por 1 carga: nada além dos blocos depende desse valor.
- Em Armazenamento, com 4 cartões a 1600 px, a etiqueta da previsão decide se os cartões quebram de
  linha. O teste `e2e: esqueleto (#121)` mede essa tela a 1920 px, como a ADR 0027 já fazia com as
  notas no limite da quebra.
- Uma tela nova que repete blocos por disco deve usar `formatoDe`, e não contar `sample.disks`.
