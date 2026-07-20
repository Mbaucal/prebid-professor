const TESSERA_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" style="width:100%;height:100%;display:block" aria-hidden="true"><rect width="600" height="600" rx="130" fill="#171b22"/><rect x="87" y="100" width="126" height="125" rx="25" fill="#e5e7eb"/><rect x="387" y="100" width="126" height="125" rx="25" fill="#9aa1b0"/><rect x="237" y="250" width="126" height="125" rx="25" fill="#7d8494"/><rect x="237" y="400" width="126" height="100" rx="25" fill="#565e70"/><rect x="238" y="86" width="126" height="126" rx="25" fill="#e58936" transform="rotate(12 301 149)"/></svg>`;

function brandedCsp(value: string): string {
  if (!value || value.includes('img-src')) return value;
  return value.replace("default-src 'none';", "default-src 'none'; img-src 'self' data:;");
}

export async function brandTesseraHtmlResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  html = html.replaceAll('Prebid Professor', 'Tessera');
  html = html.replace(
    '<div class="mark">PP</div>',
    `<div class="mark" aria-hidden="true" style="background:transparent;color:transparent;overflow:hidden">${TESSERA_LOGO}</div>`,
  );
  if (!html.includes('/tessera-logo.svg')) {
    html = html.replace('</head>', '  <link rel="icon" type="image/svg+xml" href="/tessera-logo.svg" />\n</head>');
  }

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
