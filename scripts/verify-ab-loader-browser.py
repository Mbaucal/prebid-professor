"""Generic A/B loader (MBA-416 P1) in Chromium with a real Prebid.js, real SRI and real CORS.

python scripts/verify-ab-loader-browser.py <fixtures>
Run scripts/prepare-ab-loader-browser.mjs <fixtures> first. A is a 3.21.2 package and B a
3.23.0 package with bid cache on, both generated through the TEST workspace Generate path
for the synthetic, non-Tanjug bid cache site with one Prebid.js file; composeAbBundle built
the publisher-ab-v1 bundles (ab: B 50%, aa: A/A, b0, b100). Every bundle is served from its
ZIP after each file is checked against its record.

Two real HTTP servers on 127.0.0.1, each on its own ephemeral port and so its own origin,
answer after a fixed added latency: one serves the page, the other the bundle with the
headers of its _headers file (Access-Control-Allow-Origin removed in one case). The arm is a
cross-origin <script integrity crossorigin=anonymous>, so Chromium checks SRI and CORS for
real; route interception would bypass CORS, so it never touches either origin. Every other
request goes through a route: synthetic bids and Prebid currency rates are answered, all the
rest is aborted. The page loads the bundle's prebid.js and ads.js as the publisher would.
GPT is tests/runtime/mock-gpt-page-targeting.js (the synthetic GPT with page targeting), loaded before the
loader or, to prove the queued labels are kept, only after the arm has run. The CMP is a
local TCF stub that grants, denies or stays pending; the pubmatic and openx adapters are
synthetic. The page clock is virtual, so 30-second refreshes and bid cache reuse in B take
no real time. The loaders' one random draw is fixed per case. Two pages send a CSP that requires
Trusted Types (one allows the loader's policy, one allows none), and an old direct ads.js tag
after the loader runs with either script arriving first, delayed on purpose.

Every case checks that localStorage, sessionStorage, IndexedDB and cookies stay empty, that
no ad server or bidder is contacted and that GPT ran every queued command. The latency
section times the first GPT request over 30 loads of the loader page and 30 of version A
deployed directly (publisher-scripts-v1); it is recorded, never gated. Prints a JSON
summary, writes <fixtures>/browser-report.json and exits non-zero when any case fails.
"""
import hashlib
import io
import json
import math
import os
import sys
import threading
import time
import urllib.parse
import zipfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    sys.exit('Usage: python scripts/verify-ab-loader-browser.py <folder written by scripts/prepare-ab-loader-browser.mjs>')
fixtures = Path(sys.argv[1]).resolve()
manifest = json.loads((fixtures / 'manifest.json').read_text())


def sha256(data):
    return hashlib.sha256(data).hexdigest()


for name, expected in manifest['files'].items():
    assert sha256((fixtures / name).read_bytes()) == expected, 'Prepared file changed: ' + name


def read_bundle(name):
    """The bundle exactly as its ZIP holds it, each file checked against the test record."""
    record = json.loads((fixtures / 'bundles' / name / 'record.json').read_text())
    data = (fixtures / 'bundles' / name / 'bundle.zip').read_bytes()
    assert sha256(data) == record['bundle']['zipSha256'] == manifest['bundles'][name]['zipSha256'], ('ZIP checksum', name)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files = {info.filename: archive.read(info) for info in archive.infolist()}
    assert sorted(files) == [entry['path'] for entry in record['bundle']['files']], ('bundle file list', name, sorted(files))
    for entry in record['bundle']['files']:
        assert sha256(files[entry['path']]) == entry['sha256'] and len(files[entry['path']]) == entry['bytes'], ('bundle file', name, entry['path'])
    for side, arm in record['arms'].items():
        version = {'3.21.2': 'A', '3.23.0': 'B'}[arm['runtimeVersion']]
        assert sha256(files[arm['path']]) == arm['sha256'] == manifest['versions'][version]['adsMinSha256'], ('arm bytes', name, side)
    assert record['id'] in files['ads.js'].decode() and record['testId'] in files['ads.js'].decode(), ('loader config', name)
    return record, files


BUNDLES = {name: read_bundle(name) for name in manifest['bundles']}
assert len([path for path in BUNDLES['aa'][1] if path.startswith('r/')]) == 1, 'A/A ships one arm file'
assert 'prebid.js' in BUNDLES['ab'][1] and BUNDLES['ab'][1]['prebid.js'] == (fixtures / 'direct/prebid.js').read_bytes()
HEADER_LINES = BUNDLES['ab'][1]['_headers'].decode().splitlines()
assert HEADER_LINES[0] == '/*' and all(line.startswith('  ') and ':' in line for line in HEADER_LINES[1:]), HEADER_LINES
# Pages applies the /* rule of _headers to every file of the deployment.
PAGES_RULES = [tuple(part.strip() for part in line.split(':', 1)) for line in HEADER_LINES[1:]]
assert ('Access-Control-Allow-Origin', '*') in PAGES_RULES and ('Cache-Control', 'no-store') in PAGES_RULES, PAGES_RULES
EXTRA = {'/%s/%s' % (folder, path.relative_to(fixtures / folder).as_posix()): path.read_bytes()
         for folder in ('direct', 'pilot') for path in sorted((fixtures / folder).rglob('*')) if path.is_file() and path.name != '_headers'}
