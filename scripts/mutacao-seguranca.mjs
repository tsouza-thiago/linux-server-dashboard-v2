#!/usr/bin/env node
// Teste de mutação dos guardas de segurança: "quem testa os testes?".
//
// Cada mutação abaixo é um erro de segurança realista: o que uma limpeza descuidada,
// uma refatoração ou um código novo poderia introduzir (tirar o Host check, escutar em
// 0.0.0.0, aceitar o token na URL…). Numa CÓPIA temporária do repositório, o script aplica
// uma mutação por vez, roda os testes indicados e exige que eles FALHEM. Mutação que
// sobrevive (testes verdes com o guarda quebrado) é um buraco na rede de testes: reprova.
//
// Se o trecho que a mutação procura não existe mais (o código mudou de forma), ela é
// "desatualizada" e também reprova: a lista precisa acompanhar o código, nunca ficar cega.
//
// As rodadas correm em paralelo, cada uma na sua cópia (#128), e cada rodada tem um limite de
// tempo: a que passa dele reprova com o nome da mutação, em vez de prender o CI (PR #127).
//
// Uso: node scripts/mutacao-seguranca.mjs   (também roda dentro de `npm run seguranca`)
//   MUTACAO_PARALELO=N   rodadas ao mesmo tempo (padrão: os núcleos da máquina, até 4)
//   MUTACAO_LIMITE_S=S   limite de cada rodada, em segundos (padrão: 60)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Testes que formam a rede de segurança (rodam em toda mutação, além dos específicos).
const SEG = ['test/seguranca/invariantes-estaticas.test.js', 'test/seguranca/superficie-ataque.test.js',
  'test/seguranca/payloads-owasp.test.js', 'test/seguranca/cadeia-suprimentos.test.js'];

// Roda só no controle (#104): abre 1 `node --check` por arquivo e gasta ~2/3 de cada rodada.
// Ele confere o semComentarios contra o código de todo o repositório, sem olhar guarda nenhum.
// Se uma mutação depender dele um dia, ela sobrevive e reprova: o buraco não fica escondido.
const SO_NO_CONTROLE = '^fonte: tirar comentários não muda a sintaxe';

/**
 * { nome, arquivo, de, para, testes? }: troca o trecho `de` (que precisa aparecer UMA vez)
 * por `para`. `testes` acrescenta arquivos de teste além da rede de segurança.
 */
