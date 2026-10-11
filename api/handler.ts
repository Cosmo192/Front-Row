import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../server/app.ts';

export function normalizeApiPath(path: string): string {
  return `/api/${path.replace(/^\/+/, '').replace(/^api\//, '')}`;
}

// One adapter serves every /api/* route via the Vercel rewrite. No open server socket.
export default async function handler(request: IncomingMessage & { body?: unknown }, response: ServerResponse) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const host = request.headers.host || 'localhost';
  const path = request.url || '/api/config';
  const url = new URL(path, `https://${host}`);
  // vercel.json rewrites /api/* to this single function and carries the
  // original path in the `path` query parameter.
  if (url.pathname === '/api/handler') {
    const original = url.searchParams.get('path');
    if (original) {
      url.pathname = normalizeApiPath(original);
      url.search = '';
    }
  }
  let body: string | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.body !== undefined) body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    else {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 64 * 1024) { response.statusCode = 413; response.end(); return; }
        chunks.push(bytes);
      }
      if (length) body = Buffer.concat(chunks).toString('utf8');
    }
  }
  const result = await handleRequest(new Request(url, { method: request.method, headers, ...(body ? { body } : {}) }));
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(await result.text());
}
