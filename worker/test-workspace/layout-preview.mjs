import { layoutJs, layoutCss, layoutLogo } from '../../.generated/layout-preview.mjs';

// Invoked only after the existing TEST isolation, session and same-origin checks.
export function layoutPreviewResponse(request, headers) {
  const url = new URL(request.url);
  if (!['/layout-preview', '/layout-preview.js', '/layout-preview-logo.png'].includes(url.pathname)) return null;
  if (request.method !== 'GET' || url.search) return new Response('Not found', { status: 404, headers });
  const responseHeaders = { ...headers, 'x-tessera-layout': 'fixed-viewport-v1' };
  if (url.pathname.endsWith('.js')) return new Response(layoutJs, { headers: { ...responseHeaders, 'content-type': 'application/javascript; charset=utf-8' } });
  if (url.pathname.endsWith('.png')) return new Response(Uint8Array.from(atob(layoutLogo), char => char.charCodeAt(0)), { headers: { ...responseHeaders, 'content-type': 'image/png' } });
  return new Response(`<!doctype html><html lang="sr-Latn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · Pregled rasporeda</title><style>${layoutCss.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script src="/layout-preview.js" defer></script></body></html>`, { headers: { ...responseHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `${headers['content-security-policy']}; img-src 'self'` } });
}
