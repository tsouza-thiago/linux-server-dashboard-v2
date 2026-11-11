# Orçamento de desempenho

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

Definido no plano da V2 e revisto só depois de medir: RAM em 16 e 19/10/2026 (#26), pico dos pedidos de 90 dias em
26/10/2026 (#78) e página inicial de 300 para 450 KB em 30/10/2026, a pedido do mantenedor (#100).

| Medida | Limite | Medido | Como se confere |
|---|---|---|---|
| Tempo do comando no servidor | ≤ 1,5 s | 1,26–1,31 s (servidor real, 1 núcleo) | faixa de status e `./dashboard diagnosticar` |
| Tamanho da resposta | ≤ 16 KB | 2,9 KB (servidor real) | idem; acima de 1 MB a conexão é cortada |
| Página inicial | ≤ 450 KB transferidos | 293 KB (com gzip) | `test/e2e/telas.test.js` |
| RAM do Node com 72 h em memória | ≤ 95 MB | 88,5–90,4 MB (painel reiniciado com 72 h) | `npm run soak` |
| RAM do Node no pico dos pedidos de 90 dias | ≤ 120 MB | 113–115 MB (gráfico e Relatórios, 1 h e 15 min) | `npm run soak` (fase 3) |
| Memória depois que a janela de 72 h enche | sem crescer (≤ +4 MB) | +1,1 a +1,8 MB em 11 h a mais | `npm run soak` |

O Node 24 vazio usa ~44 MB e o painel sem histórico, ~63 MB. As amostras de 72 h ocupam ~12 MB de heap. Por isso o
painel sobe com `--max-semi-space-size=2` e `--optimize-for-size` (`server/node-flags.js`), nos 4 caminhos (serviço
systemd, segundo plano, `npm start` e o soak): sem a primeira, a geração jovem do V8 crescia até 32 MB; a segunda faz
o V8 coletar a geração velha mais cedo. Os pedidos de baldes de 90 dias leem 1 arquivo diário por vez, em blocos de 64
KB, e somam só números (`RollupStore.each` + `bucketMerger`); isso tirou o pico de 165–264 MB (#78) para ~115 MB.
Guardar as amostras em forma compacta não melhora o RSS (medido em 19/10/2026).