A_ID, B_ID = manifest['versions']['A']['release'], manifest['versions']['B']['release']
ARM = {'A': '/r/%s/ads.js' % A_ID, 'B': '/r/%s/ads.js' % B_ID}
LATENCY_MS = 40
LOADS = 30


class Origin:
    """One real loopback HTTP origin on an ephemeral port; every response waits `delay` seconds,
    and a path in `slow` that many seconds more, which fixes the order of two racing scripts."""

    def __init__(self):
        self.files, self.headers, self.delay, self.slow, self.log = {}, [], 0.0, {}, []
        origin = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                path = urllib.parse.urlsplit(self.path).path
                time.sleep(origin.delay + origin.slow.get(path, 0))
                body = origin.files.get(path)
                origin.log.append({'path': path, 'status': 404 if body is None else 200})
                self.send_response(404 if body is None else 200)
                kind = 'application/javascript; charset=utf-8' if path.endswith('.js') else 'text/html; charset=utf-8'
                body = body if body is not None else b'Not found'
                for key, value in [('Content-Type', kind), ('Content-Length', str(len(body)))] + origin.headers:
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.url = 'http://127.0.0.1:%d' % self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


site, cdn = Origin(), Origin()
assert site.url != cdn.url
mock = (root / 'tests/runtime/mock-gpt-page-targeting.js').read_text()
# Keep synthetic GPT only: Prebid is the real file and the CMP is the stub below.
start, end = mock.index('  window.pbjs = {'), mock.index('  window.__testAds =')
GPT = mock[:start] + mock[end:]
NOW = datetime(2026, 11, 15, 12, tzinfo=timezone.utc)
BID = 'https://bids.example.invalid/__synthetic-bid'
TC_STRING = 'synthetic-ab-tc-string'
SLOTS = ('<div id="Billboard" class="wrapperAd" style="min-height:250px"></div><div id="P1" class="wrapperAd" style="min-height:250px"></div>'
         '<main style="height:2000px"></main>')
