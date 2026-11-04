// Limpeza do fim de um teste na ordem certa (#148): o que foi aberto por último fecha primeiro, e
// um passo que falha não pula os outros.
//
// Por que não `t.after` direto: o node:test roda os `t.after` na ordem em que foram registrados, e
// o 1º que lança pula os seguintes. O padrão "apaga a pasta" (registrado antes) + "fecha o painel"
// (registrado depois) apagava a pasta com o painel ainda gravando nela (a sessão do login, por
// exemplo): o `fs.rmSync` falhava com ENOTEMPTY, o `close(server)` não rodava e o processo do
// teste ficava preso para sempre, com o servidor escutando.

const pilhas = new WeakMap();

/**
 * Agenda `fn` para o fim do teste `t`, como um `defer`: os passos rodam do último para o 1º, todos
 * rodam mesmo se um lançar, e o 1º erro sobe no fim (o teste falha, mas nada fica aberto).
 * Num arquivo que usa `aoFim`, use só ele para limpar: um `t.after` solto não entra na pilha.
 */
export function aoFim(t, fn) {
  let pilha = pilhas.get(t);
  if (!pilha) {
    pilha = [];
    pilhas.set(t, pilha);
    t.after(async () => {
      let erro = null;
      while (pilha.length) {
        const passo = pilha.pop();
        try { await passo(); } catch (e) { erro ??= e; }
      }
      if (erro) throw erro;
    });
  }
  pilha.push(fn);
}