const MUTACOES = [
  { nome: 'sem Host check (DNS rebinding)', arquivo: 'server/index.js', de: '  app.use(hostCheck);\n', para: '' },
  { nome: 'sem CSRF check', arquivo: 'server/index.js', de: '  app.use(csrfCheck);\n', para: '' },
  { nome: 'API sem exigir login', arquivo: 'server/index.js', de: "  app.use('/api', makeRequireAuth(DASH_TOKEN, sessions));\n", para: '' },
  { nome: 'painel escutando em 0.0.0.0', arquivo: 'server/index.js', de: "app.listen(PORT, '127.0.0.1',", para: "app.listen(PORT, '0.0.0.0'," },
  { nome: 'corpo JSON sem limite de tamanho', arquivo: 'server/index.js', de: 'jsonBody({ limit: 50 * 1024 })', para: 'jsonBody({ limit: 50 * 1024 * 1024 })' },
  { nome: 'login sem limite de tentativas', arquivo: 'server/index.js', de: "app.post('/api/login', loginRateLimit, ", para: "app.post('/api/login', ", testes: ['test/integration/api-sessao.test.js'] },
  { nome: 'token aceito na URL (?token=)', arquivo: 'server/security.js', de: "    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';", para: "    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.query?.token || '');" },
  { nome: 'CSP com unsafe-inline', arquivo: 'server/security.js', de: `"script-src 'self'",`, para: `"script-src 'self' 'unsafe-inline'",` },
  { nome: 'sem X-Content-Type-Options', arquivo: 'server/security.js', de: "  res.setHeader('X-Content-Type-Options', 'nosniff');\n", para: '' },
  { nome: 'sem Cross-Origin-Embedder-Policy', arquivo: 'server/security.js', de: "  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');\n", para: '' },
  { nome: 'API indo para o cache do navegador', arquivo: 'server/security.js', de: "res.setHeader('Cache-Control', 'no-store');", para: "res.setHeader('Cache-Control', 'public, max-age=3600');" },
  { nome: 'comparação de segredo sem tempo constante', arquivo: 'server/http/session.js', de: 'return crypto.timingSafeEqual(ab, bb);', para: 'return ab.toString() === bb.toString();' },
  { nome: 'cookie de sessão sem HttpOnly', arquivo: 'server/http/session.js', de: 'Path=/; HttpOnly; SameSite=Strict`;', para: 'Path=/; SameSite=Strict`;' },
  { nome: 'JSON do corpo sem filtro de __proto__', arquivo: 'server/http/router.js', de: "JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v))", para: 'JSON.parse(text)' },
  { nome: 'query aceitando __proto__/constructor', arquivo: 'server/http/router.js', de: 'if (!CHAVES_PROIBIDAS.has(k) && !vistos.has(k))', para: 'if (!vistos.has(k))' },
  {
    nome: 'estáticos sem proteção de path traversal', arquivo: 'server/http/static.js',
    de: "    if (segments.some((seg) => seg.startsWith('.'))) return res.status(404).json({ error: 'não encontrado' });\n    const file = path.resolve(base, ...segments);\n    if (file !== base && !file.startsWith(base + path.sep)) return res.status(404).json({ error: 'não encontrado' });\n",
    para: '    const file = path.resolve(base, ...segments);\n',
  },
  { nome: 'arquivo de dados sem 0600', arquivo: 'server/storage/ndjson.js', de: 'fs.writeFileSync(tmp, data, { mode: 0o600 });', para: 'fs.writeFileSync(tmp, data);' },
  { nome: 'token do .env sem whitelist (injeção no SSH)', arquivo: 'server/config.js', de: ".filter((t) => TOKEN_RE.test(t) && !t.startsWith('-'));", para: '.filter((t) => t.length > 0);' },
  { nome: 'caminho de dados escapando de data/ (path traversal)', arquivo: 'server/config.js', de: '  if (p === dataDir || p.startsWith(dataDir + path.sep)) return p;\n', para: '  return p;\n', testes: ['test/unit/config.test.js'] },
  { nome: 'modo sistema prendendo os dados na pasta do código (/opt)', arquivo: 'server/config.js', de: 'export function clampPathToData(value, fallbackBasename, root = DATA_ROOT) {', para: 'export function clampPathToData(value, fallbackBasename, root = ROOT) {', testes: ['test/unit/config.test.js'] },
  { nome: 'host do SSH aceitando opção (-oProxyCommand)', arquivo: 'server/config.js', de: "if (!v || v.startsWith('-')) return 'seu-host';", para: "if (!v) return 'seu-host';" },
  { nome: 'CSV sem proteção contra fórmula', arquivo: 'server/csv.js', de: "const guarded = /^[=+\\-@\\t\\r]/.test(s) ? `'${s}` : s;", para: 'const guarded = s;', testes: ['test/unit/csv.test.js'] },
  { nome: 'template html sem escape', arquivo: 'public/js/core/html.js', de: '  return escape(value);\n}\n\nexport function html', para: '  return String(value);\n}\n\nexport function html' },
  { nome: 'SSH aceitando identidade nova do servidor', arquivo: 'server/setup/remoto.js', de: "'StrictHostKeyChecking=yes'", para: "'StrictHostKeyChecking=accept-new'" },
  { nome: 'script de coleta com texto a mais (authorized_keys quebrado)', arquivo: 'server/collector/builder.js', de: `"echo '===FIM==='",`, para: `"echo '===FIM==='; true",` },
  { nome: 'authorized_keys regravado inteiro (apaga os outros computadores)', arquivo: 'server/setup/preparo.js', de: "        ...keepOthers(publicKey, id),\n", para: "        'rm -f authorized_keys.novo',\n", testes: ['test/unit/preparo-varios-computadores.test.js'] },
  { nome: 'nome do computador sem saneamento (injeção no sudoers)', arquivo: 'server/setup/acesso.js', de: ".toLowerCase().replace(/[^a-z0-9]+/g, '-')", para: '.toLowerCase()', testes: ['test/unit/preparo-varios-computadores.test.js'] },
  { nome: 'admin oferecendo todas as chaves do agente (MaxAuthTries, fail2ban)', arquivo: 'server/setup/remoto.js', de: "['-i', identityFile, '-o', 'IdentitiesOnly=yes', ", para: "['-i', identityFile, ", testes: ['test/unit/setup-chave-ssh.test.js'] },
  { nome: 'apelido com ProxyJump/ProxyCommand aceito', arquivo: 'server/setup/remoto.js', de: "    if (v && v !== 'none') {\n", para: "    if (false) {\n", testes: ['test/unit/setup-chave-ssh.test.js'] },
  { nome: 'apelido virando opção do ssh (-oProxyCommand)', arquivo: 'server/setup/remoto.js', de: "/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(s)", para: "s.length > 0", testes: ['test/unit/setup-chave-ssh.test.js'] },
  { nome: 'senha do sudo indo para a conexão SSH no modo chave', arquivo: 'server/setup/instalacao.js', de: "    if (this.acesso.modo === 'chave') senha = '';\n", para: '', testes: ['test/unit/setup-chave-ssh.test.js'] },
  { nome: 'aviso de versão sem conferir a assinatura da tag', arquivo: 'server/setup/assinatura.js', de: 'if (verifyTag(root, t, { signersFile, run }).ok) return t;', para: 'return t;', testes: ['test/integration/atualizacao.test.js'] },
  { nome: 'botão Atualizar aceitando a versão da tela', arquivo: 'server/atualizacao/index.js', de: "if (!nova || versao !== nova) return", para: "if (!nova) return", testes: ['test/integration/atualizacao.test.js'] },
  { nome: 'botão Atualizar sem sessão', arquivo: 'server/atualizacao/index.js', de: "if (!this.loginExigido) return 'sem-login';\n", para: '', testes: ['test/integration/atualizacao.test.js'] },
  { nome: 'rotas de atualização fora da sessão', arquivo: 'server/security.js', de: "    if (!token) return next();\n", para: "    if (!token || req.path.startsWith('/api/atualizacao')) return next();\n", testes: ['test/integration/atualizacao.test.js'] },
  { nome: '2 atualizações ao mesmo tempo', arquivo: 'server/atualizacao/registro.js', de: "    if (donoDaTrava(root, procDir)) return false;\n", para: '', testes: ['test/unit/atualizacao-registro.test.js', 'test/integration/cli-manutencao.test.js'] },
  { nome: 'pasta .atualizacao sem 0700', arquivo: 'server/atualizacao/registro.js', de: "  fs.chmodSync(dir, 0o700);\n", para: '', testes: ['test/unit/atualizacao-registro.test.js'] },
  { nome: 'executor filho do painel (morre no stopPanel)', arquivo: 'server/atualizacao/executor.js', de: "{ cwd: root, detached: true, stdio: 'ignore' }", para: "{ cwd: root, stdio: 'ignore' }", testes: ['test/unit/atualizacao-registro.test.js'] },
  { nome: 'pré-versão liberada sem prazo', arquivo: 'server/atualizacao/registro.js', de: "return agora < JSON.parse(fs.readFileSync(arquivo(root, PRE), 'utf8')).ate;", para: "return Boolean(JSON.parse(fs.readFileSync(arquivo(root, PRE), 'utf8')).ate);", testes: ['test/unit/atualizacao-registro.test.js'] },
  { nome: '"procurar agora" sem limite de 1 por minuto', arquivo: 'server/atualizacao/index.js', de: 'if (this.agora() - this.manualEm < MANUAL_MS) return null;\n', para: '', testes: ['test/integration/atualizacao.test.js'] },
  { nome: 'código do assistente aceito 2 vezes', arquivo: 'server/setup/web.js', de: "    pendingHash = null; // uso único: o mesmo código não entra de novo\n", para: '', testes: ['test/integration/assistente-http.test.js'] },
  { nome: 'cancelar o assistente sem sessão', arquivo: 'server/setup/web.js', de: "    if (sessionHash && sid && safeEqual(hash(sid), sessionHash)) return next();\n", para: "    if (req.path.endsWith('/cancelar') || (sessionHash && sid && safeEqual(hash(sid), sessionHash))) return next();\n", testes: ['test/integration/assistente-http.test.js'] },
  { nome: 'código da tela vencido aceito', arquivo: 'server/setup/pela-tela.js', de: '.test(hash) && exp > now ?', para: '.test(hash) ?', testes: ['test/unit/setup-pela-tela.test.js'] },
  { nome: 'código da tela fica no disco depois de lido', arquivo: 'server/setup/pela-tela.js', de: "  fs.rmSync(file, { force: true });\n", para: '', testes: ['test/unit/setup-pela-tela.test.js'] },
  { nome: 'código da tela em texto puro no disco', arquivo: 'server/setup/pela-tela.js', de: 'JSON.stringify({ hash, exp: now + ttlMs })', para: 'JSON.stringify({ hash, codigo, exp: now + ttlMs })', testes: ['test/unit/setup-pela-tela.test.js'] },
  { nome: '--pela-tela para o painel sem código válido', arquivo: 'server/cli/instalar.js', de: "  if (!codigo) {\n    out.fail('sem código válido da tela', 'o painel continua no ar');\n    return 1;\n  }\n", para: '', testes: ['test/integration/cli-instalar.test.js'] },
  { nome: '--pela-tela durante uma atualização', arquivo: 'server/cli/instalar.js', de: "  if (emAndamento(root)) {\n", para: '  if (false) {\n', testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'clique na tela trocando a versão da pasta', arquivo: 'server/cli/instalar.js', de: "({ out, root, flags: {} }) !== true", para: "({ out, root, flags: {}, reexec: () => 0 }) !== true" },
  { nome: 'desistir sem restaurar a configuração anterior', arquivo: 'server/cli/instalar.js', de: "    restaurar();\n", para: '', testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'desistir sem religar o painel', arquivo: 'server/cli/instalar.js', de: "      return pelaTela.desistir();\n", para: '      return 1;\n', testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'painel novo vale sem responder', arquivo: 'server/cli/instalar.js', de: "if (!lig.ok || await responde(panelPort(root))) return lig;", para: 'if (!lig.ok || true) return lig;', testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'painel novo que falha fica sem volta', arquivo: 'server/cli/instalar.js', de: "    if (pelaTela) return pelaTela.voltar(lig.erro);\n", para: '', testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'erro ao ligar o painel novo sem volta', arquivo: 'server/cli/instalar.js', de: "      } catch (err) {\n        return { ok: false, erro: err.message };\n      }\n", para: "      } catch (err) {\n        throw err;\n      }\n", testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'volta sem parar o painel novo', arquivo: 'server/cli/instalar.js', de: "    const novo = await parar({ root, home });\n", para: "    const novo = { ok: true };\n", testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'volta perde o "iniciar com o computador"', arquivo: 'server/cli/instalar.js', de: "if (antes.mode === 'servico') (deps.systemctl", para: "if (false) (deps.systemctl", testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'SIGTERM no fim perde a cópia da configuração', arquivo: 'server/cli/instalar.js', de: "  process.on('SIGTERM', esperaOFim);\n", para: '', testes: ['test/integration/cli-instalar.test.js'] },
  { nome: 'botão Reconfigurar sem sessão', arquivo: 'server/atualizacao/index.js', de: "    if (!this.loginExigido) return 'sem-login';\n", para: '', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'rota de reconfigurar fora da sessão', arquivo: 'server/security.js', de: "    if (!token) return next();\n", para: "    if (!token || req.path.startsWith('/api/reconfigurar')) return next();\n", testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'dado da tela indo para a reconfiguração', arquivo: 'server/index.js', de: 'atualizacao.reconfigurar()', para: 'atualizacao.reconfigurar(req.body)' },
  { nome: 'comando da reconfiguração sem o --pela-tela', arquivo: 'server/atualizacao/executor.js', de: "comando: ['reconfigurar', '--pela-tela']", para: "comando: ['reconfigurar']", testes: ['test/unit/atualizacao-registro.test.js'] },
  { nome: 'reconfigurar sem conferir a assinatura da pasta', arquivo: 'server/atualizacao/procurar.js', de: "return currentVersionStatus(root, { run }).ok ? null : 'sem-assinatura';", para: 'return null;', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'reconfigurar fora da pasta da instalação', arquivo: 'server/atualizacao/procurar.js', de: "  if (foraDaInstalacao(root, home)) return 'outra-pasta';\n  if (modo === 'sistema') return null;\n  return currentVersionStatus", para: "  if (modo === 'sistema') return null;\n  return currentVersionStatus", testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'reconfigurar sem as conferências da pasta', arquivo: 'server/atualizacao/index.js', de: 'this.impedimento() ?? this.conferirReconfiguracao()', para: 'this.impedimento()', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'reconfigurar durante uma atualização', arquivo: 'server/atualizacao/index.js', de: "    if (emAndamento(this.root, { agora: this.agora(), procDir: this.procDir })) return 'rodando';\n", para: '', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: '2 reconfigurações ao mesmo tempo', arquivo: 'server/atualizacao/index.js', de: '    this.reconfigurandoAte = this.agora() + RECONFIGURAR_MS;\n', para: '', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'atualizar logo depois de pedir o assistente', arquivo: 'server/atualizacao/index.js', de: "    if (this.agora() < this.reconfigurandoAte) return 'rodando';\n", para: '', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'código da tela válido no disco sem executor', arquivo: 'server/atualizacao/index.js', de: '    retirarCodigoPelaTela(dados);\n', para: '', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'botão Reconfigurar preso depois que o executor falha', arquivo: 'server/atualizacao/index.js', de: "(dados);\n    this.reconfigurandoAte = 0;\n", para: '(dados);\n', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'código da tela no log do painel', arquivo: 'server/atualizacao/index.js', de: "this.log('[reconfiguração] assistente pedido pela tela');", para: 'this.log(`[reconfiguração] assistente pedido pela tela: ${codigo}`);', testes: ['test/integration/reconfigurar.test.js'] },
  // Etapa 8 da F8: o modelo de ameaças do Reconfigurar pela tela (SECURITY.md).
  { nome: 'rota de reconfigurar fora do limite de mutações', arquivo: 'server/index.js', de: "    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return apiRateLimit(req, res, next);\n", para: "    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/api/reconfigurar')) return apiRateLimit(req, res, next);\n", testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'código da tela curto (adivinhável)', arquivo: 'server/setup/pela-tela.js', de: 'crypto.randomBytes(16).toString', para: 'crypto.randomBytes(2).toString', testes: ['test/integration/reconfigurar.test.js'] },
  { nome: 'código da tela na query da URL', arquivo: 'public/js/views/manutencao.js', de: '`/configurar#codigo=${codigo}`', para: '`/configurar?codigo=${codigo}`' },
  { nome: 'código do assistente fica no endereço', arquivo: 'public/js/configurar/main.js', de: "    history.replaceState(null, '', location.pathname);\n", para: '' },
  { nome: 'assistente abandonado pela tela espera 1 h', arquivo: 'server/cli/instalar.js', de: 'const IDLE_TELA_MS = 15 * 60 * 1000;', para: 'const IDLE_TELA_MS = 60 * 60 * 1000;' },
  { nome: '--pela-tela sem o tempo parado curto', arquivo: 'server/cli/instalar.js', de: 'idleMs: deps.idleMs ?? IDLE_TELA_MS,', para: 'idleMs: deps.idleMs ?? IDLE_MS,' },
  { nome: 'cancelar o assistente fora da tela', arquivo: 'server/setup/web.js', de: '  if (onCancel) {\n', para: '  if (true) {\n', testes: ['test/integration/assistente-http.test.js'] },
  { nome: 'log inteiro do --pela-tela na tela', arquivo: 'server/setup/pela-tela.js', de: "      .filter((l) => l.startsWith('✗ '))\n", para: '', testes: ['test/unit/setup-pela-tela.test.js'] },
  { nome: 'motivos do --pela-tela sem limite', arquivo: 'server/setup/pela-tela.js', de: '      .slice(0, MAX_MOTIVOS);\n', para: ';\n', testes: ['test/unit/setup-pela-tela.test.js'] },
  { nome: 'executor aceita tag com nome trocado', arquivo: 'libexec/atualizador', de: '  [ "$(git_repo cat-file tag "refs/tags/$1" | sed -n \'s/^tag //p\' | head -n 1)" = "$1" ] || return 1\n', para: '', testes: ['test/integration/atualizador.test.js'] },
  { nome: 'modo clone aceita tag com nome trocado', arquivo: 'server/setup/assinatura.js', de: "    if (obj.status !== 0 || nome !== tag) return { ok: false, reason: 'nome-trocado', tag };\n", para: '', testes: ['test/integration/assinatura.test.js'] },
  { nome: 'executor sem conferir a assinatura de novo', arquivo: 'libexec/atualizador', de: '  tag_confere "$nova" "$lista" || falhar', para: '  true || falhar', testes: ['test/integration/atualizador.test.js'] },
  { nome: 'executor volta depois das 24 h', arquivo: 'libexec/atualizador', de: 'PRAZO_VOLTAR=86400', para: 'PRAZO_VOLTAR=999999999', testes: ['test/integration/atualizador.test.js'] },
  { nome: 'executor herdando o ambiente de quem chamou', arquivo: 'libexec/atualizador', de: 'if [ "${ATUALIZADOR_AMBIENTE:-}" != limpo ]; then', para: 'if false; then', testes: ['test/integration/atualizador.test.js'] },
  { nome: 'executor troca o link na pasta base', arquivo: 'libexec/atualizador', de: 'mv -fT "$VERSOES/.$1.novo" "$VERSOES/$1"', para: 'ln -sfn "$2" "$BASE/$1"', testes: ['test/integration/atualizador.test.js'] },
  { nome: 'executor sem conferir a soma do Node', arquivo: 'libexec/atualizador', de: '    [ "$(sha256sum "$TMP_NODE/node.tar.gz" | cut -d\' \' -f1)" = "$soma" ] ||', para: '    true ||', testes: ['test/integration/atualizador.test.js'] },
  { nome: 'executor lê a soma do Node fora da versão nova', arquivo: 'libexec/atualizador', de: '  arquivo="$1/scripts/node-runtime.sh"', para: '  arquivo="$VERSOES/$atual/scripts/node-runtime.sh"', testes: ['test/integration/atualizador.test.js'] },
  { nome: 'unidade sem ProtectSystem', arquivo: 'pacote/systemd/server-dashboard-atualizar.service', de: 'ProtectSystem=strict\n', para: '', testes: ['test/unit/unidades-systemd.test.js'] },
  { nome: 'unidade grava na pasta base', arquivo: 'pacote/systemd/server-dashboard-verificar.service', de: 'ReadWritePaths=/opt/server-dashboard/repo.git ', para: 'ReadWritePaths=/opt/server-dashboard /opt/server-dashboard/repo.git ', testes: ['test/unit/unidades-systemd.test.js'] },
  { nome: 'unidade com parâmetro de fora', arquivo: 'pacote/systemd/server-dashboard-voltar.service', de: 'libexec/atualizador voltar\n', para: 'libexec/atualizador voltar %i\n', testes: ['test/unit/unidades-systemd.test.js'] },
  { nome: 'polkit libera outro verbo', arquivo: 'pacote/polkit/50-server-dashboard.rules', de: "action.lookup('verb') !== 'start'", para: "action.lookup('verb') === 'kill'", testes: ['test/unit/polkit-e-grupo.test.js'] },
  { nome: 'polkit libera outra unidade', arquivo: 'pacote/polkit/50-server-dashboard.rules', de: "unidade !== 'server-dashboard-voltar.service'", para: "unidade.indexOf('server-dashboard-') !== 0", testes: ['test/unit/polkit-e-grupo.test.js'] },
  { nome: 'polkit sem conferir o grupo', arquivo: 'pacote/polkit/50-server-dashboard.rules', de: "!subject.isInGroup('server-dashboard')", para: 'false', testes: ['test/unit/polkit-e-grupo.test.js'] },
  { nome: 'polkit libera outra ação', arquivo: 'pacote/polkit/50-server-dashboard.rules', de: "action.id !== 'org.freedesktop.systemd1.manage-units'", para: "action.id.indexOf('org.freedesktop.systemd1.') !== 0", testes: ['test/unit/polkit-e-grupo.test.js'] },
  { nome: 'executor no grupo do polkit', arquivo: 'pacote/sysusers/server-dashboard.conf', de: 'g server-dashboard - -\n', para: 'g server-dashboard - -\nm _server-dashboard server-dashboard\n', testes: ['test/unit/polkit-e-grupo.test.js'] },
  { nome: 'painel pede outra unidade do sistema', arquivo: 'server/atualizacao/pacote.js', de: "if (unidade !== UNIDADE_ATUALIZAR && unidade !== UNIDADE_VOLTAR) throw", para: 'if (false) throw', testes: ['test/integration/atualizacao-pacote.test.js'] },
  { nome: 'painel deixa o polkit pedir senha', arquivo: 'server/atualizacao/pacote.js', de: "['--no-ask-password', 'start', unidade]", para: "['start', unidade]", testes: ['test/integration/atualizacao-pacote.test.js'] },
  { nome: 'painel aceita versão do estado fora do padrão', arquivo: 'server/atualizacao/pacote.js', de: "RELEASE_TAG.test(d.versao ?? '') && ", para: '', testes: ['test/integration/atualizacao-pacote.test.js'] },
  { nome: 'troca no pacote sem conferir o link atual', arquivo: 'server/cli/atualizar.js', de: 'if (!alvo || alvo === current) {', para: 'if (!alvo) {', testes: ['test/integration/atualizacao-pacote.test.js'] },
  { nome: 'troca no pacote sem pedir o voltar', arquivo: 'server/cli/atualizar.js', de: 'const volta = executor(UNIDADE_VOLTAR);', para: 'const volta = { ok: true, erro: null };', testes: ['test/integration/atualizacao-pacote.test.js'] },
  { nome: 'pacote aceita o --pre', arquivo: 'server/cli/atualizar.js', de: 'if (pacote && flags.pre && !registro) {', para: 'if (false) {', testes: ['test/integration/atualizacao-pacote.test.js'] },
  { nome: 'exec com shell importado', arquivo: 'server/cli/servico.js', de: "import { spawn, spawnSync } from 'node:child_process';", para: "import { exec, spawn, spawnSync } from 'node:child_process';" },
];

