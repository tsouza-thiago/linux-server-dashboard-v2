// Preparar o servidor (passo 5, D11): os mesmos comandos servem aos dois modos.
// - assistido: rodam como root numa única chamada de sudo (`sudo -S -k`, a senha vai uma
//   vez pelo stdin e nunca para a linha de comando), depois do "Confirmar";
// - manual: viram blocos para colar no servidor, com `sudo` na frente de cada linha.
// Tudo é idempotente (rodar de novo atualiza a chave e a regra) e reversível
// (removalScript, usado pelo `dashboard desinstalar`).
import { authorizedKeysLine, sudoersLine, PANEL_USER } from './acesso.js';
import { shQuote } from './deteccao.js';

const SUDOERS = '/etc/sudoers.d/dashboard';
const KEY_EOF = 'FIM_DA_CHAVE';
const SUDOERS_EOF = 'FIM_DA_REGRA';
const SCRIPT_EOF = 'FIM_DO_PREPARO';

const DEVS_TEXT = (devs) => (devs.length > 1 ? `${devs.slice(0, -1).join(', ')} e ${devs.at(-1)}` : devs[0]);

/**
 * Plano de preparação a partir das escolhas do passo 4.
 * @param {object} p
 * @param {string} p.adminUser usuário administrador (passo 2)
 * @param {string} p.publicKey chave pública do painel ("ssh-ed25519 AAAA…")
 * @param {object} p.targets alvos da coleta (mounts, devs para I/O, services, netIf)
 * @param {string[]} p.smartDevs discos com teste SMART liberado no sudoers
 * @param {string} [p.from] IP deste computador para a opção from= (vazio = qualquer origem)
 * @param {string} [p.smartctl] caminho do smartctl no servidor
 */
export function preparationPlan({ adminUser, publicKey, targets, smartDevs = [], from = '', smartctl = '/usr/sbin/smartctl' }) {
  const { line: keyLine, hash } = authorizedKeysLine({ publicKey, targets: { ...targets, smartDevs }, from });
  const rule = sudoersLine({ devs: smartDevs, smartctl });
  const u = PANEL_USER;

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
      comentario: from ? 'chave restrita ao comando de coleta e a este computador' : 'chave restrita ao comando de coleta',
      linhas: [
        `install -d -m 700 -o ${u} -g ${u} ~${u}/.ssh`,
        `install -m 600 -o ${u} -g ${u} /dev/stdin ~${u}/.ssh/authorized_keys <<'${KEY_EOF}'`,
        keyLine,
        KEY_EOF,
      ],
      heredoc: true,
    },
    rule
      ? {
        id: 'sudoers',
        titulo: 'Permitir o teste de saúde dos discos',
        detalhe: `apenas smartctl -H em ${DEVS_TEXT(smartDevs)}, conferido antes de ativar`,
        comentario: 'smartctl -H só nos discos escolhidos, validado antes de ativar',
        linhas: [
          `install -m 440 /dev/stdin ${SUDOERS}.novo <<'${SUDOERS_EOF}'`,
          rule,
          SUDOERS_EOF,
          `visudo -cf ${SUDOERS}.novo && mv ${SUDOERS}.novo ${SUDOERS}`,
        ],
        heredoc: true,
      }
      : {
        id: 'sudoers',
        titulo: 'Sem teste de saúde dos discos',
        detalhe: 'nenhum disco com SMART marcado: a regra de sudo do painel é removida, se existir',
        comentario: 'sem SMART: nenhuma regra de sudo para o painel',
        linhas: [`rm -f ${SUDOERS} ${SUDOERS}.novo`],
      },
  ];

  /** Texto dos passos; `prefix` = "sudo " no modo manual de quem não é root. */
  const render = (step, prefix = '') => {
    const out = [];
    let inDoc = false;
    for (const l of step.linhas) {
      if (inDoc) { out.push(l); if (l === KEY_EOF || l === SUDOERS_EOF) inDoc = false; continue; }
      // `id … || useradd …`: o sudo vai nos dois lados do ||, e o `&&` do visudo também.
      out.push(prefix ? l.replace(/(^|\|\| |&& )(?=[a-z])/g, `$1${prefix}`) : l);
      if (/<<'/.test(l)) inDoc = true;
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
    hash,
  };
}

/**
 * Script para `/bin/sh -s` no servidor que executa o rootScript como root.
 * @param {'root'|'nopasswd'|'senha'} sudo como o administrador vira root (detecção)
 */
export function assistedScript(rootScript, { sudo, password = '' }) {
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

/** Desfaz o preparo no servidor (dashboard desinstalar): usuário, chave e regra de sudo. */
export function removalScript() {
  return [
    'set -e',
    `if id ${PANEL_USER} >/dev/null 2>&1; then userdel -r ${PANEL_USER} 2>/dev/null || userdel ${PANEL_USER}; fi`,
    `rm -f ${SUDOERS} ${SUDOERS}.novo`,
    "echo '@@ok removido'",
    '',
  ].join('\n');
}
