// Preparar o servidor (passo 5 da instalação, ADR 0011): os mesmos comandos servem aos dois
// modos.
// - assistido: rodam como root numa única chamada de sudo (`sudo -S -k`, a senha vai uma
//   vez pelo stdin e nunca para a linha de comando), depois do "Confirmar";
// - manual: viram blocos para colar no servidor, com `sudo` na frente de cada linha.
// Tudo é idempotente (rodar de novo atualiza a chave e a regra) e reversível
// (removalScript, usado pelo `dashboard desinstalar`).
// Vários computadores podem monitorar o mesmo servidor (ADR 0020): cada instalação troca só
// a SUA linha do authorized_keys e o SEU arquivo do sudoers, achados pelo ID da instalação.
import {
  authorizedKeysLine, sudoersLine, installId, installNames, validInstallId, validLabel, validPublicKey, KEY_COMMENT, NAME_PREFIX, PANEL_USER,
} from './acesso.js';
import { shQuote } from './deteccao.js';

/**
 * Regra de sudo das versões até a 2.1.0, um arquivo só para todos os computadores. Fica
 * enquanto alguma linha antiga (sem ID) continuar no authorized_keys. O docs.test confere
 * os nomes de arquivo do sudoers da documentação contra esta constante.
 */
export const SUDOERS = '/etc/sudoers.d/dashboard';
/** Arquivo do sudoers de uma instalação: /etc/sudoers.d/dashboard-<computador>-<id>. */
export function sudoersFile(label, id) {
  if (!validLabel(label) || !validInstallId(id)) throw new Error('nome da instalação inválido');
  return `${SUDOERS}-${label}-${id}`;
}
// Marcadores dos heredocs: a chave, a regra e o script inteiro entram pelo stdin, sem eco.
const KEY_EOF = 'FIM_DA_CHAVE';
const SUDOERS_EOF = 'FIM_DA_REGRA';
const STEP_EOF = 'FIM_DO_PASSO';
const SCRIPT_EOF = 'FIM_DO_PREPARO';

// "sda, sdb e sdc" para os textos da tela.
const DEVS_TEXT = (devs) => (devs.length > 1 ? `${devs.slice(0, -1).join(', ')} e ${devs.at(-1)}` : devs[0]);

/**
 * Copia o authorized_keys para authorized_keys.novo sem as linhas desta instalação: a da
 * mesma chave (cobre as linhas antigas, sem ID) e a do mesmo ID (cobre a troca do nome do
 * computador). Roda como root dentro de ~dashmon/.ssh. O `|| true` cobre o grep que não
 * sobra nada (sai com 1 e pararia o `set -e`). A chave é base64 validado e o ID é hex, então
 * os dois entram nos padrões sem escape.
 */
function keepOthers(publicKey, id) {
  const blob = publicKey.split(' ')[1];
  return [
    'rm -f authorized_keys.novo',
    `{ grep -vF ' ${blob} ' authorized_keys | grep -vE ' ${NAME_PREFIX}@[a-z0-9-]+:${id}$' || true; } > authorized_keys.novo`,
  ];
}

// Apaga a regra antiga só quando nenhuma linha antiga sobrou: até lá, outro computador ainda
// pode depender dela para o SMART.
const DROP_LEGACY_SUDOERS = `grep -qs ' ${KEY_COMMENT}$' ~${PANEL_USER}/.ssh/authorized_keys || rm -f ${SUDOERS} ${SUDOERS}.novo`;

/**
 * Plano de preparação a partir das escolhas do passo 4.
 * @param {object} p
 * @param {string} p.adminUser usuário administrador (passo 2)
 * @param {string} p.publicKey chave pública do painel ("ssh-ed25519 AAAA…")
 * @param {string} p.computer nome deste computador (vira o rótulo legível no servidor)
 * @param {object} p.targets alvos da coleta (mounts, devs para I/O, services, netIf)
 * @param {string[]} p.smartDevs discos com teste SMART liberado no sudoers
 * @param {string} [p.from] IP deste computador para a opção from= (vazio = qualquer origem)
 * @param {string} [p.smartctl] caminho do smartctl no servidor
 */
