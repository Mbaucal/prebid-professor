const TESSERA_LOGO_URL = '/tessera-logo.png?v=21';

function brandedCsp(value: string): string {
  if (!value || value.includes('img-src')) return value;
  return value.replace("default-src 'none';", "default-src 'none'; img-src 'self' data:;");
}

function faviconTag(): string {
  return '<link rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48" href="/favicon.ico?v=21" />';
}

export async function brandTesseraHtmlResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  html = html.replaceAll('Prebid Professor', 'Tessera');
  html = html.replace(
    '<div class="mark">PP</div>',
    `<div class="mark" aria-hidden="true" style="background:transparent;color:transparent;flex:0 0 46px"><img src="${TESSERA_LOGO_URL}" alt="" width="46" height="46" style="width:46px;height:46px;object-fit:contain;display:block" /></div>`,
  );

  const iconPattern = /<link\s+rel=["']icon["'][^>]*>/i;
  if (iconPattern.test(html)) html = html.replace(iconPattern, faviconTag());
  else html = html.replace('</head>', `  ${faviconTag()}\n</head>`);

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');
  const csp = headers.get('content-security-policy');
  if (csp) headers.set('content-security-policy', brandedCsp(csp));

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
