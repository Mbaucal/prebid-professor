/** Test-only bootstrap. No application import, data access, migrations or cron.
 * Deploy this small shell first so actual Cloudflare bindings can be audited
 * before any application code is allowed to access the new test resources.
 */
const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
};
const STATUS = Object.freeze({
  service: 'tessera-test-bootstrap',
  build: 'bootstrap-v1',
  stage: 'bootstrap_only',
  applicationEnabled: false,
  isolationChecked: false,
  remoteWritesEnabled: false,
  publisherDeploymentEnabled: false,
  notice: 'This shell does not access the database or bucket. Audit the deployed bindings before enabling the test application.',
});
const HOME = 'Tessera — test okruženje\n\nPriprema testnog Workera je objavljena.\nAplikacija i snimanje podataka još nisu uključeni.\nOvaj ekran ne potvrđuje proveru baze ili skladišta.\n';

export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    const read = request.method === 'GET' || request.method === 'HEAD';
    let status = 200;
    let body;
    let type = 'application/json; charset=utf-8';
    if (!read) {
      status = 405;
      body = JSON.stringify({ error: 'Test application is not enabled. No operation was performed.' });
    } else if (pathname === '/') {
      body = HOME;
      type = 'text/plain; charset=utf-8';
    } else if (pathname === '/health') {
      body = JSON.stringify(STATUS);
    } else {
      status = 404;
      body = JSON.stringify({ error: 'Test application is not enabled.' });
    }
    const headers = { ...HEADERS, 'content-type': type };
    if (status === 405) headers.allow = 'GET, HEAD';
    return new Response(request.method === 'HEAD' ? null : body, { status, headers });
  },
};
