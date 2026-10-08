// Detecção automática (passo 3 → 4 do assistente): 1 conexão de leitura com o usuário
// administrador para descobrir discos, pastas, rede, serviços, se o sudo funciona e onde
// está o smartctl. Nada é alterado no servidor. O script vai pelo stdin de `/bin/sh -s`
// (não aparece na lista de processos nem depende do shell de login do administrador).

/** Aspas simples POSIX: 'it'\''s'. */
export const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Script de detecção. Com senha, ela entra como variável do shell remoto (só em memória)
 * e é usada uma vez para conferir se o sudo aceita (`sudo -S -k`, que sempre pergunta).
 */
export function detectionScript({ password = '' } = {}) {
  if (/[\r\n\0]/.test(password)) throw new Error('senha com quebra de linha não é suportada');
  return [
    password ? `P=${shQuote(password)}` : "P=''",
    'LC_ALL=C; export LC_ALL',
    "echo '===WHO==='; id -un; id -u",
    "echo '===CLIENT==='; echo \"${SSH_CONNECTION%% *}\"",
    "echo '===OS==='; grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null; cat /proc/sys/kernel/hostname",
    "echo '===SUDO==='",
    'if [ "$(id -u)" = 0 ]; then echo root',
    'elif ! command -v sudo >/dev/null 2>&1; then echo ausente',
    'elif sudo -n true 2>/dev/null; then echo nopasswd',
    "elif [ -n \"$P\" ] && printf '%s\\n' \"$P\" | sudo -S -k -p '' true 2>/dev/null; then echo senha",
    'else echo nao; fi',
    'P=',
    "echo '===SMARTCTL==='; for p in /usr/sbin/smartctl /usr/bin/smartctl /sbin/smartctl /usr/local/sbin/smartctl; do [ -x \"$p\" ] && { echo \"$p\"; break; }; done; true",
    "echo '===SUDOBIN==='; command -v sudo 2>/dev/null; for p in /usr/sbin/visudo /usr/bin/visudo /sbin/visudo; do [ -x \"$p\" ] && { echo \"$p\"; break; }; done; true",
    "echo '===DASHMON==='; id -u dashmon 2>/dev/null; true",
    "echo '===LSBLK==='; lsblk -P -b -o NAME,KNAME,PKNAME,TYPE,SIZE,ROTA,TRAN,MODEL,MOUNTPOINT 2>/dev/null; true",
    "echo '===DF==='; df -B1 --output=source,fstype,size,used,avail,target -x tmpfs -x devtmpfs -x squashfs -x efivarfs 2>/dev/null; true",
    "echo '===NET==='; for i in /sys/class/net/*; do n=${i##*/}; w=cabo; [ -d \"$i/wireless\" ] && w=wifi; printf '%s %s %s\\n' \"$n\" \"$(cat \"$i/operstate\" 2>/dev/null)\" \"$w\"; done",
    "echo '===ROTA==='; awk '$2==\"00000000\"{print $1}' /proc/net/route 2>/dev/null; true",
    "echo '===SERVICES==='; systemctl list-units --type=service --state=running --no-legend --no-pager --plain 2>/dev/null | awk '{print $1}'; true",
    "echo '===FIM==='",
    '',
  ].join('\n');
}

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = /^===([A-Z]+)===$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

/** KEY="valor" do lsblk -P (aspas e \x20 do lsblk). */
export function parsePairs(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z:-]+)="((?:[^"\\]|\\.)*)"/g)) {
    out[m[1]] = m[2].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
  }
  return out;
}

const NET_SKIP = /^(lo|docker\d*|veth|br-|virbr|vnet|tun|tap|wg|zt|tailscale|cni|flannel|kube|ifb|sit|ip6tnl|ip6gre|gre|gretap|erspan|dummy|teql|ip_vti|ip6_vti|nlmon)/;
const SERVICE_SKIP = /^(systemd-|dbus|getty@|serial-getty@|user@|user-runtime-dir@|polkit|accounts-daemon|udisks2|upower|rtkit|packagekit|unattended-upgrades|ModemManager|NetworkManager|wpa_supplicant|networkd-dispatcher|multipathd|irqbalance|rsyslog|snapd|thermald|fwupd|chrony|chronyd|ntp|ntpd|avahi-daemon|cups|cups-browsed|colord|switcheroo|power-profiles|bluetooth|gdm|lightdm|sddm|atd|haveged|lvm2|mdmonitor|smartd|smartmontools|open-vm-tools|qemu-guest-agent|apport|kerneloops|whoopsie|containerd)\b/;

