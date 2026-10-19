// O que um atacante colheria do repositório público (OSINT) e segredos esquecidos.
//
// O repositório é público: tudo que o git rastreia pode ser lido por qualquer pessoa e por
// robôs que varrem o GitHub atrás de chaves e de detalhes da rede de alguém. Este teste
// varre TODOS os arquivos rastreados (git ls-files) e falha com:
//   - chave privada, token de serviço conhecido ou senha atribuída em texto (CWE-798)
//   - IP privado da rede local, MAC ou caminho da pasta pessoal de quem desenvolve (CWE-200)
//   - e-mail que não seja de exemplo ou noreply
//   - fixture do servidor real com processos, argumentos ou versão do kernel reais (CWE-497)
//   - arquivo que nunca deve ir para o git (.env, data/, chaves, relatórios de segurança)
// O histórico inteiro é varrido pelo Gitleaks em `npm run seguranca`.
// Referências: OWASP Top 10:2025 A04 (falhas criptográficas: segredo exposto) e A02.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../test-support/rotas.js';
import { arquivosRastreados } from '../../test-support/fonte.js';
import { anonymize, anonymizeKernel, KEEP_PROGRAMS } from '../../scripts/capturar-amostra.mjs';

const ARQUIVOS = arquivosRastreados();
// Binários (fontes) ficam de fora: só texto é varrido.
const TEXTO = ARQUIVOS.filter((f) => !/\.(woff2|png|ico)$/.test(f));
const ler = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Testes que usam IP privado e MAC DE PROPÓSITO: conferem que a anonimização das amostras
// (scripts/capturar-amostra.mjs) os troca por valores de documentação.
const ANONIMIZACAO = new Set(['test/unit/capturar-amostra.test.js', 'test/integration/capturar-amostra-cli.test.js']);

/** Linhas de `arquivos` que casam com `re`, como `arquivo:linha  trecho`. */
function achados(arquivos, re, filtro = () => true) {
  const out = [];
  for (const f of arquivos) {
    const linhas = ler(f).split('\n');
    linhas.forEach((l, i) => {
      for (const m of l.matchAll(re)) if (filtro(m[0], f)) out.push(`${f}:${i + 1}  ${m[0].slice(0, 60)}`);
    });
  }
  return out;
}

test('OSINT: a varredura alcança todo o repositório', () => {
  assert.ok(TEXTO.length > 150, `só ${TEXTO.length} arquivos de texto`);
  assert.ok(TEXTO.includes('AGENTS.md') && TEXTO.includes('server/index.js') && TEXTO.includes('package-lock.json'));
});

test('CWE-798: nenhuma chave privada nem token de serviço nos arquivos', () => {
  const padroes = [
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g, // RSA, EC, OPENSSH, PKCS8
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g, // AWS
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
    /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic
    /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
    /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  ];
  for (const re of padroes) assert.deepEqual(achados(TEXTO, re), [], String(re));
});

