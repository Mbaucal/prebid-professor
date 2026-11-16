import {normalizeCountry, countryClientSource} from '../shared/geo-country.mjs';

/** Public, credential-free metadata; use the incoming edge request, never headers. */
export function countryResponse(request) {
  const url = new URL(request.url);
  const countryPath = '/geo/v1/country';
  const clientPath = '/geo/v1/client.js';
  if (url.pathname !== countryPath && url.pathname !== clientPath) return null;
  const headers = {
    'cache-control':'private, no-store, max-age=0',
    'cdn-cache-control':'no-store',
    'cloudflare-cdn-cache-control':'no-store',
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET, HEAD, OPTIONS',
    'x-content-type-options':'nosniff',
    'content-type':'application/json; charset=utf-8',
  };
  const fail = (error, status) => new Response(request.method === 'HEAD' ? null : JSON.stringify({error}), {status, headers});
  if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
    headers.allow = 'GET, HEAD, OPTIONS';
    return fail('Method not allowed.', 405);
  }
  if (url.search) return fail('Query parameters are not supported.', 400);
  if (request.method === 'OPTIONS') return new Response(null, {status:204, headers});
  if (url.pathname === clientPath) {
    headers['content-type'] = 'application/javascript; charset=utf-8';
    return new Response(request.method === 'HEAD' ? null : countryClientSource(url.origin + countryPath), {headers});
  }
  const country = normalizeCountry(request.cf?.country);
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({
    version:1, status:country ? 'known' : 'unknown', country, source:'cloudflare',
  }), {headers});
}