export function preparationPlan({ adminUser, publicKey, computer, targets, smartDevs = [], from = '', smartctl = '/usr/sbin/smartctl' }) {
  const { id, label, comment } = installNames({ publicKey, computer });
  const { line: keyLine, hash } = authorizedKeysLine({ publicKey, targets: { ...targets, smartDevs }, from, comment });
  const rule = sudoersLine({ devs: smartDevs, smartctl });
  const sudoers = sudoersFile(label, id);
  const u = PANEL_USER;
  // Arquivos do sudoers desta instalação com outro rótulo (o computador mudou de nome) e
  // sobras do .novo. O find roda como root: um curinga do shell não funcionaria no modo
  // manual, porque quem expande é a pessoa, que não lê /etc/sudoers.d.
  const dropOwnSudoers = (keep) => `find /etc/sudoers.d -maxdepth 1 -name '${NAME_PREFIX}-*-${id}*'${keep ? ` ! -name '${NAME_PREFIX}-${label}-${id}'` : ''} -delete`;

  // Cada passo: título e detalhe em linguagem simples + as linhas (como root).
  const steps = [
    {
      id: 'usuario',
      titulo: `Criar o usuário ${u}`,
      detalhe: 'sem senha e sem poderes de administrador',
      comentario: 'usuário próprio do painel, sem senha e sem poderes',
      linhas: [
        `id ${u} >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh ${u}`,
        `passwd --lock ${u} >/dev/null`,
      ],
    },
    {
      id: 'chave',
      titulo: 'Liberar a chave do painel',
      detalhe: from ? 'só para o comando de coleta e só a partir deste computador' : 'só para o comando de coleta',
      comentario: from ? 'chave restrita ao comando de coleta e a este computador; as linhas dos outros computadores ficam' : 'chave restrita ao comando de coleta; as linhas dos outros computadores ficam',
      // Um `sh -s` como root troca só a linha desta instalação. As redireções precisam de
      // root, e no modo manual o `sudo` na frente de cada linha não as cobriria.
      linhas: [
        `install -d -m 700 -o ${u} -g ${u} ~${u}/.ssh`,
        `sh -s <<'${STEP_EOF}'`,
        'set -e',
        'umask 077',
        `cd ~${u}/.ssh`,
        'touch authorized_keys',
        ...keepOthers(publicKey, id),
        `cat >> authorized_keys.novo <<'${KEY_EOF}'`,
        keyLine,
        KEY_EOF,
        `chown ${u}:${u} authorized_keys.novo`,
        'mv -f authorized_keys.novo authorized_keys',
        STEP_EOF,
      ],
    },
    rule
      ? {
        id: 'sudoers',
        titulo: 'Permitir o teste de saúde dos discos',
        detalhe: `apenas smartctl -H em ${DEVS_TEXT(smartDevs)}, conferido antes de ativar`,
        comentario: 'smartctl -H só nos discos escolhidos, validado antes de ativar, num arquivo só deste computador',
        linhas: [
          dropOwnSudoers(true),
          `install -m 440 /dev/stdin ${sudoers}.novo <<'${SUDOERS_EOF}'`,
          rule,
          SUDOERS_EOF,
          `visudo -cf ${sudoers}.novo && mv ${sudoers}.novo ${sudoers}`,
          DROP_LEGACY_SUDOERS,
        ],
      }
      : {
        id: 'sudoers',
        titulo: 'Sem teste de saúde dos discos',
        detalhe: 'nenhum disco com SMART marcado: a regra de sudo deste computador é removida, se existir',
        comentario: 'sem SMART: nenhuma regra de sudo para este computador',
        linhas: [dropOwnSudoers(false), DROP_LEGACY_SUDOERS],
      },
  ];

  /** Texto dos passos; `prefix` = "sudo " no modo manual de quem não é root. */
  const render = (step, prefix = '') => {
    const out = [];
    // Dentro de um heredoc nada ganha `sudo`; ele só fecha no SEU marcador (o passo da chave
    // tem um heredoc dentro do outro).
    let doc = '';
    for (const l of step.linhas) {
      if (doc) { out.push(l); if (l === doc) doc = ''; continue; }
      // `id … || useradd …`: o sudo vai nos dois lados do ||, e o `&&` do visudo também.
      out.push(prefix ? l.replace(/(^|\|\| |&& )(?=[a-z])/g, `$1${prefix}`) : l);
      const m = /<<'([A-Z_]+)'/.exec(l);
      if (m) doc = m[1];
    }
    return out.join('\n');
  };

  // Script que roda como root no modo assistido: marca cada passo concluído (@@ok <id>)
  // para a tela mostrar o progresso e onde parou se algo falhar.
  const rootScript = [
    'set -e',
    'umask 077',
    ...steps.flatMap((st) => [`# ${st.comentario}`, render(st), `echo '@@ok ${st.id}'`]),
    '',
  ].join('\n');

  // O que a tela mostra: as ações em ordem (modo assistido) e os blocos para colar (manual).
  const isRoot = adminUser === 'root';
  const actions = [
    { id: 'sudo', titulo: isRoot ? 'Entrar como administrador' : 'Confirmar que você pode usar sudo', detalhe: isRoot ? `você entra como root: nada de sudo` : `pede a senha de ${adminUser} uma vez` },
    ...steps.map(({ id, titulo, detalhe }) => ({ id, titulo, detalhe })),
    { id: 'teste', titulo: 'Testar uma coleta de verdade', detalhe: `com o usuário ${u}, do jeito que vai funcionar todo minuto` },
  ];

  const header = isRoot
    ? '# executado como root, numa única conexão'
    : `# executado como root numa única chamada de sudo (pede a senha de ${adminUser} uma vez)`;

  const manualBlocks = [
    ...steps.map((st) => ({ id: st.id, titulo: st.titulo, detalhe: st.detalhe, codigo: render(st, isRoot ? '' : 'sudo ') })),
    { id: 'pronto', titulo: 'Pronto no servidor', detalhe: 'nada para colar: clique em Testar e fazemos uma coleta real', codigo: `# nenhum comando: o Testar usa o usuário ${u} como o painel vai usar` },
  ];

  return {
    actions,
    rootScript,
    displayed: `${header}\n${steps.map((st) => `# ${st.comentario}\n${render(st)}`).join('\n')}`,
    manualBlocks,
    keyLine,
    sudoersLine: rule,
    sudoersFile: rule ? sudoers : '',
    installId: id,
    hash,
  };
}

