// Tema lembrado no navegador (escuro é o padrão, ADR 0009). Quem usa: public/js/main.js e o
// assistente (public/js/configurar/main.js). Só a chave e a leitura/gravação ficam aqui; cada
// tela troca o ícone e o texto do próprio botão.
const THEME_KEY = 'dash_theme';

/** Tema lembrado: 'light' ou 'dark' (escuro se não houver ou se o armazenamento estiver bloqueado). */
export function lerTema() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

/** Lembra o tema escolhido (ignora armazenamento bloqueado). */
export function gravarTema(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* armazenamento bloqueado */ }
}
