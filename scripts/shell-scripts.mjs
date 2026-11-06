// Lista única dos scripts shell do projeto. Quem usa: scripts/check.mjs (`bash -n`) e
// scripts/seguranca.mjs (ShellCheck). Script novo entra aqui e passa nas 2 checagens.
export const SHELL_SCRIPTS = ['dashboard', 'bin/dashboard', 'libexec/atualizador', 'scripts/node-runtime.sh', 'scripts/askpass.sh', 'scripts/completar.bash', 'scripts/e2e-instalacao/rodar.sh', 'scripts/e2e-instalacao/pacote.sh', 'pacote/debian/postinst', 'pacote/debian/prerm', 'pacote/debian/postrm'];
