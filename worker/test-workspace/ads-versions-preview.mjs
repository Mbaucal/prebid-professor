import { reviewJs, reviewCss } from '../../.generated/ads-versions-preview.mjs';

// Called only after the workspace boundary and TEST authentication checks.
export function adsVersionsPreviewResponse(request, headers) {
  const url = new URL(request.url);
  if (!['/preview/ads-versions', '/preview/ads-versions.js'].includes(url.pathname)) return null;
  const secured = { ...headers, 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" };
  if (request.method !== 'GET' || url.search) return new Response('Not found', { status: 404, headers: secured });
  if (url.pathname.endsWith('.js')) return new Response(reviewJs, { headers: { ...secured, 'content-type': 'application/javascript; charset=utf-8' } });
  return new Response(`<!doctype html><html lang="sr-Latn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ads.js versions — Tessera TEST pregled</title><style>${reviewCss.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script src="/preview/ads-versions.js" defer></script></body></html>`, { headers: { ...secured, 'content-type': 'text/html; charset=utf-8' } });
}