test('CWE-798: nenhuma senha ou DASH_TOKEN com valor real atribuído', () => {
  // Só VALOR literal conta: string entre aspas no código, ou `CHAVE=valor` em .env, shell e
  // Markdown. Atribuir uma variável (`password: this.#senha`) não expõe nada. Valores de
  // teste se denunciam pelo nome (teste, exemplo, segredo123…).
  const literal = /\b(?:DASH_TOKEN|password|senha|secret|segredo)\s*[:=]\s*(['"`])([^'"`\s]{6,})\1/gi;
  const linhaEnv = /^\s*(?:export\s+)?(?:DASH_TOKEN|PASSWORD|SENHA|SECRET)=(\S{6,})/gim;
  const deTeste = (m) => /teste|test|errad|incorret|invalid|exemplo|example|segredo|fake|falso|abc|123|\$\{|<|\.\.\./i.test(m);
  assert.deepEqual(achados(TEXTO, literal, (m) => !deTeste(m)), []);
  assert.deepEqual(achados(TEXTO, linhaEnv, (m) => !deTeste(m)), []);
});

test('CWE-200: nenhum IP da rede local, além dos de documentação (RFC 5737) e loopback', () => {
  const re = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
  const ok = /^(?:127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
  // Endereços inválidos ou públicos de exemplo usados em testes de validação (não são da
  // rede de ninguém): 256.1.1.1 (inválido), 1.1.1.1, 2.2.2.2, 1.2.3.4.
  const validacao = /^(?:256\.1\.1\.1|1\.1\.1\.1|2\.2\.2\.2|1\.2\.3\.4)$/;
  const privados = achados(TEXTO, re, (m, f) => !ok.test(m) && !ANONIMIZACAO.has(f) && !(f.startsWith('test/') && validacao.test(m)));
  assert.deepEqual(privados, []);
});

test('CWE-200: nenhum endereço MAC, além dos testes da anonimização', () => {
  const re = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi;
  assert.deepEqual(achados(TEXTO, re, (m, f) => !ANONIMIZACAO.has(f)), []);
});

test('CWE-200: e-mail só de exemplo ou noreply (nunca um endereço pessoal)', () => {
  // O domínio termina em letras (`usuario@192.0.2.10` é destino de SSH, não e-mail).
  const re = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
  const permitido = (dominio) => /(?:^|\.)(?:example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com)$/.test(dominio)
    || /\.(?:service|socket|target|timer)$/.test(dominio); // unidades do systemd (getty@tty1.service)
  const ruins = achados(TEXTO, re, (m) => !permitido(m.split('@')[1]));
  assert.deepEqual(ruins, []);
});

// As fixtures que vieram do servidor real (test/fixtures/README.md). Processos e versão do
// kernel dizem o que a máquina roda e até quando foi atualizada: reconhecimento para um
// ataque direcionado (OWASP WSTG-INFO). Por isso elas passam pela anonimização completa.
const FIXTURES_REAIS = ['test/fixtures/coleta-v2/debian13-real.txt', 'test/fixtures/coleta-v2/debian13-derivada-v1.txt'];
const programaGenerico = (cmd) => {
  const nome = cmd.split(/\s+/)[0].split('/').pop();
  return KEEP_PROGRAMS.has(nome) || /^processo\d+$/.test(nome);
};

test('CWE-497: fixture do servidor real já passou pela anonimização completa', () => {
  for (const f of FIXTURES_REAIS) {
    const texto = ler(f);
    assert.equal(anonymize(texto).text, texto, `${f}: o npm run capturar-amostra ainda mudaria este arquivo`);
  }
});

test('CWE-497: a amostra do AGENTS não traz processo nem versão do kernel reais', () => {
  const agents = ler('AGENTS.md');
  const inicio = agents.indexOf('```json\n', agents.indexOf('## Formato da amostra')) + '```json\n'.length;
  const amostra = JSON.parse(agents.slice(inicio, agents.indexOf('\n```', inicio)));
  assert.equal(amostra.os.kernel, anonymizeKernel(amostra.os.kernel), 'kernel só com major.minor');
  for (const p of amostra.topProcs) {
    assert.ok(programaGenerico(p.cmd) && !/\s/.test(p.cmd), `processo fora da lista genérica ou com argumentos: ${p.cmd}`);
  }
});

test('CWE-200: nenhum caminho da pasta pessoal de quem desenvolve', () => {
  const usuario = os.userInfo().username;
  // Nomes genéricos dos contêineres e testes (ana, maria, dashmon…) podem aparecer.
  const genericos = new Set(['ana', 'maria', 'dashmon', 'm', 'segredo', 'usuario', 'user', 'runner', 'zap', 'pessoa']);
  const re = /(?:\/home\/|\/Users\/|C:\\Users\\)([A-Za-z0-9_.-]+)/g;
  const ruins = achados(TEXTO, re, (m) => {
    const nome = m.split(/[\\/]/).filter(Boolean).pop();
    return !genericos.has(nome) || nome === usuario;
  });
  assert.deepEqual(ruins, []);
});

test('git: nada de .env, data/, chave privada, Node baixado ou relatório de segurança no repositório', () => {
  const proibidos = ARQUIVOS.filter((f) => /^(?:\.env(?!\.example$)|data\/|\.runtime\/|\.backups\/|\.seguranca\/|\.claude\/|node_modules\/)/.test(f)
    || /(?:^|\/)(?:id_(?:rsa|ed25519|ecdsa)(?!\.pub)|[^/]+\.(?:pem|key|p12|pfx|kdbx))$/.test(f));
  assert.deepEqual(proibidos, []);
  // E o .gitignore continua protegendo o que importa.
  const ignore = ler('.gitignore');
  for (const p of ['.env', 'data/', '.runtime/', '.backups/', '.seguranca/', '*.pem', '*.key']) {
    assert.ok(ignore.split('\n').includes(p), `.gitignore sem ${p}`);
  }
});
