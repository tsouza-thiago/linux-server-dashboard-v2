// Porta TCP livre para os testes que precisam subir um servidor de verdade.
import net from 'node:net';

/** Abre e fecha um servidor na porta 0 e devolve a porta que o sistema escolheu. */
export async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}
