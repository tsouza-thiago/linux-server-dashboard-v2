import http from 'node:http';

export function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

export function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  // O corpo vai com Content-Length: sem ele, num DELETE o Node não enquadra o corpo e o
  // servidor leria esses bytes como uma segunda requisição (inválida).
  const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const framing = payload ? { 'Content-Length': payload.length } : {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: { Host: 'localhost', ...framing, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* não é JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function readSSE(port, { path = '/api/stream', headers = {}, until = 2, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path,
      headers: { Host: 'localhost', ...headers },
    }, (res) => {
      let data = '';
      const done = () => {
        if (settled) return;
        settled = true;
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, data });
      };
      res.on('data', (c) => {
        data += c.toString();
        if (data.split('\n\n').length - 1 >= until) done();
      });
      res.on('end', done);
      res.on('error', done);
    });
    req.on('error', reject);
    req.end();
    setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy();
        resolve({ status: null, headers: {}, data: '', timeout: true });
      }
    }, timeoutMs).unref();
  });
}