INIT = r'''
(() => {
  // Bid requests still in flight; the virtual clock only moves when there are none.
  window.__inflight = 0;
  const fetch = window.fetch.bind(window);
  window.fetch = (...args) => { window.__inflight++; return fetch(...args).finally(() => { window.__inflight--; }); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    window.__inflight++; this.addEventListener('loadend', () => { window.__inflight--; }, {once: true});
    return send.apply(this, args);
  };
  // The loaders draw one Uint32 per pageview; fix it, or take randomness away. Prebid's own draws are untouched.
  const draw = %DRAW%, real = crypto.getRandomValues.bind(crypto);
  window.__draws = 0;
  if (draw !== null) crypto.getRandomValues = array => {
    if (!(array instanceof Uint32Array && array.length === 1)) return real(array);
    window.__draws++;
    if (draw === 'none') throw new Error('No randomness on this synthetic page');
    array[0] = draw; return array;
  };
  const cmp = %CMP%, flags = value => Object.fromEntries(Array.from({length: 1000}, (_, i) => [i + 1, value]));
  const decision = cmp === 'pending' ? {gdprApplies: true, listenerId: 1, eventStatus: 'cmpuishown', cmpStatus: 'loaded'}
    : {gdprApplies: true, tcString: '%TC%' + (cmp === 'denied' ? '-denied' : ''), listenerId: 1,
      eventStatus: cmp === 'denied' ? 'useractioncomplete' : 'tcloaded', cmpStatus: 'loaded',
      purpose: {consents: flags(cmp === 'granted'), legitimateInterests: flags(cmp === 'granted')},
      vendor: {consents: flags(cmp === 'granted'), legitimateInterests: flags(cmp === 'granted')},
      specialFeatureOptins: flags(cmp === 'granted'), publisher: {restrictions: {}}};
  window.__tcfapi = (command, version, callback) => {
    if (command === 'addEventListener' || command === 'getTCData') callback(decision, true);
    else if (command === 'ping') callback({cmpLoaded: true, gdprApplies: true}, true);
    else callback(true);
  };
  // Bids per bidder and auction, as in scripts/verify-bidcache323-browser.py.
  const script = %SCRIPT%, rounds = new Map();
  window.pbjs = {que: [() => {
    for (const name of ['pubmatic', 'openx']) window.pbjs.registerBidAdapter(null, name, {
      code: name, supportedMediaTypes: ['banner'], isBidRequestValid: () => true,
      buildRequests(bids) {
        return {method: 'GET', url: '%BID%', options: {withCredentials: false}, data: {payload: JSON.stringify(bids.flatMap(bid => {
          const round = (rounds.get(name + ':' + bid.adUnitCode) || 0) + 1;
          rounds.set(name + ':' + bid.adUnitCode, round);
          const size = bid.mediaTypes.banner.sizes.find(item => Array.isArray(item) && item[0] > 1);
          return (script[name][round - 1] || []).map(cpm => ({requestId: bid.bidId, ttl: 120, width: size[0], height: size[1], round, cpm}));
        }))}};
      },
      interpretResponse: response => response.body.bids,
    });
  }]};
})();
'''.replace('%TC%', TC_STRING).replace('%BID%', BID)
# pubmatic: 10 and 4, then 1, then 2, then 12. openx: 0.5 in every auction. With bid cache (B)
# the second request of each position sends the unsent earlier 4 instead of the fresh 1.
BIDS = {'pubmatic': [[10, 4], [1], [2], [12]], 'openx': [[0.5], [0.5], [0.5], [0.5]]}
SENT = {'3.21.2': ['10.00', '1.00', '2.00', '12.00'], '3.23.0': ['10.00', '4.00', '2.00', '12.00']}
PROFILE = {'3.21.2': 'tessera-3.21.2', '3.23.0': 'tessera-3.23.0'}
COLLECT = '''async () => {
  const ads = window.__testAds, service = ads && window.googletag.pubads();
  return {
    loader: window.__tesseraAbLoader ? window.__tesseraAbLoader.snapshot() : null,
    adVariant: window.AdVariant && typeof window.AdVariant.snapshot === 'function' ? window.AdVariant.snapshot() : null,
    pilot: window.__adVariantDelivery ? window.__adVariantDelivery.snapshot() : null,
    owner: window.__tesseraExperimentOwner === undefined ? null : window.__tesseraExperimentOwner,
    started: !!window.__TESSERA_RUNTIME_STARTED, profile: window.ADOPS_GENERATOR_PROFILE || null,
    bidCache: window.__tesseraBidCache ? window.__tesseraBidCache.snapshot() : null,
    gpt: ads ? {requests: ads.observations.requests, queued: ads.observations.queuedCommands, errors: ads.observations.commandErrors,
      page: Object.fromEntries(service.getTargetingKeys().map(key => [key, service.getTargeting(key)]))} : null,
    arms: [...document.scripts].filter(s => s.src.includes('/r/')).map(s => ({src: s.src, integrity: s.integrity, crossOrigin: s.crossOrigin, nonce: s.nonce})),
    prebid: window.pbjs && window.pbjs.version || null, draws: window.__draws, unnonced: !!window.__unnoncedRan,
    storage: {local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
      indexedDB: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map(db => db.name) : []},
  };
}'''
# The synthetic GPT renders its test creative through iframe srcdoc, so a page that requires Trusted
# Types needs a policy for that HTML. This default policy has no createScriptURL: a string script
# URL is still refused, and the loader must bring its own policy for the arm.
TT_HTML_ONLY = "trustedTypes.createPolicy('default', {createHTML: html => html});\n"
SETTLED = '''() => {
  const s = window.__tesseraAbLoader && window.__tesseraAbLoader.snapshot(), p = window.__adVariantDelivery && window.__adVariantDelivery.snapshot();
  return (!s || s.armStatus !== 'loading') && (!p || ['loaded', 'error'].includes(p.status));
}'''


def tags(*names, nonce=None):
    attr = ' nonce="%s"' % nonce if nonce else ''
    known = {'prebid': '<script%s src="%s/prebid.js"></script>', 'loader': '<script%s defer src="%s/ads.js"></script>',
             'direct': '<script%s defer src="%s/direct/ads.js"></script>', 'pilot': '<script%s defer src="%s/pilot/ads.js"></script>',
             'direct-prebid': '<script%s src="%s/direct/prebid.js"></script>'}
    return [known[name] % (attr, cdn.url) for name in names]


def html(head):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            + ''.join(head) + '</head><body style="margin:0">' + SLOTS + '</body></html>').encode()


def serve(bundle, acao=True, missing=(), tamper=(), slow=None):
    files = {'/' + path: data for path, data in BUNDLES[bundle][1].items() if path != '_headers'}
    files.update(EXTRA)
    for path in missing:
        del files[path]
    for path in tamper:
        # One changed byte: the integrity check must refuse the file.
        data = bytearray(files[path])
        data[-1] = 0x20 if data[-1] != 0x20 else 0x0a
        files[path] = bytes(data)
    cdn.files, cdn.slow = files, dict(slow or {})
    cdn.headers = [rule for rule in PAGES_RULES if acao or rule[0].lower() != 'access-control-allow-origin']
    cdn.log = []


def settle(page):
    for _ in range(600):
        if page.evaluate('window.__inflight') == 0:
            return
        page.wait_for_timeout(5)
    raise AssertionError('bid requests did not settle')