/** Serviços que vêm marcados por padrão (o que um servidor de casa costuma servir). */
const RECOMMENDED = [
  [/^(smbd|nmbd|samba|nfs-server|nfs-kernel-server|netatalk)$/, 'compartilhamento'],
  [/^(jellyfin|emby-server|plexmediaserver|minidlna|navidrome|kodi)/, 'mídia'],
  [/^(transmission-daemon|qbittorrent|deluged|sabnzbd|sonarr|radarr|lidarr|prowlarr)/, 'downloads'],
  [/^(nextcloud|syncthing|seafile|immich)/, 'arquivos'],
  [/^(nginx|apache2|httpd|caddy|lighttpd)$/, 'web'],
  [/^(mysql|mariadb|postgresql|redis-server|mongod)/, 'banco de dados'],
  [/^(docker|podman)$/, 'contêineres'],
  [/^(home-assistant|homeassistant|pihole-FTL|adguardhome|unbound|mosquitto|zigbee2mqtt)/, 'casa'],
];
const LABELS = [[/^(cron|crond)$/, 'tarefas agendadas'], [/^(ssh|sshd)$/, 'acesso remoto']];

function serviceInfo(name) {
  for (const [re, label] of RECOMMENDED) if (re.test(name)) return { recommended: true, label };
  for (const [re, label] of LABELS) if (re.test(name)) return { recommended: false, label };
  return { recommended: false, label: '' };
}

// Pseudo-discos ficam de fora; discos virtuais (VM) entram, mas sem SMART.
const PSEUDO_DISK = /^(loop|zram|ram|nbd|sr|md)\d/;
const VIRTUAL_DISK = /^(vd|xvd)[a-z]/;

