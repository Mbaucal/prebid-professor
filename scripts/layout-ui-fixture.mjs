// Serves the actual production dashboard build plus the shared TEST preview.
// All API responses are synthetic and all writes are rejected.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { layoutPreviewResponse } from '../worker/test-workspace/layout-preview.mjs';

const root = resolve('dist/client');
const address = 'http://127.0.0.1:4182';
const publishers = Array.from({ length: 12 }, (_, i) => ({
  id: `publisher-${i + 1}`, name: `Example Digital News Publisher ${i + 1}`, status: 'active', sitesCount: 1, notes: 'example.com',
  sites: [{ id: `site-${i + 1}`, publisherAccountId: `publisher-${i + 1}`, name: `site${i + 1}.example.com`, domain: `site${i + 1}.example.com`, gamPath: '/123456/example.com/', status: 'draft', currentVersion: 'draft', adsTxtUrl: 'https://example.com/ads.txt', updatedAt: '2026-09-22T00:00:00Z', lastPublishedAt: null, adUnitsCount: 36, biddersCount: 0 }],
}));
const headers = { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, address);
    let response;
    if (req.method !== 'GET') response = Response.json({ error: 'Read-only fixture' }, { status: 405 });
    else if (url.pathname === '/api/publisher-accounts') response = Response.json({ publishers });
    else if (url.pathname === '/api/auth/me') response = Response.json({ ok: true, user: { email: 'example-admin@example.com' } });
    else if (url.pathname === '/api/health') response = Response.json({ ok: true, database: 'connected', service: 'Tessera layout fixture', details: Array.from({ length: 25 }, (_, i) => `Synthetic diagnostic ${i + 1}`) });
    else if (url.pathname.startsWith('/api/')) response = Response.json({ error: 'Not part of layout fixture' }, { status: 404 });
    else response = layoutPreviewResponse(new Request(url), headers);
    if (!response) {
      const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
      if (!file.startsWith(root + '/')) throw Error('Invalid asset');
      response = new Response(readFileSync(file), { headers: { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(file)] ?? 'application/octet-stream' } });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4182, '127.0.0.1', () => console.log('Layout fixture ready'));