def advance(page, ms, step=100):
    for _ in range(ms // step):
        page.clock.run_for(step)
        settle(page)


def wait_until(page, expression, seconds=15):
    for _ in range(seconds * 100):
        if page.evaluate(expression):
            return
        page.wait_for_timeout(10)
    raise AssertionError('timed out waiting for ' + expression[:80])


def open_page(browser, width, head, page_headers):
    """A fresh context and page for one load; requests to the two loopback origins are never intercepted."""
    context = browser.new_context(viewport={'width': width, 'height': 900 if width > 600 else 844}, service_workers='block')
    page = context.new_page()
    errors, outbound, answered = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)

    def route(request):
        url = request.request.url
        if url.startswith(BID + '?'):
            rows = json.loads(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['payload'][0])
            answered.extend(rows)
            bids = [{**row, 'mediaType': 'banner', 'creativeId': 'synthetic', 'currency': 'EUR', 'netRevenue': True,
                     'ad': '<div>Synthetic A/B test</div>', 'meta': {'advertiserDomains': ['example.invalid']}} for row in rows]
            request.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps({'bids': bids}))
        elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
            request.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                            body=json.dumps({'conversions': {'EUR': {'EUR': 1, 'USD': 1}, 'USD': {'USD': 1, 'EUR': 1}}}))
        else:
            outbound.append(urllib.parse.urlsplit(url).hostname)
            request.abort()
    context.route(lambda url: not url.startswith((site.url + '/', cdn.url + '/')), route)
    path = '/page-%d' % len(site.log)
    site.files = {path: html(head)}
    site.headers = [('Cache-Control', 'no-store')] + page_headers
    return context, page, path, errors, outbound, answered


def run(browser, case, width):
    serve(case['bundle'], acao=case.get('acao', True), missing=case.get('missing', ()), tamper=case.get('tamper', ()), slow=case.get('slow'))
    site.delay = cdn.delay = 0
    context, page, path, errors, outbound, answered = open_page(browser, width, case['head'], case.get('pageHeaders', []))
    try:
        draw = case.get('draw', 0)
        init = (INIT.replace('%DRAW%', json.dumps(draw)).replace('%CMP%', json.dumps(case.get('cmp', 'granted')))
                .replace('%SCRIPT%', json.dumps(BIDS)))
        page.clock.install(time=NOW)
        page.clock.pause_at(NOW + timedelta(seconds=1))
        page.add_init_script((TT_HTML_ONLY if case.get('trustedHtml') else '') + init + ('\n' + GPT if case.get('gpt', 'early') == 'early' else ''))
        page.goto(site.url + path + case.get('query', ''))
        wait_until(page, SETTLED)
        if case.get('gpt') == 'late':
            # GPT arrives after the loader and the arm: it must run the commands they queued.
            assert page.evaluate('Array.isArray(window.googletag && window.googletag.cmd) && !window.__testAds'), 'GPT must load last'
            page.add_script_tag(content=GPT)
        advance(page, 2000)
        if case.get('refresh'):
            for _ in range(3):
                advance(page, 36000)
        elif case.get('wait'):
            advance(page, case['wait'], 1000)
        state = page.evaluate(COLLECT)
        state['cookies'] = context.cookies()
    finally:
        context.close()
    return {'state': state, 'errors': errors, 'outbound': outbound, 'answered': len(answered), 'cdn': list(cdn.log)}


# Helpers for the expectations below.
def requests(ev):
    return ev['state']['gpt']['requests'] if ev['state']['gpt'] else []


def arm_log(ev):
    return [(entry['path'], entry['status']) for entry in ev['cdn'] if entry['path'].startswith(('/r/', '/pilot/releases/'))]


def labelled(ev, variant, test_id):
    found = requests(ev)
    assert found, 'GPT requests expected'
    for request in found:
        assert request['page'].get('Variant') == [variant] and request['page'].get('TestId') == [test_id], ('labels on every GPT request', request['id'], request['page'])


def unlabelled(ev):
    for request in requests(ev):
        assert 'Variant' not in request['page'] and 'TestId' not in request['page'], ('no labels', request['page'])


def sent(ev, code):
    return [(request['slot'].get('hb_pb') or [None])[0] for request in requests(ev) if request['id'] == code]


def ran(ev, version, refresh):
    """The arm that actually ran: its generator profile, its bid cache state and, with refreshes, its GAM sequence."""
    state = ev['state']
    assert state['started'] and state['profile'] == PROFILE[version], ('runtime', state['profile'])
    assert (state['bidCache'] is not None) == (version == '3.23.0'), ('bid cache diagnostics only in B', state['bidCache'])
    for code in ('Billboard', 'P1'):
        values = sent(ev, code)
        if refresh:
            assert len(values) >= 4 and values[:4] == SENT[version], ('first request and three refreshes', code, values)
        else:
            assert values and values[0] == '10.00', ('first GPT request', code, values)
    if refresh and version == '3.23.0':
        assert state['bidCache']['counters']['cachedWins'] == 2, state['bidCache']['counters']


def loader(ev, **expected):
    snapshot = ev['state']['loader']
    assert snapshot, 'loader snapshot'
    for key, value in expected.items():
        assert snapshot[key] == value, (key, snapshot[key], value)
    return snapshot


def arm_element(ev, record, side):
    arm = record['arms'][side]
    element = ev['state']['arms'][-1]
    assert element['src'] == cdn.url + '/' + arm['path'] and element['integrity'] == arm['integrity'] and element['crossOrigin'] == 'anonymous', element


