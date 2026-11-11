# Comando SSH de coleta

Parte da referência técnica do projeto. As regras e o índice ficam no [AGENTS.md](../../AGENTS.md).

O script é montado por `server/collector/builder.js`. É um único script POSIX `sh`, somente leitura. Exemplo com
`NET_IF=enpXsY`, `DISK_MOUNTS=/ /mnt/disco1`, `DISK_DEVS=sda sdb` e `SERVICES=smbd nmbd`, no modo `smart`:

```sh
LC_ALL=C; export LC_ALL; M="${SSH_ORIGINAL_COMMAND:-smart}"; case "$M" in smart) ;; *) M=basico;; esac;
echo '===VER==='; echo '2 6443f6bd222e'; echo "$M";
echo '===HOST==='; cat /proc/sys/kernel/hostname;
echo '===OS==='; uname -r; grep -E '^(PRETTY_NAME|NAME)=' /etc/os-release 2>/dev/null;
echo '===CPU==='; getconf _NPROCESSORS_ONLN 2>/dev/null;
echo '===UPTIME==='; cat /proc/uptime;
echo '===LOAD==='; cat /proc/loadavg;
echo '===STAT==='; head -1 /proc/stat;
echo '===MEM==='; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree|Dirty|Writeback):' /proc/meminfo;
echo '===DF==='; df -B1 --output=source,target,size,used,avail,pcent,ipcent / /mnt/disco1 2>/dev/null;
echo '===NET==='; awk -F: -v i='enpXsY' '{n=$1; gsub(/[ \t]/,"",n)} n==i' /proc/net/dev;
echo '===IO==='; awk '$3=="sda"||$3=="sdb"' /proc/diskstats;
echo '===PSI==='; for f in cpu memory io; do printf '%s ' "$f"; grep -h . /proc/pressure/$f 2>/dev/null | tr '\n' ' '; echo; done;
echo '===TEMP==='; for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && printf '%s %s\n' "$(cat "$z/type" 2>/dev/null)" "$(cat "$z/temp" 2>/dev/null)"; done 2>/dev/null; true;
echo '===SMART==='; case "$M" in smart) for d in sda sdb; do
  if [ "$(id -u)" = 0 ]; then r=$(smartctl -H "/dev/$d" 2>&1); else r=$(sudo -n smartctl -H "/dev/$d" 2>&1); fi;
  case "$r" in *"result: PASSED"*|*"Health Status: OK"*) s=PASSED;; *"result: FAILED"*|*"Health Status: FAIL"*) s=FAILED;;
  *"smartctl: not found"*|*"smartctl: command not found"*) s=SEM_SMARTCTL;;
  *"sudo:"*|*ermission*|*"Operation not permitted"*) s=SEM_PERMISSAO;; *) s=DESCONHECIDO;; esac;
  printf '%s %s\n' "$d" "$s"; done;; *) echo pulado;; esac;
echo '===SERVICES==='; for s in smbd nmbd; do printf '%s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)"; done;
echo '===PS==='; ps -eo user:32,pid,pcpu,pmem,rss,etimes,args --sort=-rss 2>/dev/null | head -9;
echo '===FIM==='
```

- `LC_ALL=C` no início. As métricas vêm de `/proc` e `/sys`, imunes ao idioma.
- `ssh -o BatchMode=yes -o ConnectTimeout=10`: falha rápido se o servidor estiver fora.
- `NET`, `IO`, `SMART` e `SERVICES` só entram quando configurados. `===FIM===` marca a saída completa
  (`collector.complete`).
- `===VER===` traz a versão do coletor e um hash de 12 hex dos alvos. Hash diferente do esperado indica
  `authorized_keys` desatualizado (`hashMismatch`).
- **Modo** `basico` ou `smart`. O SMART roda **1 vez por hora**; nas outras coletas a seção imprime `pulado` e o
  último resultado é reaproveitado.
- **Comando forçado** (ADR 0008): o script vai para o `authorized_keys` do `dashmon` e o painel envia só a palavra do
  modo, que chega em `$SSH_ORIGINAL_COMMAND`, passa só pelo `case` da 1ª linha e nunca é executada nem ecoada. A 1ª
  linha abaixo vai para o `authorized_keys`, ao lado das dos outros computadores (ADR 0020); a 2ª, para
  `/etc/sudoers.d/dashboard-<computador>-<id>`. A regra única até a 2.1.0 (`/etc/sudoers.d/dashboard`) sai quando
  nenhuma linha sem ID sobrar.

  ```
  restrict,from="192.0.2.20",command="<script acima>" ssh-ed25519 AAAA… dashboard@notebook-a:3f9a12c4
  dashmon ALL=(root) NOPASSWD: /usr/sbin/smartctl -H /dev/sda, /usr/sbin/smartctl -H /dev/sdb
  ```

- SMART: root roda `smartctl -H` direto; outro usuário usa `sudo -n` (nunca pede senha). Estados: `PASSED`, `FAILED`,
  `SEM_PERMISSAO`, `SEM_SMARTCTL`, `DESCONHECIDO`.
- Temperatura: todas as `thermal_zone*`. Prioridade: `x86_pkg_temp` > `coretemp` > `k10temp` >
  `cpu-thermal`/`cpu_thermal`/`soc_thermal` > `acpitz` > maior valor.
- Falhas do SSH viram mensagens claras (`describeError()`).
