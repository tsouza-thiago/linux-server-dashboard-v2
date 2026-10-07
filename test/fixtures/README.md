# Fixtures de coleta

Saídas do comando de coleta usadas pelos testes do parser. Nunca versione saída real crua:
todo arquivo aqui passou por `npm run capturar-amostra` (anonimização) e por revisão humana.

| Arquivo | Origem | Comando |
|---|---|---|
| `coleta-v1/debian13-1nucleo.txt` | servidor real do mantenedor, anonimizado (07/10/2026) | V1 (`free`, `df -h`, `grep` no `/proc/net/dev`) |
| `coleta-v2/*.txt` | derivadas da amostra real acima, no formato do comando V2 | V2 (`/proc` direto, ver `server/collector/`) |

Fatos de formato confirmados pela amostra real (Debian 13, kernel 6.12):

- `/proc/diskstats` tem 20 campos por linha (inclui discard e flush).
- `/proc/net/dev` separa nome e contador com espaço só enquanto o contador cabe em 7 dígitos;
  acima disso o número cola no nome (`enp0s7:123456789`) — bug B2 da V1.
- `smartctl -H` imprime `PASSED` quando há permissão; sem permissão não imprime nada (bug B1).