def assigned(variant, side=None, version=None, gpt='early'):
    """A normal pageview: label `variant`, load arm `side`, exactly one arm request."""
    side, version = side or variant, version or ('3.21.2' if (side or variant) == 'A' else '3.23.0')

    def check(ev, record, case):
        loader(ev, status='assigned', variant=variant, armStatus='loaded', fallback=False, scriptRelease=record['arms'][side]['release'],
               testId=record['testId'], release=record['id'], deliveryMode='ab', blockedDuplicateLoaders=0, keyConflict=False, runtimeStarted=True)
        assert ev['state']['adVariant'] == ev['state']['loader'], 'AdVariant shows the loader snapshot'
        assert ev['state']['owner'] == 'tessera-ab-loader-' + record['loader']['version'] and ev['state']['draws'] == 1, (ev['state']['owner'], ev['state']['draws'])
        assert arm_log(ev) == [('/' + record['arms'][side]['path'], 200)], arm_log(ev)
        arm_element(ev, record, side)
        labelled(ev, variant, record['testId'])
        ran(ev, version, case.get('refresh'))
        if gpt == 'late':
            assert ev['state']['gpt']['queued'] > 1, ('GPT ran the labels and the arm commands queued before it', ev['state']['gpt']['queued'])
    return check


def fallback(variant, failed_side, how):
    def check(ev, record, case):
        loader(ev, status='fallback-control', variant=variant, armStatus='loaded', fallback=True, scriptRelease=record['arms']['A']['release'])
        assert arm_log(ev) == [(ARM[failed_side], 404 if how == '404' else 200), (ARM['A'], 200)], ('exactly one control retry', arm_log(ev))
        assert len(ev['state']['arms']) == 2, ev['state']['arms']
        labelled(ev, variant, record['testId'])
        ran(ev, '3.21.2', False)
    return check


def no_arm(attempts):
    def check(ev, record, case):
        loader(ev, status='fallback-control', variant='A', armStatus='error', fallback=True, runtimeStarted=False)
        assert arm_log(ev) == attempts, ('the control retry happens once and is never repeated', arm_log(ev))
        assert not ev['state']['started'] and not requests(ev), 'no runtime, no GPT request'
        assert ev['state']['gpt']['page'] == {'Variant': ['A'], 'TestId': [record['testId']]}, ev['state']['gpt']['page']
    return check


def conflict_existing(ev, record, case):
    loader(ev, status='existing-runtime-conflict', variant=None, scriptRelease=None, armStatus=None, runtimeStarted=True)
    assert ev['state']['adVariant']['status'] == 'existing-runtime-conflict' and ev['state']['owner'] is None, ev['state']['adVariant']
    assert arm_log(ev) == [] and ev['state']['draws'] == 0, (arm_log(ev), ev['state']['draws'])
    unlabelled(ev)
    ran(ev, '3.21.2', False)


def conflict_late(ev, record, case):
    """An old direct tag after the loader started its runtime before the arm arrived: the page
    leaves the test, so no GAM request carries the labels and Debug shows the conflict."""
    state = ev['state']
    loader(ev, status='existing-runtime-conflict', variant=None, scriptRelease=record['arms']['B']['release'], fallback=False, runtimeStarted=True)
    assert state['adVariant'] == state['loader'] and state['owner'] == 'tessera-ab-loader-' + record['loader']['version'], (state['adVariant'], state['owner'])
    assert state['draws'] == 1 and arm_log(ev) == [(ARM['B'], 200)], ('the arm is requested once and never retried', arm_log(ev))
    unlabelled(ev)
    assert 'Variant' not in state['gpt']['page'] and 'TestId' not in state['gpt']['page'], ('labels removed from the page', state['gpt']['page'])
    ran(ev, '3.21.2', False)


def direct_late(ev, record, case):
    """The same tags, but the arm runs first: the old tag's start guard returns and the test is unaffected."""
    assigned('B')(ev, record, case)
    assert ('/direct/ads.js', 200) in [(entry['path'], entry['status']) for entry in ev['cdn']], 'the old tag was loaded too'


def duplicate(ev, record, case):
    loader(ev, status='assigned', variant='A', blockedDuplicateLoaders=1, armStatus='loaded')
    assert [entry['path'] for entry in ev['cdn']].count('/ads.js') == 2, 'both loader tags were fetched'
    assert arm_log(ev) == [(ARM['A'], 200)] and len(ev['state']['arms']) == 1 and ev['state']['draws'] == 1, arm_log(ev)
    labelled(ev, 'A', record['testId'])
    ran(ev, '3.21.2', False)


def pilot_first(ev, record, case):
    state = ev['state']
    loader(ev, status='existing-runtime-conflict', variant=None, armStatus=None)
    assert state['adVariant']['release'] == 'tanjug-aa-1.0.0' and state['owner'] is None, 'the pilot keeps its own AdVariant'
    assert state['pilot']['status'] == 'loaded' and state['pilot']['runtimeEntries'] == 1, state['pilot']
    assert arm_log(ev) == [('/pilot/releases/aa/runtime.js', 200)], arm_log(ev)
    unlabelled(ev)
    for request in requests(ev):
        assert request['slot'].get('Variant') == ['A'], ('pilot slot label', request['slot'])
    ran(ev, '3.21.2', False)


