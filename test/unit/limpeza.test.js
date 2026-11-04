// Limpeza do fim dos testes (#148): `aoFim` fecha o que abriu por último primeiro e não pula passos
// quando um falha; a regra estática impede a volta do `t.after` que apagava a pasta antes de fechar
// o painel e prendia o processo do teste (rodada da mutação passando do limite).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aoFim } from '../../test-support/limpeza.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Um `t` falso: guarda os `after` registrados para o teste rodar quando quiser. */
function tFalso() {
  const afters = [];
  return { after: (fn) => afters.push(fn), rodar: async () => { for (const fn of afters) await fn(); }, afters };
}

test('aoFim (#148): roda do último para o 1º, num só t.after', async () => {
  const t = tFalso();
  const ordem = [];
  aoFim(t, () => ordem.push('apaga a pasta'));
  aoFim(t, async () => { await null; ordem.push('fecha o painel'); });
  assert.equal(t.afters.length, 1);
  await t.rodar();
  assert.deepEqual(ordem, ['fecha o painel', 'apaga a pasta']);
});

test('aoFim (#148): um passo que falha não deixa o servidor aberto, e o erro sobe', async () => {
  const t = tFalso();
  const server = http.createServer((req, res) => res.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  aoFim(t, () => { throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' }); });
  aoFim(t, () => { throw new Error('o 1º que roda também falha'); });
  aoFim(t, () => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(t.rodar(), /o 1º que roda também falha/);
  assert.equal(server.listening, false, 'o servidor fechou mesmo com os outros passos falhando');
});

test('aoFim (#148): cada teste tem a sua pilha', async () => {
  const a = tFalso();
  const b = tFalso();
  const feitos = [];
  aoFim(a, () => feitos.push('a'));
  aoFim(b, () => feitos.push('b'));
  await b.rodar();
  assert.deepEqual(feitos, ['b']);
});

/** Os arquivos de teste do repositório (test/**\/*.test.js), menos este, que cita os padrões. */
function arquivosDeTeste(dir = path.join(ROOT, 'test')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return arquivosDeTeste(p);
    return e.name.endsWith('.test.js') && p !== fileURLToPath(import.meta.url) ? [p] : [];
  });
}

// Quem sobe o painel nos testes usa o `listen` de test-support/request.js.
const SOBE_SERVIDOR = /import\s*\{[^}]*\blisten\b[^}]*\}\s*from\s*'[./]*test-support\/request\.js'/;

test('regra (#148): teste que sobe servidor não apaga pasta num t.after solto', () => {
  // `t.after(() => fs.rmSync(...))` registrado antes do hook que fecha o servidor roda 1º: apaga a
  // pasta com o painel ainda gravando (ENOTEMPTY), pula o `close(server)` e o processo não sai.
  // Ou a pasta sai no mesmo hook, depois do close (`await app.shutdown(); await close(server);
  // fs.rmSync(...)`), ou a limpeza toda passa pelo `aoFim`.
  const ruins = [];
  for (const f of arquivosDeTeste()) {
    const fonte = fs.readFileSync(f, 'utf8');
    if (!SOBE_SERVIDOR.test(fonte)) continue;
    if (/\bt\.after\(\s*\(\)\s*=>\s*fs\.rmSync\(/.test(fonte)) ruins.push(path.relative(ROOT, f));
  }
  assert.deepEqual(ruins, []);
});

test('regra (#148): quem usa aoFim não mistura com t.after solto', () => {
  // A pilha do `aoFim` é 1 `t.after` registrado na 1ª chamada: um `t.after` solto no mesmo arquivo
  // escapa da ordem do último para o 1º.
  const ruins = arquivosDeTeste()
    .filter((f) => { const fonte = fs.readFileSync(f, 'utf8'); return fonte.includes('aoFim(') && /\bt\.after\(/.test(fonte); })
    .map((f) => path.relative(ROOT, f));
  assert.deepEqual(ruins, []);
});

// O caso real, sem `t` falso: a pilha roda no `after` do node:test e o servidor fecha antes da pasta.
test('aoFim (#148): no node:test, o servidor fecha antes da pasta sair', async (t) => {
  const server = http.createServer((req, res) => res.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let fechado = false;
  aoFim(t, () => assert.equal(fechado, true, 'a pasta só sai depois do servidor'));
  aoFim(t, () => new Promise((resolve) => server.close(() => { fechado = true; resolve(); })));
});
