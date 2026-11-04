// Cadeia de suprimentos e integridade (OWASP Top 10:2025 A03 Software Supply Chain
// Failures e A08 Software or Data Integrity Failures; CWE-494, CWE-829, CWE-353).
//
// O que chega à máquina de quem usa o painel e ao servidor tem origem conferida:
//   - nenhuma dependência de runtime (só o que está no repositório)
//   - o Node baixado pelo ./dashboard tem a soma SHA-256 fixada e conferida ANTES de extrair
//   - a chave que assina as versões (docs/allowed_signers) não muda sem querer
//   - o script de coleta, que vai para o authorized_keys do servidor, é byte a byte o mesmo
//     da v2.0.0 (hash dourado): mudar o texto quebraria toda instalação restrita
//   - as ferramentas de segurança e as actions do CI ficam presas por digest/SHA
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../test-support/rotas.js';
import { buildScript, buildForcedScript, targetsHash } from '../../server/collector/builder.js';

const ler = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('A03: zero dependências de runtime; a única de desenvolvimento tem versão exata', () => {
  const pkg = JSON.parse(ler('package.json'));
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'dependência de runtime');
  for (const [nome, versao] of Object.entries(pkg.devDependencies ?? {})) {
    assert.match(versao, /^\d+\.\d+\.\d+$/, `${nome}@${versao}: sem ^ ou ~ (versão travada)`);
  }
});