def pilot_second(ev, record, case):
    state = ev['state']
    assigned('A')(ev, record, case)
    assert state['pilot']['status'] == 'error' and state['pilot']['error'] == 'existing-runtime-conflict', state['pilot']
    assert state['adVariant']['deliveryMode'] == 'ab', 'the pilot does not replace AdVariant'


def key_conflict(ev, record, case):
    loader(ev, status='assigned', variant='A', keyConflict=True)
    for request in requests(ev):
        assert sorted(request['page'].get('Variant', [])) == ['A', 'X'] and request['page'].get('TestId') == [record['testId']], request['page']
    ran(ev, '3.21.2', False)


def forced(ev, record, case):
    loader(ev, status='forced', variant='B', armStatus='loaded', scriptRelease=record['arms']['B']['release'])
    assert ev['state']['draws'] == 0, 'forced QA draws nothing'
    unlabelled(ev)
    ran(ev, '3.23.0', False)


def random_unavailable(ev, record, case):
    loader(ev, status='random-unavailable', variant=None, armStatus='loaded', scriptRelease=record['arms']['A']['release'])
    unlabelled(ev)
    ran(ev, '3.21.2', False)


def pending(ev, record, case):
    loader(ev, status='assigned', variant='B', armStatus='loaded', runtimeStarted=True)
    assert not requests(ev) and ev['answered'] == 0, ('a pending CMP gives no GPT and no bid request', len(requests(ev)), ev['answered'])
    page = ev['state']['gpt']['page']
    assert page.get('Variant') == ['B'] and page.get('TestId') == [record['testId']], ('labels are set all the same', page)


def denied(ev, record, case):
    loader(ev, status='assigned', variant='A', armStatus='loaded')
    labelled(ev, 'A', record['testId'])
    assert ev['answered'] == 0, ('Prebid sends no bid request without consent', ev['answered'])


def nonce(ev, record, case):
    assigned('A')(ev, record, case)
    assert ev['state']['arms'][0]['nonce'] == 'ab-nonce-1', ev['state']['arms']
    assert not ev['state']['unnonced'], 'the policy is enforced: a script without the nonce did not run'


def trusted_types(ev, record, case):
    assigned('A')(ev, record, case)
    assert ev['state']['arms'][0]['nonce'] == 'ab-tt', ev['state']['arms']


def trusted_types_blocked(ev, record, case):
    loader(ev, status='fallback-control', variant='A', armStatus='trusted-types-blocked', fallback=True, runtimeStarted=False)
    assert arm_log(ev) == [] and ev['state']['arms'] == [], ('no arm can be inserted', arm_log(ev), ev['state']['arms'])
    assert not ev['state']['started'] and not requests(ev), 'no runtime, no GPT request'
    assert ev['state']['gpt']['page'] == {'Variant': ['A'], 'TestId': [record['testId']]}, ev['state']['gpt']['page']


