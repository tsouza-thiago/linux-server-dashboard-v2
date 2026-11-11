# Alertas

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

Motor em `server/alerts/` (ADR 0006).

| Condição | Chave estável | Nível | Limiar |
|---|---|---|---|
| Disco usado ≥ limiar | `disk:<mount>:usage` | warning | `ALERT_DISK_PCT` |
| RAM usada ≥ limiar | `ram:usage` | warning | `ALERT_RAM_PCT` |
| Temperatura da CPU ≥ limiar | `temp:cpu` | warning | `ALERT_TEMP_C` |
| SMART `FAILED` (sem permissão ou sem smartctl é neutro) | `smart:<dev>` | critical | — |
| Serviço fora de `active`/`reloading`/`activating` (sem resposta é neutro) | `service:<nome>` | critical | — |
| Servidor inacessível depois de N falhas seguidas | `servidor-inacessivel` | critical | `ALERT_OFFLINE_AFTER` |

- **Chave estável**: a condição que continua atualiza o MESMO alerta (B3).
- **Histerese**: dispara no limiar e só limpa quando o valor cai `ALERT_HYSTERESIS` abaixo (disco e RAM em pontos de
  %, temperatura em °C).
- **Debounce do offline**: 1 falha isolada não alerta. A queda começa no instante da 1ª falha. Durante a queda, os
  outros alertas ficam como estão (nada foi medido).
- **Dado ausente** não cria nem resolve alerta.
- **Disponibilidade** (ADR 0018): conta só o **tempo medido**, as faixas de 5 min com pelo menos 1 amostra (bruta ou
  agregada) mais as quedas registradas (o painel estava rodando e tentando). Fórmula: 100 − fora do ar ÷ tempo medido
  × 100. Sem tempo medido, é `null` ("sem dados"), nunca 100%. Um dia sem nenhuma coleta fica cinza em Eventos e "sem
  dados" nos Relatórios. Os agregados guardam a cobertura em memória (`RollupStore.coverage`), lida do disco 1 vez.
- **Saúde 0–100** (`server/alerts/health.js`): começa em 100 e perde pontos por problema, a partir dos mesmos limiares
  dos alertas:
  - RAM: −15 no limiar, −5 a partir de 15 pontos abaixo dele;
  - disco: −15 no limiar, −5 a partir de 10 pontos abaixo;
  - temperatura: −15 no limiar, −25 a partir de 10 °C acima;
  - carga acima de 1,5 × núcleos: −10;
  - SMART `FAILED`: −40; serviço parado: −25;
  - offline ou sem dado: 0.

Faixas: 80–100 saudável, 50–79 atenção, 0–49 crítico. A tela só mostra o que vem em `/api/status` (`health`).
