// Aperta o botão Reconfigurar de uma instalação de verdade (rodar.sh, cenário D): pede o assistente,
// entra com o código da resposta, cancela e espera o painel voltar. O painel cai no meio, e as
// leituras só tentam de novo: node reconfigurar.mjs <endereço> <token>
const [, , base, token] = process.argv;
const TETO_MS = 60000;

const dormir = (ms) => new Promise((r) => { setTimeout(r, ms); });
const cookieDe = (resposta, nome) => resposta.headers.getSetCookie().find((c) => c.startsWith(`${nome}=`))?.split(';')[0];

/** Repete `ler` até ele devolver algo; conexão recusada é só o painel trocando. */
async function esperar(ler, oQue) {
  const fim = Date.now() + TETO_MS;
  while (Date.now() < fim) {
    const valor = await ler().catch(() => null);
    if (valor) return valor;
    await dormir(200);
  }
  console.log(`não vi ${oQue} em ${TETO_MS / 1000} s`);
  process.exit(1);
}

const pedido = await fetch(`${base}/api/reconfigurar/iniciar`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: '{}',
});
if (pedido.status !== 202) {
  console.log(`iniciar respondeu ${pedido.status}: ${await pedido.text()}`);
  process.exit(1);
}
const { codigo } = await pedido.json();

const csrf = await esperar(async () => {
  const r = await fetch(`${base}/configurar`);
  return r.status === 200 ? cookieDe(r, 'dash_csrf') : null;
}, 'o assistente');

const post = (rota, corpo, cookie) => fetch(`${base}/api/configurar/${rota}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
  body: JSON.stringify(corpo),
});
const entrou = await post('entrar', { codigo }, csrf);
if (entrou.status !== 200) {
  console.log(`entrar respondeu ${entrou.status}`);
  process.exit(1);
}
const cancelou = await post('cancelar', {}, `${csrf}; ${cookieDe(entrou, 'dash_setup')}`);
if (cancelou.status !== 200) {
  console.log(`cancelar respondeu ${cancelou.status}`);
  process.exit(1);
}

await esperar(async () => {
  const r = await fetch(`${base}/api/atualizacao`, { headers: { Authorization: `Bearer ${token}` } });
  return r.status === 200 && (await r.json()).instalada;
}, 'o painel de volta');
console.log('assistente aberto, cancelado e painel de volta');
