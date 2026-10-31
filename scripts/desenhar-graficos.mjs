// Desenha os SVG da documentação (F11, #106): banner, diagrama da arquitetura e ícones dos
// títulos do README. Cada desenho sai nas 2 cores, para o <picture> seguir o tema do leitor.
// Nada aqui lê dados: são só formas fixas, com texto genérico. O capturar-telas.mjs chama
// este módulo; rodar sozinho (`node scripts/desenhar-graficos.mjs`) refaz só os SVG.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASTA_IMG = path.join(ROOT, 'docs', 'img');

// Cores do public/css/tokens.css, sem depender dele: o SVG abre fora do painel.
const TEMAS = {
  escuro: { fundo: '#0D1117', caixa: '#161B22', borda: '#30363D', texto: '#E6EDF3', suave: '#9DA7B3', destaque: '#3EE0D0' },
  claro: { fundo: '#FFFFFF', caixa: '#F6F8FA', borda: '#D0D7DE', texto: '#1F2328', suave: '#59636E', destaque: '#0F8F85' },
};
const FONTE = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";
const PULSO = '5 16 10 16 13 7 19 25 22 16 27 16';

// O banner fica escuro nos 2 temas: é a cara do painel, e o tema padrão dele é o escuro.
const banner = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 200" role="img" aria-label="Server Dashboard: painel em tempo real do seu servidor Linux">
  <defs>
    <linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07090E"/><stop offset="1" stop-color="#10262B"/></linearGradient>
    <linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3EE0D0" stop-opacity=".28"/><stop offset="1" stop-color="#3EE0D0" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="880" height="200" rx="14" fill="url(#f)"/>
  <path d="M0 180 60 176 120 179 180 170 240 174 300 165 360 171 420 162 480 167 540 150 600 161 660 144 720 154 780 136 840 143 880 132V200H0Z" fill="url(#a)"/>
  <path d="M0 180 60 176 120 179 180 170 240 174 300 165 360 171 420 162 480 167 540 150 600 161 660 144 720 154 780 136 840 143 880 132" fill="none" stroke="#3EE0D0" stroke-width="2" stroke-opacity=".55"/>
  <g transform="translate(44 44) scale(2.25)"><rect width="32" height="32" rx="8" fill="#07090E" stroke="#3EE0D0" stroke-opacity=".35"/><polyline points="${PULSO}" stroke="#3EE0D0" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
  <text x="134" y="84" font-family="${FONTE}" font-size="42" font-weight="700" fill="#F2F5F9">Server Dashboard</text>
  <text x="136" y="116" font-family="${FONTE}" font-size="19" fill="#B7C2CE">Painel em tempo real do seu servidor Linux. Nada é instalado no servidor.</text>
</svg>
`;

/** Diagrama da arquitetura: o caminho de 1 coleta, do servidor até o navegador. */
function arquitetura(t) {
  const caixa = (x, y, w, h, titulo, linhas, forte = false) => `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${t.caixa}" stroke="${forte ? t.destaque : t.borda}" stroke-width="${forte ? 2 : 1}"/>
  <text x="${x + w / 2}" y="${y + 30}" text-anchor="middle" font-size="16" font-weight="600" fill="${t.texto}">${titulo}</text>${linhas.map((l, i) => `
  <text x="${x + w / 2}" y="${y + 54 + i * 20}" text-anchor="middle" font-size="13" fill="${t.suave}">${l}</text>`).join('')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 262" role="img" aria-label="Diagrama: o painel roda no seu computador e faz 1 comando SSH de leitura por minuto no servidor Linux" font-family="${FONTE}">
  <defs><marker id="s" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10Z" fill="${t.destaque}"/></marker></defs>
  <rect x="1" y="1" width="598" height="260" rx="14" fill="none" stroke="${t.borda}" stroke-dasharray="6 5"/>
  <text x="24" y="30" font-size="14" font-weight="600" fill="${t.suave}">SEU COMPUTADOR (127.0.0.1)</text>${
  caixa(24, 48, 170, 190, 'Navegador', ['8 telas e gráficos', 'zoom e filtros', 'relatórios', 'tudo roda aqui'])}${
  caixa(226, 48, 164, 190, 'Painel', ['coleta 1 vez por min', 'calcula as taxas', 'avalia os alertas', 'serve as telas'], true)}${
  caixa(422, 48, 154, 190, 'Pasta data/', ['72 h detalhadas', '90 dias resumidos', 'alertas e quedas', 'só neste computador'])}${
  caixa(696, 48, 160, 190, 'Servidor Linux', ['nada instalado', 'só leitura', 'responde em ~1 s', 'usuário dashmon'])}
  <path d="M226 143H196" stroke="${t.destaque}" stroke-width="2" marker-end="url(#s)"/>
  <path d="M390 143H420" stroke="${t.destaque}" stroke-width="2" marker-end="url(#s)"/>
  <path d="M576 143H694" stroke="${t.destaque}" stroke-width="2.5" marker-start="url(#s)" marker-end="url(#s)"/>
  <text x="636" y="118" text-anchor="middle" font-size="13" font-weight="600" fill="${t.destaque}">1 SSH por min</text>
  <text x="636" y="168" text-anchor="middle" font-size="12" fill="${t.suave}">só leitura</text>
</svg>
`;
}

// Traços 24 × 24 no estilo do painel: 1 ícone por seção principal do README.
const ICONES = {
  garantias: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  telas: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
  requisitos: '<path d="M9 5h10M9 12h10M9 19h10"/><path d="M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/>',
  instalar: '<path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  comandos: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  v1: '<path d="M4 12h14M13 7l5 5-5 5"/><path d="M4 5v14"/>',
  problemas: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  perguntas: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 17h.01"/>',
  documentacao: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  licenca: '<circle cx="12" cy="9" r="5"/><path d="M9 13l-2 8 5-3 5 3-2-8"/>',
};
const icone = (traco, cor) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${cor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${traco}</svg>\n`;

/** Grava todos os SVG em docs/img/. */
export function desenharGraficos() {
  const gravar = (nome, svg) => {
    fs.mkdirSync(path.dirname(path.join(PASTA_IMG, nome)), { recursive: true });
    fs.writeFileSync(path.join(PASTA_IMG, nome), svg);
  };
  gravar('banner.svg', banner());
  for (const [tema, cores] of Object.entries(TEMAS)) {
    gravar(`arquitetura-${tema}.svg`, arquitetura(cores));
    for (const [nome, traco] of Object.entries(ICONES)) gravar(`icones/${nome}-${tema}.svg`, icone(traco, cores.destaque));
  }
}

const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) desenharGraficos();