SRI_ERROR, CORS_ERROR = "Failed to find a valid digest in the 'integrity' attribute", "has been blocked by CORS policy"
CSP_ERROR = "violates the following Content Security Policy directive"
TT_SCRIPT_URL, TT_POLICY = "requires 'TrustedScriptURL' assignment", "Creating a TrustedTypePolicy named 'tessera-ab-loader' violates"
TT_CSP = "script-src 'nonce-ab-tt' 'strict-dynamic'; object-src 'none'; base-uri 'none'; require-trusted-types-for 'script'"
CASES = [
    {'name': 'A', 'bundle': 'ab', 'draw': 0, 'head': tags('prebid', 'loader'), 'refresh': True, 'widths': [1280, 390], 'check': assigned('A')},
    {'name': 'B', 'bundle': 'ab', 'draw': 4294967295, 'gpt': 'late', 'head': tags('prebid', 'loader'), 'refresh': True, 'widths': [1280, 390], 'check': assigned('B', gpt='late')},
    {'name': 'A/A', 'bundle': 'aa', 'draw': 4294967295, 'gpt': 'late', 'head': tags('prebid', 'loader'), 'refresh': True, 'check': assigned('B', side='A', version='3.21.2', gpt='late')},
    {'name': 'b=0', 'bundle': 'b0', 'draw': 4294967295, 'head': tags('prebid', 'loader'), 'refresh': True, 'check': assigned('A')},
    {'name': 'b=100', 'bundle': 'b100', 'draw': 0, 'gpt': 'late', 'head': tags('prebid', 'loader'), 'refresh': True, 'check': assigned('B', gpt='late')},
    {'name': 'duplicate loader tag', 'bundle': 'ab', 'head': tags('prebid', 'loader', 'loader'), 'check': duplicate},
    {'name': 'existing runtime on the page', 'bundle': 'ab', 'head': tags('prebid', 'direct', 'loader'), 'check': conflict_existing},
    # The old tag after the loader: a slow arm makes the old runtime start first, a slow old tag the arm.
    {'name': 'old direct tag after the loader', 'bundle': 'ab', 'draw': 4294967295, 'slow': {ARM['B']: 0.5}, 'head': tags('prebid', 'loader', 'direct'), 'check': conflict_late},
    {'name': 'old direct tag after the loader, GPT late', 'bundle': 'ab', 'draw': 4294967295, 'gpt': 'late', 'slow': {ARM['B']: 0.5}, 'head': tags('prebid', 'loader', 'direct'), 'check': conflict_late},
    {'name': 'old direct tag after the loader, arm first', 'bundle': 'ab', 'draw': 4294967295, 'slow': {'/direct/ads.js': 0.5}, 'head': tags('prebid', 'loader', 'direct'), 'check': direct_late},
    {'name': 'pilot loader first', 'bundle': 'ab', 'head': tags('prebid', 'pilot', 'loader'), 'check': pilot_first},
    {'name': 'pilot loader second', 'bundle': 'ab', 'head': tags('prebid', 'loader', 'pilot'), 'check': pilot_second},
    {'name': 'adsKeywords.Variant conflict', 'bundle': 'ab', 'head': ["<script>window.adsKeywords={Variant:'X',section:'news'};</script>"] + tags('prebid', 'loader'), 'check': key_conflict},
    {'name': 'arm 404, control retry', 'bundle': 'ab', 'draw': 4294967295, 'missing': [ARM['B']], 'head': tags('prebid', 'loader'), 'check': fallback('B', 'B', '404')},
    {'name': 'arm SRI mismatch, control retry', 'bundle': 'ab', 'draw': 4294967295, 'tamper': [ARM['B']], 'head': tags('prebid', 'loader'), 'allow': [SRI_ERROR], 'require': [SRI_ERROR], 'check': fallback('B', 'B', 'sri')},
    {'name': 'control arm 404 too', 'bundle': 'ab', 'missing': [ARM['A']], 'head': tags('prebid', 'loader'), 'check': no_arm([(ARM['A'], 404), (ARM['A'], 404)])},
    {'name': 'no Access-Control-Allow-Origin', 'bundle': 'ab', 'acao': False, 'head': tags('prebid', 'loader'), 'allow': [CORS_ERROR], 'require': [CORS_ERROR], 'check': no_arm([(ARM['A'], 200), (ARM['A'], 200)])},
    {'name': 'forced QA ?tessera_ab=B at b=0', 'bundle': 'b0', 'query': '?tessera_ab=B', 'head': tags('prebid', 'loader'), 'check': forced},
    {'name': 'no randomness', 'bundle': 'ab', 'draw': 'none', 'head': tags('prebid', 'loader'), 'check': random_unavailable},
    {'name': 'CMP pending', 'bundle': 'ab', 'draw': 4294967295, 'cmp': 'pending', 'head': tags('prebid', 'loader'), 'wait': 60000, 'check': pending},
    {'name': 'CMP denied', 'bundle': 'ab', 'cmp': 'denied', 'head': tags('prebid', 'loader'), 'check': denied},
    {'name': 'CSP nonce', 'bundle': 'ab', 'head': ['<script>window.__unnoncedRan=true</script>'] + tags('prebid', 'loader', nonce='ab-nonce-1'), 'check': nonce,
     'allow': [CSP_ERROR], 'require': [CSP_ERROR],
     'pageHeaders': [('Content-Security-Policy', "script-src 'nonce-ab-nonce-1'; object-src 'none'; base-uri 'none'")]},
    {'name': 'Trusted Types required', 'bundle': 'ab', 'head': tags('prebid', 'loader', nonce='ab-tt'), 'check': trusted_types, 'trustedHtml': True,
     'pageHeaders': [('Content-Security-Policy', TT_CSP)]},
    {'name': 'Trusted Types with no policy allowed', 'bundle': 'ab', 'head': tags('prebid', 'loader', nonce='ab-tt'), 'check': trusted_types_blocked,
     'allow': [TT_SCRIPT_URL, TT_POLICY], 'require': [TT_SCRIPT_URL, TT_POLICY], 'pageHeaders': [('Content-Security-Policy', TT_CSP + "; trusted-types 'none'")]},
]


def common(ev, case):
    state = ev['state']
    allowed = ['Failed to load resource'] + case.get('allow', [])
    unexpected = [error for error in ev['errors'] if not any(text in error for text in allowed)]
    assert not unexpected, ('page and console errors', unexpected)
    for text in case.get('require', []):
        assert any(text in error for error in ev['errors']), ('Chromium must report', text, ev['errors'])
    assert not [host for host in ev['outbound'] if host and host.endswith(('doubleclick.net', 'googlesyndication.com', 'googletagservices.com', 'pubmatic.com', 'openx.net'))], ev['outbound']
    assert state['prebid'] == 'v' + manifest['prebid']['version'], state['prebid']
    storage = state['storage']
    assert storage == {'local': 0, 'session': 0, 'cookie': '', 'indexedDB': []} and state['cookies'] == [], ('storage and cookies stay empty', storage, state['cookies'])
    assert state['gpt'] and state['gpt']['errors'] == [], ('GPT command errors', state['gpt'])