test('A03: o package-lock só baixa do registro oficial por HTTPS, com integridade sha512', () => {
  const lock = JSON.parse(ler('package-lock.json'));
  assert.ok(lock.lockfileVersion >= 3);
  for (const [nome, p] of Object.entries(lock.packages)) {
    if (!nome) continue; // o próprio projeto
    assert.match(p.resolved, /^https:\/\/registry\.npmjs\.org\//, `${nome}: origem ${p.resolved}`);
    assert.match(p.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, `${nome}: integridade`);
    assert.ok(p.dev, `${nome}: só de desenvolvimento`);
  }
});

test('A08/CWE-494: o Node baixado é conferido pela soma SHA-256 fixada antes de ser extraído', () => {
  const sh = ler('scripts/node-runtime.sh');
  assert.match(sh, /^NODE_SHA256_x64="[0-9a-f]{64}"$/m);
  assert.match(sh, /^NODE_SHA256_arm64="[0-9a-f]{64}"$/m);
  assert.match(sh, /^NODE_DIST="\$\{DASHBOARD_NODE_DIST:-https:\/\/nodejs\.org\/dist\}"$/m, 'origem oficial por HTTPS');
  // A conferência vem antes do tar, e a falha apaga o arquivo sem extrair nada.
  const conferencia = sh.indexOf('if [ "$got" != "$expected" ]; then');
  const extracao = sh.indexOf('tar -xzf');
  assert.ok(conferencia > 0 && extracao > conferencia, 'soma conferida antes de extrair');
  assert.match(sh.slice(conferencia, extracao), /rm -rf "\$tmp"[\s\S]*return 1/);
});

test('A08: a chave que assina as versões é a do mantenedor (docs/allowed_signers)', () => {
  const linhas = ler('docs/allowed_signers').split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(linhas, [
    'tsouza-thiago namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGMypWrHHf5RVZy/Fb4jgvqvH2MfgGqZsGVMdYMQLJP7',
    'tsouza-thiago namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDnYsXcStBkPcaNMFPpswKiIautYac3UeWKKOqfTcpKA',
  ], 'trocar a chave exige um commit consciente (ADR 0012) e a atualização deste teste');
});

test('A08: o script de coleta é byte a byte o da v2.0.0 (o authorized_keys do servidor continua valendo)', () => {
  // Calculado na v2.0.0. Comentário, refatoração ou limpeza no builder.js não pode mudar
  // o texto gerado: o servidor compararia com o script gravado no authorized_keys e a
  // coleta passaria a falhar (hashMismatch) em toda instalação restrita.
  const exemplo = { netIf: 'enpXsY', mounts: ['/', '/mnt/disco1'], devs: ['sda', 'sdb'], services: ['smbd', 'nmbd'] };
  const minimo = {};
  const dourado = {
    exemplo: ['6443f6bd222e', 'f5ea0f8ec3d35136937e1d22110a256b55ebfa316b19705faf65794bf8cd736d', '625d956e6701298a8f4b0ff2d43df5576ecf95653f3c797cf24819afa4cf84e1'],
    minimo: ['009470c76f64', '50d28be07ca148b560701733b7b8f3893e39107f310a1673ac8cf69c92320eb0', '3ad1e055cb38c221389c1e05603ba9864ed009952d2082b8ff895910fe78101c'],
  };
  for (const [nome, alvos] of Object.entries({ exemplo, minimo })) {
    const [alvosHash, basico, smart] = dourado[nome];
    assert.equal(targetsHash(alvos), alvosHash, `${nome}: hash dos alvos`);
    assert.equal(sha256(buildScript(alvos, 'basico').script), basico, `${nome}: script básico`);
    assert.equal(sha256(buildScript(alvos, 'smart').script), smart, `${nome}: script smart`);
    assert.equal(sha256(buildForcedScript(alvos).script), basico, `${nome}: script do authorized_keys`);
  }
});

test('A03: as ferramentas de segurança rodam em imagens presas por digest sha256', () => {
  const src = ler('scripts/seguranca.mjs');
  const imagens = [...src.matchAll(/^\s+\w+: '([^']+)',$/gm)].map((m) => m[1]).filter((i) => i.includes('/'));
  assert.ok(imagens.length >= 5, `imagens: ${imagens.length}`);
  for (const img of imagens) assert.match(img, /@sha256:[0-9a-f]{64}$/, `${img} sem digest`);
  assert.doesNotMatch(src, /:latest\b/);
});

// As imagens base do e2e de instalação também: uma tag (debian:12) pode passar a apontar para
// outra imagem; o digest não muda (Scorecard Pinned-Dependencies, alertas #14 e #15).
test('A03: as imagens base do e2e de instalação são presas por digest sha256', () => {
  const digest = /^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/;
  const imagens = [];
  for (const f of ['scripts/e2e-instalacao/servidor.Dockerfile', 'scripts/e2e-instalacao/cliente.Dockerfile']) {
    const src = ler(f);
    for (const m of src.matchAll(/^ARG BASE=(\S+)$/gm)) imagens.push([f, m[1]]);
    // FROM só com a variável do ARG acima ou com digest.
    for (const m of src.matchAll(/^FROM (\S+)/gm)) if (m[1] !== '${BASE}') imagens.push([f, m[1]]);
  }
  const lista = ler('scripts/e2e-instalacao/rodar.sh').match(/^for base in ([^;]+); do$/m);
  assert.ok(lista, 'rodar.sh sem a lista "for base in …; do"');
  for (const img of lista[1].trim().split(/\s+/)) imagens.push(['scripts/e2e-instalacao/rodar.sh', img]);
  assert.ok(imagens.length >= 4, `imagens: ${imagens.length}`);
  for (const [f, img] of imagens) assert.match(img, digest, `${f}: ${img} sem digest`);
});

// #98: o Node baixado em .runtime/ não vai para o repositório, mas a exceção não pode crescer
// nem valer para o histórico: um segredo versionado ali ainda tem de ser acusado.
test('gitleaks: só .runtime/ fica de fora, e só na varredura de arquivos', () => {
  const src = ler('scripts/seguranca.mjs');
  assert.match(src, /const foraDoRepositorio = \(arquivo\) => arquivo\.startsWith\('\.runtime\/'\);/);
  assert.match(src, /if \(!extra\.length && foraDoRepositorio\(arquivo\)\) continue;/);
  assert.equal(src.match(/foraDoRepositorio\(/g).length, 1, 'usado só no filtro do Gitleaks');
});

test('exceções de segurança: cada achado aceito tem motivo e um teste que o confere', () => {
  const { excecoes } = JSON.parse(ler('docs/seguranca/excecoes.json'));
  assert.ok(Array.isArray(excecoes));
  for (const e of excecoes) {
    const id = `${e.ferramenta}/${e.regra}`;
    assert.ok(['semgrep', 'gitleaks', 'shellcheck', 'osv', 'zap'].includes(e.ferramenta), `${id}: ferramenta`);
    assert.ok(typeof e.regra === 'string' && e.regra.length > 0, `${id}: regra`);
    assert.ok(typeof e.motivo === 'string' && e.motivo.length >= 40, `${id}: motivo analisado (40+ caracteres)`);
    assert.ok(fs.existsSync(path.join(ROOT, e.verificadoPor || '')), `${id}: verificadoPor aponta um teste que existe`);
  }
});

test('A03: toda action do CI presa por SHA de commit, permissões mínimas e sem credencial persistida', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const arquivos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
  for (const f of arquivos) {
    // Sem os comentários do YAML: o texto que explica "nunca pull_request_target" não conta.
    const y = fs.readFileSync(path.join(dir, f), 'utf8').replace(/(^|\s)#.*$/gm, '$1');
    for (const [, uso] of y.matchAll(/uses:\s*([^\s#]+)/g)) {
      assert.match(uso, /@[0-9a-f]{40}$/, `${f}: ${uso} sem SHA (tag pode ser movida)`);
    }
    assert.match(y, /^permissions:\s*\n\s+contents:\s*read\s*$/m, `${f}: permissões mínimas`);
    assert.doesNotMatch(y, /pull_request_target|secrets\.|\$\{\{\s*github\.event\.(?:issue|pull_request|comment)/, `${f}: gatilho ou dado perigoso`);
    if (/actions\/checkout@/.test(y)) assert.match(y, /persist-credentials:\s*false/, `${f}: checkout sem persistir o token`);
  }
});

test('A03: Dependabot, Dependency Review e Scorecard seguem a ADR 0016', () => {
  const ler = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/(^|\s)#.*$/gm, '$1');
  // Dependabot: os dois ecossistemas, com espera por versão nova (versão recém-publicada
  // é o vetor dos ataques de cadeia de suprimentos).
  const dep = ler('.github/dependabot.yml');
  for (const eco of ['github-actions', 'npm']) assert.match(dep, new RegExp(`package-ecosystem: ${eco}\\b`), `Dependabot sem ${eco}`);
  const esperas = [...dep.matchAll(/default-days:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(esperas.length, 2, 'cooldown nos dois ecossistemas');
  for (const d of esperas) assert.ok(d >= 14, `cooldown de ${d} dias: no mínimo 14`);
  // Dependency Review: só em PR e reprovando a partir de "moderada".
  const rev = ler('.github/workflows/dependencias.yml');
  assert.match(rev, /^on:\s*\n\s+pull_request:\s*$/m, 'Dependency Review roda em todo PR');
  assert.match(rev, /actions\/dependency-review-action@[0-9a-f]{40}/);
  assert.match(rev, /fail-on-severity:\s*moderate/);
  // Scorecard: as regras de publicação (sem env/defaults, id-token só no job dele) e o
  // resultado no code scanning.
  const sc = ler('.github/workflows/scorecard.yml');
  assert.doesNotMatch(sc, /^\s*(?:env|defaults):/m, 'Scorecard: sem env nem defaults');
  assert.equal([...sc.matchAll(/id-token:\s*write/g)].length, 1, 'id-token só no job do Scorecard');
  assert.match(sc, /ossf\/scorecard-action@[0-9a-f]{40}/);
  assert.match(sc, /publish_results:\s*true/);
  assert.match(sc, /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/);
  assert.match(sc, /runs-on:\s*ubuntu-/, 'runner Ubuntu hospedado');
});

test('CI (ADR 0040): os 3 comandos rodam no verificação, cada etapa com limite de tempo, e o check obrigatório junta os jobs', () => {
  const y = ler('.github/workflows/seguranca.yml').replace(/(^|\s)#.*$/gm, '$1');
  // As camadas da ADR 0014 continuam todas no CI, com o e2e obrigatório. O `npm run seguranca`
  // roda em 2 jobs que, juntos, cobrem todas as etapas: um pula só a mutação, o outro só a roda.
  for (const cmd of ['npm run check', 'npm run test:e2e', 'npm run seguranca -- --pular=mutacao', 'npm run seguranca -- --so=mutacao']) {
    assert.ok(y.split('\n').some((l) => l.trim() === `run: ${cmd}`), `${cmd} saiu do CI`);
  }
  assert.match(y, /E2E_OBRIGATORIO:\s*'1'/, 'e2e sem navegador tem de falhar, não pular');
  assert.match(y, /fetch-depth:\s*0/, 'o Gitleaks precisa de todo o histórico');
  // Toda etapa `run:` tem timeout-minutes: a que trava reprova cedo, com o nome dela (#128).
  const etapas = y.split(/\n\s+- name:/).slice(1);
  for (const e of etapas.filter((t) => /\n\s+run:/.test(t))) {
    assert.match(e, /\n\s+timeout-minutes:\s*\d+/, `etapa sem limite de tempo:${e.split('\n')[0]}`);
  }
  // O job `verificacao` é o check obrigatório do ruleset: precisa esperar os 4, rodar sempre e
  // só passar com os 4 em success (job pulado ou cancelado não pode virar verde).
  const jobs = ['check', 'e2e', 'seguranca', 'mutacao'];
  const agregador = y.slice(y.indexOf('\n  verificacao:'));
  assert.match(agregador, new RegExp(`needs:\\s*\\[${jobs.join(', ')}\\]`));
  assert.match(agregador, /if:\s*always\(\)/);
  for (const job of jobs) assert.match(agregador, new RegExp(`needs\\.${job}\\.result`));
  assert.equal((agregador.match(/= success/g) || []).length, jobs.length, 'todos os resultados conferidos');
});

test('npm run seguranca (#128): cada etapa e cada rodada da mutação têm limite de tempo', () => {
  const seg = ler('scripts/seguranca.mjs');
  const etapas = [...seg.matchAll(/\{ nome: '([a-z]+)', titulo:[^\n]*\n?/g)].map((m) => m[0]);
  assert.equal(etapas.length, 6, 'as 6 etapas');
  for (const e of etapas) assert.match(e, /limite: \d+,/, `etapa sem limite: ${e.slice(0, 40)}`);
  const mut = ler('scripts/mutacao-seguranca.mjs');
  assert.match(mut, /const LIMITE_S = /, 'limite por rodada');
  assert.match(mut, /process\.kill\(-p\.pid, 'SIGKILL'\)/, 'o limite derruba o grupo de processos da rodada');
  assert.match(mut, /passou do limite/, 'a rodada presa reprova com mensagem própria');
});
