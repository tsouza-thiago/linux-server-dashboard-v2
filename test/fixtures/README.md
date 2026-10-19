# Fixtures de coleta

Saídas do comando de coleta usadas pelos testes do parser. Nunca versione saída real crua:
todo arquivo aqui passou por `npm run capturar-amostra` (anonimização) e por revisão humana.
A anonimização troca hostname, IPs, MACs e usuários, deixa só o `major.minor` da versão do
kernel e troca os processos fora de uma lista de programas genéricos por `/usr/bin/processoN`,
sem argumentos. Tamanhos e ocupação dos discos são trocados à mão por valores sintéticos.
`test/seguranca/segredos-osint.test.js` confere que rodar a anonimização de novo não muda as
fixtures que vieram do servidor real.

| Arquivo | Origem | Comando |
|---|---|---|
| `coleta-v2/debian13-real.txt` | coleta real anonimizada (07/10/2026), modo `smart`, ~2 min após boot; discos com valores sintéticos | V2 (`server/collector/`) |
| `coleta-v2/debian13-derivada-v1.txt` | derivada de uma coleta V1 anonimizada, convertida à mão para o formato V2 (sem PSI); discos com valores sintéticos | V2 |
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
