// Espera por uma condição, em vez de um tempo fixo.
//
// `await new Promise((r) => setTimeout(r, 100))` funciona na máquina de quem escreveu o teste
// e falha com a máquina carregada (CI, suíte com cobertura): o processo ainda não subiu, a
// tela ainda não foi desenhada. Aqui o teste espera o que realmente importa, com um teto de
// tempo; se o teto estourar, a asserção seguinte falha com a mensagem dela.
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Repete `condicao()` a cada `passoMs` até ela dar verdadeiro ou passar `timeoutMs`. */
export async function esperarAte(condicao, { timeoutMs = 5000, passoMs = 10 } = {}) {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condicao()) return true;
    } catch {
      // A condição pode lançar enquanto o estado ainda não existe (ex.: arquivo ausente).
    }
    if (Date.now() > limite) return false;
    await dormir(passoMs);
  }
}
