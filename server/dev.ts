import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createServer as createViteServer } from 'vite';

for (const name of ['.env.local', '.env']) {
  if (existsSync(name)) process.loadEnvFile(name);
}
const { handleRequest } = await import('./app.ts');
const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/api/')) return vite.middlewares(req, res);
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 65536) { res.writeHead(413).end('Request too large'); return; }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const method = req.method ?? 'GET';
    const request = new Request(`http://${req.headers.host ?? 'localhost:5173'}${req.url}`, {
      method, headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
    });
    const response = await handleRequest(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', retryable: true } }));
  }
});
const port = Number(process.env.PORT ?? 5173);
server.listen(port, '127.0.0.1', () => console.log(`Front Row is ready at http://localhost:${port}`));
async function stop() { await vite.close(); server.close(); }
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
