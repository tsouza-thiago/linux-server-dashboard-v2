// Aperta o botão Atualizar de uma instalação de verdade (rodar.sh, cenário D) e acompanha como a
// tela: procura, pede a troca e lê o registro até o fim. O painel cai no meio, e a leitura só
// tenta de novo: node botao.mjs <endereço> <token> <versão> <modo esperado> <resultado esperado>
const [, , base, token, versao, modoEsperado, resultadoEsperado] = process.argv;
const TETO_MS = 180000;

const dormir = (ms) => new Promise((r) => { setTimeout(r, ms); });
const api = (rota, corpo) => fetch(`${base}${rota}`, {
  method: corpo ? 'POST' : 'GET',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: corpo ? JSON.stringify(corpo) : undefined,
});

const estado = await (await api('/api/atualizacao/verificar', {})).json();
console.log(`achou ${estado.nova}, modo ${estado.modo}, bloqueio ${estado.bloqueio}`);
if (estado.nova !== versao || estado.modo !== modoEsperado) process.exit(1);
const iniciar = await api('/api/atualizacao/iniciar', { versao });
if (iniciar.status !== 202) {
  console.log(`iniciar respondeu ${iniciar.status}: ${await iniciar.text()}`);
  process.exit(1);
}

const limite = Date.now() + TETO_MS;
let desde = 0;
while (Date.now() < limite) {
  try {
    const r = await (await api(`/api/atualizacao/registro?desde=${desde}`)).json();
    process.stdout.write(r.texto);
    desde = r.proximo;
    if (r.fase === 'fim') {
      console.log(`resultado ${r.resultado}`);
      process.exit(r.resultado === resultadoEsperado ? 0 : 1);
    }
  } catch { /* o painel está reiniciando */ }
  await dormir(500);
}
console.log('o registro não terminou');
process.exit(1);
