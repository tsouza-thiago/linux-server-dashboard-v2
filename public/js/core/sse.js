// Conexão ao vivo (SSE). O navegador reconecta sozinho e o servidor reenvia o que faltou
// (Last-Event-ID). Se a sessão acabou, o EventSource só vê "erro": aí conferimos a sessão
// em vez de reconectar em loop.
import { api } from './api.js';

const EVENTS = ['hello', 'sample', 'alerts', 'annotations', 'status'];

export function connect({ onEvent, onState, onAuthLost } = {}) {
  const es = new EventSource('/api/stream');
  for (const name of EVENTS) {
    es.addEventListener(name, (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      onEvent?.(name, data);
    });
  }
  es.onopen = () => onState?.('aberta');
  es.onerror = async () => {
    onState?.('caiu');
    try {
      const s = await api.session();
      if (s.authRequired && !s.authenticated) {
        es.close();
        onAuthLost?.();
      }
    } catch { /* painel fora do ar: o EventSource tenta de novo sozinho */ }
  };
  return { close: () => es.close() };
}