/**
 * Script para `/bin/sh -s` no servidor que executa o rootScript como root.
 * @param {'root'|'nopasswd'|'senha'} sudo como o administrador vira root (detecção)
 */
export function assistedScript(rootScript, { sudo, password = '' }) {
  // O marcador do heredoc não pode aparecer dentro do script (fecharia o heredoc antes).
  if (rootScript.includes(`\n${SCRIPT_EOF}\n`)) throw new Error('script de preparo inválido');
  const doc = `cat <<'${SCRIPT_EOF}'\n${rootScript}${SCRIPT_EOF}`;
  if (sudo === 'root') return `/bin/sh -s <<'${SCRIPT_EOF}'\n${rootScript}${SCRIPT_EOF}\n`;
  if (sudo === 'nopasswd') return `${doc} | sudo -n /bin/sh -s\n`;
  if (sudo !== 'senha' || !password) throw new Error('o sudo deste usuário precisa da senha');
  if (/[\r\n\0]/.test(password)) throw new Error('senha com quebra de linha não é suportada');
  // Antes, confere a senha sozinha: com a senha errada, o sudo leria as linhas seguintes do
  // stdin como novas tentativas. Depois, sudo -S -k sempre lê a senha (1ª linha) e passa
  // o resto para o sh como script.
  return [
    `P=${shQuote(password)}`,
    "printf '%s\\n' \"$P\" | sudo -S -k -p '' true 2>/dev/null || { P=; echo '@@erro senha'; exit 9; }",
    `{ printf '%s\\n' "$P"; P=; ${doc}`,
    "} | sudo -S -k -p '' /bin/sh -s",
    '',
  ].join('\n');
}

/** Passos concluídos segundo os marcadores @@ok do script. */
export function completedSteps(stdout) {
  return [...String(stdout).matchAll(/^@@ok ([a-z]+)$/gm)].map((m) => m[1]);
}

/**
 * Desfaz o preparo DESTA instalação no servidor (dashboard desinstalar): a linha dela no
 * authorized_keys e o arquivo dela no sudoers. O usuário dashmon só sai quando não sobra
 * nenhuma linha (outros computadores podem usar o mesmo servidor). `@@restam N` diz quantas
 * linhas ficaram.
 */
export function removalScript({ publicKey }) {
  if (!validPublicKey(publicKey)) throw new Error('chave pública inválida');
  const id = installId(publicKey);
  const u = PANEL_USER;
  return [
    'set -e',
    'umask 077',
    `if id ${u} >/dev/null 2>&1 && [ -f ~${u}/.ssh/authorized_keys ]; then`,
    `  cd ~${u}/.ssh`,
    ...keepOthers(publicKey, id).map((l) => `  ${l}`),
    `  chown ${u}:${u} authorized_keys.novo`,
    '  mv -f authorized_keys.novo authorized_keys',
    'fi',
    'R=0',
    `if id ${u} >/dev/null 2>&1; then`,
    // grep -c imprime 0 (e sai com 1) sem linhas; sem o arquivo, não imprime nada.
    `  R=$(grep -c . ~${u}/.ssh/authorized_keys 2>/dev/null || true)`,
    '  [ -n "$R" ] || R=0',
    `  if [ "$R" = 0 ]; then userdel -r ${u} 2>/dev/null || userdel ${u}; fi`,
    'fi',
    `find /etc/sudoers.d -maxdepth 1 -name '${NAME_PREFIX}-*-${id}*' -delete`,
    DROP_LEGACY_SUDOERS,
    'echo "@@restam $R"',
    "echo '@@ok removido'",
    '',
  ].join('\n');
}

/** Quantas linhas do painel ficaram no servidor depois do removalScript (null se não disse). */
export function remainingLines(stdout) {
  const m = /^@@restam (\d+)$/m.exec(String(stdout));
  return m ? Number(m[1]) : null;
}
