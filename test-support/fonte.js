// Leitura do código-fonte para as verificações estáticas de segurança.
//
// As regras de test/seguranca/invariantes-estaticas.test.js procuram padrões perigosos
// (eval, innerHTML, exec…) no CÓDIGO. Um comentário que só cita o padrão ("nunca use
// innerHTML aqui") não pode reprovar. Por isso os comentários são apagados antes da busca,
// trocados por espaços: as quebras de linha ficam, e o número da linha de cada achado bate
// com o arquivo. Strings, templates e regex ficam intactos, porque um `//` dentro de
// 'http://…' ou de /\/\// não é comentário.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './rotas.js';

// Depois destas palavras, uma "/" começa uma regex (e não uma divisão).
const ANTES_DE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Devolve o texto JavaScript sem comentários (cada caractere de comentário vira espaço; as
 * quebras de linha são mantidas).
 */
export function semComentarios(src) {
  const out = src.split('');
  // Pilha de contextos: 'code' ou 'tpl' (dentro de um template `…`). Em 'code' aberto por
  // `${`, o número guarda quantas chaves foram abertas desde então.
  const pilha = [{ modo: 'code', chaves: 0 }];
  let ultimo = ''; // último caractere significativo (fora de espaço), para decidir regex × divisão
  let palavra = ''; // última palavra lida, pelo mesmo motivo
  const apagar = (de, ate) => { for (let k = de; k < ate; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < src.length) {
    const topo = pilha[pilha.length - 1];
    const c = src[i];
    if (topo.modo === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { pilha.pop(); ultimo = '`'; i++; continue; }
      if (c === '$' && src[i + 1] === '{') { pilha.push({ modo: 'code', chaves: 0 }); i += 2; ultimo = '{'; continue; }
      i++;
      continue;
    }
    // Comentário de linha e de bloco.
    if (c === '/' && src[i + 1] === '/') {
      const fim = src.indexOf('\n', i);
      const ate = fim === -1 ? src.length : fim;
      apagar(i, ate);
      i = ate;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const fim = src.indexOf('*/', i + 2);
      const ate = fim === -1 ? src.length : fim + 2;
      apagar(i, ate);
      i = ate;
      continue;
    }
    // Strings com aspas simples e duplas.
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
      ultimo = c;
      palavra = '';
      continue;
    }
    if (c === '`') { pilha.push({ modo: 'tpl' }); i++; continue; }
    // Regex literal: só quando uma "/" não pode ser divisão.
    if (c === '/' && (ultimo === '' || '(,=:[!&|?{};+-*%<>~^'.includes(ultimo) || ANTES_DE_REGEX.has(palavra))) {
      let j = i + 1;
      let classe = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') classe = true;
        else if (src[j] === ']') classe = false;
        else if (src[j] === '/' && !classe) break;
        j++;
      }
      j++;
      while (/[a-z]/i.test(src[j] || '')) j++; // flags
      i = j;
      ultimo = '/';
      palavra = '';
      continue;
    }
    if (c === '{') topo.chaves += 1;
    if (c === '}') {
      if (topo.chaves === 0 && pilha.length > 1) { pilha.pop(); i++; ultimo = '}'; continue; }
      topo.chaves -= 1;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      palavra = /[A-Za-z0-9_$]/.test(src[i - 1] || '') ? palavra + c : c;
      ultimo = c;
    } else if (!/\s/.test(c)) {
      ultimo = c;
      palavra = '';
    }
    i++;
  }
  return out.join('');
}

/**
 * O que vai para o repositório público: os arquivos rastreados pelo git e os novos ainda não
 * commitados que o .gitignore não exclui (um segredo num arquivo novo é pego ANTES do commit).
 */
export function arquivosRastreados(root = ROOT) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files falhou: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
}

/** Código JavaScript de produção: servidor, frontend e scripts (sem bibliotecas de terceiros). */
export function arquivosDeCodigo(root = ROOT) {
  return arquivosRastreados(root)
    .filter((f) => /^(server|public\/js|scripts)\/.*\.m?js$/.test(f));
}

/**
 * Procura `re` (com flag g) no código sem comentários de cada arquivo e devolve
 * `arquivo:linha  trecho` de cada ocorrência. O trecho é o texto casado (até 300
 * caracteres): as regras que conferem o resto da instrução usam `[^;]*` no fim da regex.
 */
export function procurar(arquivos, re, root = ROOT) {
  const achados = [];
  for (const f of arquivos) {
    const original = fs.readFileSync(path.join(root, f), 'utf8');
    const limpo = semComentarios(original);
    for (const m of limpo.matchAll(re)) {
      const linha = limpo.slice(0, m.index).split('\n').length;
      achados.push(`${f}:${linha}  ${m[0].trim().slice(0, 300)}`);
    }
  }
  return achados;
}
