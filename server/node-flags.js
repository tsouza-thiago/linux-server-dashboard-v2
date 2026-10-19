// Opções do Node para o processo do painel (#26). Ficam aqui, num lugar só, porque o painel
// sobe por 4 caminhos (serviço systemd, segundo plano, npm start e o soak que o mede) e
// todos precisam da mesma configuração de memória.
//
// --max-semi-space-size=2: a geração jovem do V8 (objetos recém-criados) cresce até 32 MB
// quando o painel carrega as 72 h do disco e não volta a encolher; as coletas seguintes vão
// ocupando essas páginas. Com o teto de 2 MB, o RSS com 72 h em memória caiu de ~101 para
// ~89 MB no soak, sem custo de CPU por coleta. A opção só vale na linha de comando: ligada
// pelo código (v8.setFlagsFromString), depois do Node iniciar, não tem efeito.
export const PANEL_NODE_FLAGS = Object.freeze(['--max-semi-space-size=2']);
