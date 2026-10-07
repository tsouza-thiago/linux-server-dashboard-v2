# Fixtures de coleta

Saídas do comando de coleta usadas pelos testes do parser. Nunca versione saída real crua:
todo arquivo aqui passou por `npm run capturar-amostra` (anonimização) e por revisão humana.

| Arquivo | Origem | Comando |
|---|---|---|
| `coleta-v1/debian13-1nucleo.txt` | servidor real do mantenedor, anonimizado (07/10/2026) | V1 (`free`, `df -h`, `grep` no `/proc/net/dev`) |
| `coleta-v2/debian13-real.txt` | servidor real do mantenedor, anonimizado (07/10/2026), modo `smart`, ~2 min após boot; 901 ms ida e volta | V2 (`server/collector/`) |
| `coleta-v2/debian13-derivada-v1.txt` | derivada da amostra V1 acima, convertida à mão para o formato V2 (sem PSI) | V2 |
| `coleta-v2/casos-limite.txt` | sintética: contador colado, sem permissão, vários sensores, mount ausente | V2 |

Fatos de formato confirmados pela amostra real (Debian 13, kernel 6.12):

- `/proc/diskstats` tem 20 campos por linha (inclui discard e flush).
- `/proc/net/dev` separa nome e contador com espaço só enquanto o contador cabe em 7 dígitos;
  acima disso o número cola no nome (`enp0s7:123456789`) — bug B2 da V1.
- `smartctl -H` imprime `PASSED` quando há permissão; sem permissão não imprime nada (bug B1).
- `/proc/pressure/*` existe (kernel 6.12): 2 linhas por recurso, `some` e `full`, com
  `avg10`/`avg60`/`avg300`/`total`.
- `ps -eo user:32,...` alarga a coluna USER para 32 caracteres e rotula `etimes` como `ELAPSED`.
- O comando V2 completo (modo `smart`, 3 discos) leva ~0,9 s incluindo o handshake SSH.