def check(case, ev):
    record = BUNDLES[case['bundle']][0]
    common(ev, case)
    case['check'](ev, record, case)
    state = ev['state']
    return {'loader': state['loader'], 'armRequests': arm_log(ev), 'gptRequests': len(requests(ev)), 'queuedBeforeGpt': state['gpt']['queued'],
            'firstRequestPage': requests(ev)[0]['page'] if requests(ev) else None,
            'sent': {code: sent(ev, code)[:4] for code in ('Billboard', 'P1')}, 'profile': state['profile'],
            'cachedWins': state['bidCache']['counters']['cachedWins'] if state['bidCache'] else None,
            'syntheticBidRows': ev['answered'], 'blockedHosts': sorted({host for host in ev['outbound'] if host})}


def first_request_ms(browser, head, draw):
    """Real time from navigation start to the first GPT request, with no virtual clock."""
    context, page, path, errors, outbound, answered = open_page(browser, 1280, head, [])
    try:
        page.add_init_script(INIT.replace('%DRAW%', json.dumps(draw)).replace('%CMP%', json.dumps('granted')).replace('%SCRIPT%', json.dumps(BIDS)) + '\n' + GPT)
        page.goto(site.url + path)
        wait_until(page, 'window.__testAds && window.__testAds.observations.requests.length > 0')
        state = page.evaluate('() => ({at: window.__testAds.observations.requests[0].at, origin: performance.timeOrigin, profile: window.ADOPS_GENERATOR_PROFILE})')
    finally:
        context.close()
    unexpected = [error for error in errors if 'Failed to load resource' not in error]
    assert not unexpected and state['profile'] == 'tessera-3.21.2', (unexpected, state)
    return state['at'] - state['origin']


def percentile(values, share):
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(share * len(ordered)) - 1)], 1)


def latency(browser):
    serve('ab')
    site.delay = cdn.delay = LATENCY_MS / 1000
    samples = {'loader': [], 'direct': []}
    try:
        for _ in range(LOADS):
            # Alternate the two pages so drift on a shared machine affects both alike.
            samples['loader'].append(first_request_ms(browser, tags('prebid', 'loader'), 0))
            samples['direct'].append(first_request_ms(browser, tags('direct-prebid', 'direct'), 0))
    finally:
        site.delay = cdn.delay = 0
    summary = {name: {'p50': percentile(values, 0.5), 'p95': percentile(values, 0.95), 'samplesMs': [round(v, 1) for v in values]} for name, values in samples.items()}
    return {'addedLatencyMsPerResponse': LATENCY_MS, 'loadsEach': LOADS, 'arm': 'A (3.21.2)', 'gated': False, **summary,
            'differenceP50': round(summary['loader']['p50'] - summary['direct']['p50'], 1), 'differenceP95': round(summary['loader']['p95'] - summary['direct']['p95'], 1)}


results, timing = [], None
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
    try:
        for case in CASES:
            for width in case.get('widths', [1280]):
                try:
                    evidence = check(case, run(browser, case, width))
                    results.append({'case': case['name'], 'width': width, 'passed': True, **evidence})
                    print('PASS %s %dpx %s' % (case['name'], width, json.dumps({k: evidence[k] for k in ('armRequests', 'gptRequests', 'sent')})), flush=True)
                except Exception as error:
                    results.append({'case': case['name'], 'width': width, 'passed': False, 'error': repr(error)[:4000]})
                    print('FAIL %s %dpx %s' % (case['name'], width, repr(error)[:4000]), flush=True)
        try:
            timing = latency(browser)
            print('LATENCY %s' % json.dumps({k: v for k, v in timing.items() if k not in ('loader', 'direct')} | {k: {'p50': timing[k]['p50'], 'p95': timing[k]['p95']} for k in ('loader', 'direct')}), flush=True)
        except Exception as error:
            results.append({'case': 'latency', 'width': 1280, 'passed': False, 'error': repr(error)[:4000]})
            print('FAIL latency %s' % repr(error)[:4000], flush=True)
    finally:
        browser.close()
        site.server.shutdown()
        cdn.server.shutdown()
report = {'scope': 'Generic A/B loader %s in Chromium: bundles from composeAbBundle, A 3.21.2 and B 3.23.0 with bid cache, Prebid.js %s; '
                   'two loopback origins with real SRI and CORS; synthetic GPT, TCF and bidders; every other request aborted; virtual clock'
                   % (BUNDLES['ab'][0]['loader']['version'], manifest['prebid']['version']),
          'site': manifest['site'], 'versions': manifest['versions'], 'tests': {name: BUNDLES[name][0]['id'] for name in BUNDLES},
          'results': results, 'latency': timing, 'passed': sum(r['passed'] for r in results), 'failed': sum(not r['passed'] for r in results)}
(fixtures / 'browser-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failed': report['failed'],
                  'latency': timing and {k: timing[k] for k in ('addedLatencyMsPerResponse', 'loadsEach', 'differenceP50', 'differenceP95')} | {k: {'p50': timing[k]['p50'], 'p95': timing[k]['p95']} for k in ('loader', 'direct')}}), flush=True)
sys.exit(1 if report['failed'] else 0)
