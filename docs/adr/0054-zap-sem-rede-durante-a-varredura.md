# ADR 0054 — ZAP sem rede durante a varredura e imagem baixada fora do limite

- **Status:** Aceita
- **Data:** 11/11/2026
- **Complementa:** a [ADR 0040](0040-ci-em-jobs-paralelos-com-limite-de-tempo.md) (decisão 4, limite de tempo por etapa)
  e a [ADR 0014](0014-verificacao-de-seguranca-continua.md) (imagens presas por digest)

## Contexto

No push da v2.6.5 no `main`, a etapa `zap` do `npm run seguranca` passou do limite de 300 s e reprovou
(#202). A repetição do mesmo job, sem mudança, passou em 53 s. Nas 40 execuções anteriores, a etapa levou
de 47 s a 68 s: o travamento foi um caso isolado, não uma varredura lenta. O log do CI não dizia em que
fase o tempo foi gasto: a saída do ZAP era descartada.

A medição local mostrou 2 dependências de rede dentro do limite da etapa:

1. **A imagem** do ZAP (3,7 GB) era baixada pelo próprio `docker run`, e o tempo do download contava no
   limite da varredura.
2. **Os add-ons.** O scan empacotado (`zap-api-scan.py`), sem `-silent`, roda com `-addonupdate` e
   `-addoninstall pscanrulesBeta`: a cada execução, baixa da internet cerca de 90 MB de add-ons
   (atualizações, Selenium, WebDriver e as regras passivas beta). Isso gastava 13 s da partida (24 s
   contra 11 s) e fazia as regras mudarem de versão sozinhas, fora do digest fixado da imagem.

## Decisão

1. **O ZAP roda com `-silent`**: sem atualizar nem instalar add-on da internet. Valem os add-ons da
   imagem fixada por digest.
2. **As regras passivas beta continuam.** O script baixa só o `pscanrulesBeta` (596 KB) de URL e SHA-256
   fixos (`ZAP_BETA` em `scripts/seguranca.mjs`), guarda em `.seguranca/cache/`, confere o hash a cada
   uso e o monta só leitura em `/zap/plugin/`. Cada uma das 6 regras dele precisa aparecer na saída do
   ZAP; senão a etapa reprova (o add-on não carregou). Trocar de versão é um commit consciente, como as
   imagens.
3. **A imagem de cada etapa Docker é baixada antes**, com limite próprio (150 s) e 1 repetição, fora do
   limite da etapa. O tempo do download aparece à parte na linha da etapa.
4. **Os tetos internos do ZAP somam menos que o limite**: partida e varredura passiva até 1 min cada
   (`-T 1`) e varredura ativa até 2 min. O ZAP termina com relatório ou com erro próprio antes de ser
   derrubado.
5. **A saída do ZAP fica em `.seguranca/zap.log`**, com depuração (`-d`) e os segundos desde o início. Se a
   etapa falhar ou estourar, as últimas 8 linhas vão para o log do CI.

## Consequências

- A varredura não sai da máquina para a internet: as regras são as mesmas em toda máquina e no CI.
- A etapa ficou mais curta (37 s contra 24 s na máquina do mantenedor), sem perder regra beta.
- Sai a regra 20020 (versão de tecnologia com vulnerabilidade conhecida), que só vinha numa atualização
  baixada na hora. O painel não expõe versão de servidor; as dependências ficam com o OSV-Scanner.
- Um download preso (imagem ou add-on) reprova com mensagem própria, e não como varredura lenta.
- O `test/seguranca/cadeia-suprimentos.test.js` confere o `-silent`, o SHA-256 do add-on e a lista das
  regras beta.
