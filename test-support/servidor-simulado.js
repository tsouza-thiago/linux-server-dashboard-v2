// Servidor simulado para os scripts do preparo e da remoção (server/setup/preparo.js), que no
// servidor de verdade rodam como root. Aqui rodam como usuário comum numa pasta temporária:
// ~dashmon e /etc/sudoers.d viram pastas dela, e os comandos que só root roda (chown,
// useradd, userdel, passwd, visudo, install -o/-g) viram versões inofensivas no PATH.
// Assim os testes conferem o resultado de verdade do shell (linhas que ficam, arquivos que
// saem), não só o texto do script.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FAKES = {
  // O usuário dashmon "existe" enquanto o marcador existir.
  id: '[ -e "$SIM/usuario" ]',
  useradd: 'touch "$SIM/usuario"; mkdir -p "$SIM/home/dashmon"',
  userdel: 'rm -f "$SIM/usuario"; [ "$1" = -r ] && rm -rf "$SIM/home/dashmon"; true',
  passwd: 'true',
  chown: 'true',
  // visudo -cf <arquivo>: aceita só a regra do painel.
  visudo: 'grep -q "^dashmon ALL=(root) NOPASSWD: " "$2"',
  // install sem -o/-g (só root troca o dono); o resto vai para o install de verdade.
  install: [
    'skip=',
    'for a; do shift',
    '  if [ -n "$skip" ]; then skip=; continue; fi',
    '  case "$a" in -o|-g) skip=1; continue;; esac',
    '  set -- "$@" "$a"',
    'done',
    'PATH="$SIM_PATH" exec install "$@"',
  ].join('\n'),
};

/** Cria o servidor simulado; `usuario: false` começa sem o dashmon. */
export function simulatedServer({ usuario = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-servidor-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home', 'dashmon');
  const sudoers = path.join(dir, 'sudoers.d');
  for (const d of [bin, sudoers]) fs.mkdirSync(d, { recursive: true });
  if (usuario) {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'usuario'), '');
  }
  for (const [name, body] of Object.entries(FAKES)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const ak = path.join(home, '.ssh', 'authorized_keys');
  return {
    dir,
    sudoersDir: sudoers,
    /** Roda um script como se fosse root no servidor (sudo na frente das linhas é tirado). */
    run(script) {
      const input = script
        .replace(/(^|\|\| |&& )sudo /gm, '$1')
        .replaceAll('~dashmon', home)
        .replaceAll('/etc/sudoers.d', sudoers);
      return spawnSync('sh', ['-s'], {
        input,
        encoding: 'utf8',
        env: { ...process.env, SIM: dir, SIM_PATH: process.env.PATH, PATH: `${bin}:${process.env.PATH}` },
      });
    },
    /** Linhas do authorized_keys do dashmon ([] sem o arquivo). */
    keys: () => (fs.existsSync(ak) ? fs.readFileSync(ak, 'utf8').split('\n').filter(Boolean) : []),
    writeKeys: (lines) => fs.writeFileSync(ak, `${lines.join('\n')}\n`, { mode: 0o600 }),
    /** Arquivos em /etc/sudoers.d, em ordem. */
    sudoers: () => fs.readdirSync(sudoers).sort(),
    hasUser: () => fs.existsSync(path.join(dir, 'usuario')),
    stop: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
