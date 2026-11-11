# Formato da amostra

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

`schemaVersion: 2`, gerada por `server/collector/parser.js`. Dado ausente é `null`, nunca zero inventado. Taxas
(`cpu`, `rxMbps`, `readMBps`, `utilPct`…) são `null` na 1ª coleta, depois de um reboot ou com contador que voltou.
`rxDeltaBytes`/`txDeltaBytes` são os bytes trafegados desde a coleta anterior, exatos pelos contadores (o volume por
dia sai deles); são `null` nos mesmos casos e também com mais de 2 h entre as coletas. Exemplo (listas e colunas
encurtadas; a lista completa está em `server/collector/parser.js`):

```json
{
  "schemaVersion": 2, "ts": "2026-10-07T13:51:00.000Z",
  "collector": { "version": 2, "hash": "73cebb436c7c", "mode": "smart", "complete": true, "expectedVersion": 2, "durationMs": 1290, "outputBytes": 2949 },
  "host": "servidor-exemplo", "os": { "kernel": "6.12.0+deb13-amd64", "name": "Debian GNU/Linux 13 (trixie)" },
  "cores": 1, "uptimeSec": 12937.03, "bootAt": "2026-10-07T10:15:22.970Z", "load": [0.08, 0.02, 0.01],
  "cpuTicks": { "user": 102345, "idle": 1234567, "total": 1392845 },
  "cpu": { "pct": 3.2, "user": 2.1, "system": 0.9, "iowait": 0.2, "steal": 0 },
  "ram": { "total": 840, "used": 406, "free": 120, "cache": 479, "avail": 434, "swapTotal": 885, "swapUsed": 24, "dirty": 0, "writeback": 0 },
  "disks": [ { "mount": "/", "source": "/dev/sda2", "dev": "sda", "size": "100G", "used": "1.5G", "avail": "94G", "pct": 2,
               "sizeBytes": 107374182400, "usedBytes": 1610612736, "availBytes": 100394860544, "inodesPct": 3 } ],
  "missingMounts": [],
  "net": { "iface": "enp0s7", "rxBytes": 1752505, "rxErrors": 0, "rxDrops": 0, "txBytes": 771648, "txErrors": 0, "txDrops": 0,
           "rxMbps": 0.02, "txMbps": 0.01, "rxDeltaBytes": 150124, "txDeltaBytes": 74980 },
  "io": [ { "dev": "sda", "readIos": 15783, "writeIos": 3699, "ioTicksMs": 91540, "readMBps": 0.0, "writeMBps": 0.01, "utilPct": 0.4, "latencyMs": 6.1 } ],
  "psi": null, "temps": [ { "type": "acpitz", "c": 32 } ], "tempC": 32, "tempSensor": "acpitz",
  "smart": [ { "dev": "sda", "status": "PASSED" } ], "smartAt": "2026-10-07T13:51:00.000Z",
  "services": { "smbd": "active" },
  "topProcs": [ { "user": "root", "pid": 990, "cpu": 0.0, "mem": 11.4, "rssKB": 98520, "etimesSec": 12880, "cmd": "/usr/sbin/sshd" } ]
}
```

Amostras da V1 (sem `schemaVersion` e sem os campos novos) continuam válidas: o frontend trata campos ausentes.