/** Interpreta a saída da detecção num retrato do servidor, pronto para o passo 4. */
export function parseDetection(text) {
  const s = sections(text);
  if (!s.FIM) throw new Error('a detecção não terminou (saída cortada)');
  const first = (k) => (s[k] || []).map((l) => l.trim()).find(Boolean) || '';
  const who = (s.WHO || []).map((l) => l.trim()).filter(Boolean);
  const pretty = (s.OS || []).find((l) => l.startsWith('PRETTY_NAME='));
  const osName = pretty ? pretty.slice(12).replace(/^"|"$/g, '') : '';
  const hostname = (s.OS || []).map((l) => l.trim()).filter((l) => l && !l.startsWith('PRETTY_NAME='))[0] || '';
  const sudo = ['root', 'nopasswd', 'senha', 'nao', 'ausente'].includes(first('SUDO')) ? first('SUDO') : 'nao';
  const smartctl = first('SMARTCTL') || null;
  const sudoBin = (s.SUDOBIN || []).map((l) => l.trim()).filter(Boolean);

  const blocks = (s.LSBLK || []).map(parsePairs).filter((b) => b.NAME);
  const byKname = new Map(blocks.map((b) => [b.KNAME || b.NAME, b]));
  const diskOf = (b) => {
    let cur = b;
    for (let i = 0; cur && i < 8; i += 1) {
      if (cur.TYPE === 'disk') return cur.KNAME || cur.NAME;
      cur = byKname.get(cur.PKNAME);
    }
    return null;
  };
  const disks = blocks.filter((b) => b.TYPE === 'disk' && !PSEUDO_DISK.test(b.KNAME || b.NAME))
    .map((b) => ({
      name: b.KNAME || b.NAME,
      size: Number(b.SIZE) || null,
      rotational: b.ROTA === '1',
      transport: b.TRAN || '',
      model: b.MODEL || '',
      virtual: VIRTUAL_DISK.test(b.KNAME || b.NAME),
    }));

  const dfLines = (s.DF || []).map((l) => l.trim()).filter(Boolean);
  const mounts = [];
  for (const line of dfLines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const [source, fstype, size, used, avail] = parts;
    const target = parts.slice(5).join(' ');
    if (!target.startsWith('/') || /\s/.test(target)) continue;
    // Fora: pseudo-sistemas, arquivos montados por contêiner (/etc/hosts…) e camadas do Docker/Podman.
    if (/^\/(snap|run|proc|sys|dev|etc|var\/lib\/(docker|containers))(\/|$)/.test(target)) continue;
    if (fstype === 'overlay' && target !== '/') continue;
    const blk = blocks.find((b) => b.MOUNTPOINT === target) || byKname.get(source.replace(/^\/dev\//, ''));
    const sizeN = Number(size);
    mounts.push({
      target,
      source,
      fstype,
      size: sizeN,
      used: Number(used),
      pct: sizeN > 0 ? Math.round((Number(used) / sizeN) * 100) : null,
      avail: Number(avail),
      disk: blk ? diskOf(blk) : null,
      recommended: !target.startsWith('/boot') && sizeN >= 2 * 1024 ** 3,
    });
  }

  const defaults = new Set((s.ROTA || []).map((l) => l.trim()).filter(Boolean));
  const nets = (s.NET || []).map((l) => l.trim().split(/\s+/)).filter((p) => p[0] && !NET_SKIP.test(p[0]))
    .map(([name, state = '', kind = 'cabo']) => ({ name, up: state === 'up', wifi: kind === 'wifi', default: defaults.has(name) }));
  nets.sort((a, b) => Number(b.default) - Number(a.default) || Number(b.up) - Number(a.up) || a.name.localeCompare(b.name));

  const services = [...new Set((s.SERVICES || []).map((l) => l.trim().replace(/\.service$/, '')).filter((n) => /^[A-Za-z0-9@._-]+$/.test(n) && !n.includes('@')))]
    .filter((n) => !SERVICE_SKIP.test(n))
    .map((name) => ({ name, ...serviceInfo(name) }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name));

  return {
    user: who[0] || '',
    uid: who[1] !== undefined ? Number(who[1]) : null,
    clientIp: first('CLIENT'),
    os: osName,
    hostname,
    sudo,
    smartctl,
    // O dashmon precisa do sudo (e do visudo para validar a regra) para o teste SMART.
    smartPossible: Boolean(smartctl) && sudoBin.some((p) => p.endsWith('/sudo')) && sudoBin.some((p) => p.endsWith('/visudo')),
    dashmonExists: Boolean(first('DASHMON')),
    disks,
    mounts,
    nets,
    services,
  };
}

/**
 * Escolhas recomendadas (o que o passo 4 já mostra marcado): pastas grandes, SMART nos
 * discos físicos quando dá para usar (smartctl presente e sudo/root), a rede da rota
 * padrão e os serviços que um servidor de casa costuma servir.
 */
export function recommendedChoices(det) {
  const smartOk = det.smartPossible && ['root', 'nopasswd', 'senha'].includes(det.sudo);
  const mounts = det.mounts.filter((m) => m.recommended).map((m) => m.target);
  const usedDisks = new Set(det.mounts.filter((m) => mounts.includes(m.target)).map((m) => m.disk).filter(Boolean));
  const physical = det.disks.filter((d) => !d.virtual && usedDisks.has(d.name)).map((d) => d.name);
  const net = det.nets.find((n) => n.default) || det.nets.find((n) => n.up) || null;
  return {
    mounts: mounts.length ? mounts : ['/'],
    smart: smartOk ? physical : [],
    io: [...usedDisks],
    netIf: net ? net.name : '',
    services: det.services.filter((s) => s.recommended).map((s) => s.name),
  };
}

/**
 * Custo estimado da coleta no servidor, para o resumo do passo 4 (é estimativa: o painel
 * mede o custo real a cada coleta e mostra na faixa de status).
 */
export function estimateCost({ mounts = [], devs = [], services = [], netIf = '' } = {}) {
  const seconds = 0.45 + 0.05 * mounts.length + 0.04 * devs.length + 0.08 * services.length + (netIf ? 0.02 : 0);
  const kb = 3.2 + 0.25 * mounts.length + 0.2 * devs.length + 0.06 * services.length + (netIf ? 0.15 : 0);
  return { seconds: Math.round(seconds * 10) / 10, kb: Math.round(kb * 10) / 10 };
}
