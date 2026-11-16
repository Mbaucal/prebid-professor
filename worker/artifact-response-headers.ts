/** Ad examples may execute uploaded publisher code. Keep them outside the admin
 * origin's authority even when their bytes are served by the same Worker.
 * This changes delivery headers only; saved package hashes remain valid.
 */
export function artifactResponseHeaders(name: string, initial: HeadersInit): Headers {
  const headers = new Headers(initial);
  const mime = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (/\.html?$/i.test(name) || mime === 'text/html' || mime === 'application/xhtml+xml') {
    headers.set('content-security-policy', "sandbox allow-scripts allow-popups; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    // Do not allow a sandboxed document's same-host Referer to act as evidence
    // of a same-origin request in older API middleware.
    headers.set('referrer-policy', 'no-referrer');
    headers.set('cache-control', 'private, no-store');
    headers.set('x-content-type-options', 'nosniff');
  }
  return headers;
}