/**
 * Copia para uma pasta temporária o que está (ou vai estar) no git: os arquivos rastreados e
 * os novos ainda não commitados que o .gitignore não exclui. Depois faz dela um repositório
 * git, porque os testes de segurança listam os arquivos com `git ls-files`.
 */
function copiar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-mutacao-'));
  const lista = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\0').filter(Boolean);
  for (const f of lista) {
    const origem = path.join(ROOT, f);
    if (!fs.existsSync(origem)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(origem, path.join(dir, f));
  }
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=mutacao@example.com', '-c', 'user.name=mutacao', 'commit', '-q', '-m', 'base');
  copiados = lista.length;
  return dir;
}

let copiados = 0;

// Rodadas ao mesmo tempo. Cada `node --test` já roda os arquivos dele em paralelo, então mais
// de 4 rodadas só disputam os mesmos núcleos (medido em #128).
const PARALELO = Math.max(1, Math.floor(Number(process.env.MUTACAO_PARALELO)) || Math.min(4, os.availableParallelism()));
// Limite de cada rodada. Com 4 rodadas em 4 núcleos, a mais lenta levou 10,5 s (#128). Uma
// rodada presa num temporizador real (PR #127: 15 min) reprova aqui com o nome da mutação. O
// controle roda todos os testes extras de uma vez e ganha o triplo.
const LIMITE_S = Math.max(5, Number(process.env.MUTACAO_LIMITE_S) || 60);

