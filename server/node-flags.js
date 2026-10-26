// Opções do Node para o processo do painel (#26). Ficam aqui, num lugar só, porque o painel
// sobe por 4 caminhos (serviço systemd, segundo plano, npm start e o soak que o mede) e
// todos precisam da mesma configuração de memória.
//
// --max-semi-space-size=2: a geração jovem do V8 (objetos recém-criados) cresce até 32 MB
// quando o painel carrega as 72 h do disco e não volta a encolher; as coletas seguintes vão
// ocupando essas páginas. Com o teto de 2 MB, o RSS com 72 h em memória caiu de ~101 para
// ~89 MB no soak, sem custo de CPU por coleta. A opção só vale na linha de comando: ligada
// pelo código (v8.setFlagsFromString), depois do Node iniciar, não tem efeito.
//
// --optimize-for-size (#78): o V8 deixa a geração velha crescer bem além do que está vivo
// antes de uma coleta completa, e não devolve ao sistema as páginas que já usou. Um pedido
// de baldes de 90 dias cria ~20 MB de objetos que vivem só durante o pedido; em sequência
// (Relatórios em fuso de 45 min, 5 pedidos), o RSS ia a ~200 MB. Com a opção, o V8 coleta
// mais cedo e o pico fica perto de 100 MB.
export const PANEL_NODE_FLAGS = Object.freeze(['--max-semi-space-size=2', '--optimize-for-size']);