// Grupos de processo das rodadas em andamento: um Ctrl+C ou o limite derruba a rodada inteira
// (o `node --test` e os filhos dele), sem deixar teste órfão rodando na cópia apagada.
const ativos = new Set();

/**
 * Testes que o `--test-timeout` derrubou, lidos do reporter spec: "✖ nome (Nms)" seguido de
 * "test timed out after". É o que diz QUAL teste prendeu a rodada.
 */
export function testesPresos(saida) {
  return [...new Set([...String(saida).matchAll(/✖ (.+?) \([\d.]+ms\)\n\s*'test timed out after/g)].map((m) => m[1]))];
}

/**
 * Roda a rede de segurança (mais `extras`) na cópia `dir`, com o limite `limiteS`. Devolve o
 * resultado do node --test; `estourou` diz que a rodada passou do limite e foi derrubada, e
 * `presos`, os testes que passaram do limite de cada teste.
 */
function rodarTestes(dir, extras = [], pular = [], limiteS = LIMITE_S) {
  // Sem NODE_TEST_CONTEXT: se este script rodar dentro de um `node --test`, o filho não
  // pode se achar um subteste (ele precisa devolver o próprio código de saída).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const inicio = Date.now();
  return new Promise((resolve) => {
    // detached: a rodada vira um grupo de processos próprio, para o limite derrubar todos.
    // Cada teste tem limite um pouco menor que o da rodada: o que prende a rodada falha antes,
    // com o nome no relatório, e o limite da rodada sobra para o que segura o processo depois.
    const porTeste = `--test-timeout=${Math.max(1, limiteS - 10) * 1000}`;
    const p = spawn(process.execPath, ['--test', '--test-reporter=spec', porTeste, ...pular, ...SEG, ...extras],
      { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    ativos.add(p.pid);
    let saida = '';
    let estourou = false;
    p.stdout.on('data', (c) => { saida += c; });
    p.stderr.on('data', (c) => { saida += c; });
    const teto = setTimeout(() => {
      estourou = true;
      try { process.kill(-p.pid, 'SIGKILL'); } catch { /* já saiu */ }
    }, limiteS * 1000);
    p.on('close', (status) => {
      clearTimeout(teto);
      ativos.delete(p.pid);
      const conta = (rotulo) => Number((saida.match(new RegExp(`ℹ ${rotulo} (\\d+)`)) || [])[1] || 0);
      resolve({ status, estourou, presos: testesPresos(saida), testes: conta('tests'), falhas: conta('fail'), segundos: ((Date.now() - inicio) / 1000).toFixed(1), saida });
    });
  });
}

/** Nome do último teste que terminou na saída do reporter spec (pista de onde a rodada parou). */
function ultimoTeste(saida) {
  const linhas = String(saida).split('\n').filter((l) => /^\s*[✔✖] /.test(l));
  return linhas.length ? linhas[linhas.length - 1].trim().slice(0, 160) : 'nenhum';
}

/** Quantas vezes o trecho `de` da mutação aparece no arquivo dela, na cópia `dir`. */
const ocorrencias = (dir, m) => fs.readFileSync(path.join(dir, m.arquivo), 'utf8').split(m.de).length - 1;

/** Aplica a mutação `m` na cópia `dir`, roda os testes e desfaz. */
async function medir(dir, m) {
  const arquivo = path.join(dir, m.arquivo);
  const original = fs.readFileSync(arquivo, 'utf8');
  fs.writeFileSync(arquivo, original.replace(m.de, m.para));
  try {
    return await rodarTestes(dir, m.testes, [`--test-skip-pattern=${SO_NO_CONTROLE}`]);
  } finally {
    fs.writeFileSync(arquivo, original);
  }
}

async function main() {
  const inicio = Date.now();
  const dirs = [copiar()];
  const sobreviventes = [];
  const presas = [];
  let mortas = 0;
  try {
    // Trecho que sumiu ou se repete: "desatualizada", sem rodar nada. Conferido antes de tudo,
    // para o aviso sair no começo do log, e não depois de todas as rodadas.
    const desatualizadas = MUTACOES.filter((m) => ocorrencias(dirs[0], m) !== 1)
      .map((m) => `${m.nome}: o trecho aparece ${ocorrencias(dirs[0], m)} vez(es) em ${m.arquivo}`);
    for (const d of desatualizadas) console.log(`  ? desatualizada — ${d}`);
    // Controle: sem mutação, a rede precisa passar. Senão toda mutação "morreria" por outro
    // motivo (cópia incompleta, teste quebrado) e o resultado não valeria nada.
    const extras = [...new Set(MUTACOES.flatMap((m) => m.testes || []))];
    const controle = await rodarTestes(dirs[0], extras, [], LIMITE_S * 3);
    if (controle.estourou || controle.status !== 0 || controle.testes < 50 || controle.falhas > 0) {
      const motivo = controle.estourou ? `passou do limite de ${LIMITE_S * 3} s` : `${controle.testes} testes, ${controle.falhas} falhas`;
      console.log(`  ✗ controle: ${motivo} SEM mutação; nada a medir\n${controle.saida.slice(-2500)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ controle: sem mutação, ${controle.testes} testes passam (${controle.segundos} s, ${copiados} arquivos copiados)`);
    // Uma cópia por rodada simultânea: cada uma muta só a sua, então nenhuma vê a mutação
    // da outra. As cópias saem da 1ª, que já é um repositório git com o commit base.
    for (let i = 1; i < PARALELO; i++) {
      const outra = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-mutacao-'));
      fs.cpSync(dirs[0], outra, { recursive: true });
      dirs.push(outra);
    }
    const fila = MUTACOES.filter((m) => ocorrencias(dirs[0], m) === 1);
    const total = fila.length;
    let feitas = 0;
    const instaveis = [];
    const trabalhador = async (dir) => {
      for (let m = fila.shift(); m; m = fila.shift()) {
        let r = await medir(dir, m);
        // Rodada presa: repete 1 vez, já com as outras rodadas correndo menos. Um teste que
        // espera um temporizador real (PR #127) prende de novo e reprova. Um travamento raro
        // (#128: 1 rodada em cerca de 10 execuções da mutação, sem repetir isolada) passa na
        // 2ª vez e fica registrado com o nome do teste, para virar issue.
        const presa = (x) => x.estourou || x.presos.length > 0;
        const quais = (x) => (x.presos.length ? `preso em: ${x.presos.join('; ')}` : `último teste terminado: ${ultimoTeste(x.saida)}`);
        if (presa(r)) {
          const antes = quais(r);
          r = await medir(dir, m);
          if (!presa(r)) instaveis.push(`${m.nome} (1ª vez ${antes})`);
        }
        feitas += 1;
        const n = `[${String(feitas).padStart(String(total).length)}/${total}]`;
        // Só conta como acusada se um teste FALHOU de verdade (asserção), não se o processo
        // caiu por outro motivo. Rodada que passou do limite não conta: ela reprova à parte.
        // Teste derrubado pelo --test-timeout também é rodada presa, e não "acusada": o teste
        // falhou por tempo, não por uma asserção.
        if (presa(r)) {
          presas.push({ ...m, presos: r.presos });
          console.log(`  ✗ ${n} ${m.nome} — passou do limite de ${LIMITE_S} s 2 vezes (${quais(r)})`);
        } else if (r.falhas > 0) {
          mortas += 1;
          console.log(`  ✓ ${n} ${m.nome} — acusada por ${r.falhas} teste(s) (${r.segundos} s)`);
        } else {
          sobreviventes.push(m.nome);
          console.log(`  ✗ ${n} ${m.nome} — SOBREVIVEU (${r.testes} testes, nenhuma falha; saída ${r.status})`);
        }
      }
    };
    await Promise.all(dirs.map(trabalhador));
    for (const d of desatualizadas) console.log(`    · desatualizada: ${d}`);
    for (const i of instaveis) console.log(`  ▲ travou 1 vez e passou na repetição: ${i}`);
    for (const m of presas) {
      console.log(`    · passou do limite: ${m.nome} (${m.arquivo})${m.presos.length ? `, no teste "${m.presos.join('", "')}"` : ''}.`
        + ` Para reproduzir, aplique a mutação e rode node --test ${[...SEG, ...(m.testes || [])].join(' ')}`);
    }
    const ok = sobreviventes.length === 0 && desatualizadas.length === 0 && presas.length === 0;
    const segundos = Math.round((Date.now() - inicio) / 1000);
    console.log(`${mortas}/${MUTACOES.length} mutações acusadas pelos testes${ok ? '' : ` · ${sobreviventes.length} sobreviveram · ${desatualizadas.length} desatualizadas · ${presas.length} passaram do limite`}${instaveis.length ? ` · ${instaveis.length} repetida(s) depois de travar` : ''} · ${PARALELO} em paralelo, ${segundos} s`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

// Só roda chamado pela linha de comando: test/unit/mutacao-seguranca.test.js importa
// testesPresos sem disparar a mutação nem os tratadores de sinal.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, () => {
      for (const pid of ativos) try { process.kill(-pid, 'SIGKILL'); } catch { /* já saiu */ }
      process.exit(130);
    });
  }
  main();
}
