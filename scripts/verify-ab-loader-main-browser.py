"""Current complete MAIN 3.25.1 A/B bundles in Chromium: native Prebid, synthetic demand.

Two real loopback origins enforce arm SRI/CORS/CSP. Every nonloopback request is
intercepted or aborted. No publisher, paid inventory, GAM data or live activation.
Run prepare-ab-loader-main-browser.mjs first; output comes from MAIN Generate/readPackage.
"""
import hashlib
import io
import json
import os
import sys
import threading
import time
import urllib.parse
import zipfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from importlib.metadata import version as package_version
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    sys.exit('Usage: python scripts/verify-ab-loader-main-browser.py <MAIN fixture directory>')
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
    assert record['loader'] == manifest['bundles'][name]['loader'] and record['loader']['version'] == '1.1.1', ('pending-arm loader pin', name)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files = {info.filename: archive.read(info) for info in archive.infolist()}
    assert sorted(files) == [entry['path'] for entry in record['bundle']['files']], ('bundle file list', name, sorted(files))
    for entry in record['bundle']['files']:
        assert sha256(files[entry['path']]) == entry['sha256'] and len(files[entry['path']]) == entry['bytes'], ('bundle file', name, entry['path'])
    assert sha256(files['ads.js']) == manifest['bundles'][name]['entrySha256'], ('loader entry bytes', name)
    for side, arm in record['arms'].items():
        version = next(side for side, value in manifest['versions'].items() if value['release'] == arm['release'])
        assert arm['runtimeVersion'] == '3.25.1'
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
         for folder in ('direct',) for path in sorted((fixtures / folder).rglob('*')) if path.is_file() and path.name != '_headers'}
A_ID, B_ID = manifest['versions']['A']['release'], manifest['versions']['B']['release']
ARM = {'A': '/r/%s/ads.js' % A_ID, 'B': '/r/%s/ads.js' % B_ID}



class Origin:
    """One real loopback HTTP origin on an ephemeral port; every response waits `delay` seconds,
    and a path in `slow` that many seconds more, which fixes the order of two racing scripts."""

    def __init__(self):
        self.files, self.headers, self.delay, self.slow, self.log = {}, [], 0.0, {}, []
        self.holds = {}
        origin = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                path = urllib.parse.urlsplit(self.path).path
                body = origin.files.get(path)
                origin.log.append({'path': path, 'status': 404 if body is None else 200})
                if path in origin.holds:
                    origin.holds[path].wait(timeout=30)
                time.sleep(origin.delay + origin.slow.get(path, 0))
                self.send_response(404 if body is None else 200)
                kind = 'application/javascript; charset=utf-8' if path.endswith('.js') else 'text/html; charset=utf-8'
                body = body if body is not None else b'Not found'
                for key, value in [('Content-Type', kind), ('Content-Length', str(len(body)))] + origin.headers:
                    self.send_header(key, value)
                self.end_headers()
                try: self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass

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
NOW = datetime(2026, 11, 19, 12, tzinfo=timezone.utc)
BID = 'https://bids.example.invalid/__synthetic-bid'
TC_STRING = 'synthetic-ab-tc-string'
SLOTS = ('<div id="Billboard" class="wrapperAd" style="min-height:250px"></div><div id="P1" class="wrapperAd" style="min-height:250px"></div>'
         '<main style="height:2000px"></main><div id="P2" class="wrapperAd lazyAd" style="min-height:250px"></div>')
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
  const nativeTimeout = window.setTimeout, nativeClear = window.clearTimeout;
  const loaderTimers = window.__loaderTimers = [];
  window.setTimeout = function(callback, delay, ...args) {
    if (delay !== 8000 || typeof callback !== 'function' || !String(new Error().stack).includes('%LOADER%:')) return nativeTimeout.call(this, callback, delay, ...args);
    const record = {id:null,active:true};
    const id = nativeTimeout.call(this, function(...values) { record.active=false; return callback.apply(this,values); }, delay, ...args);
    record.id=id;loaderTimers.push(record);return id;
  };
  window.clearTimeout = function(id) { for(const record of loaderTimers)if(record.id===id)record.active=false;return nativeClear.call(this,id); };
  if (draw !== null) crypto.getRandomValues = array => {
    if (!(array instanceof Uint32Array && array.length === 1) || document.currentScript?.src !== '%LOADER%' || window.__draws) return real(array);
    window.__draws++;
    if (draw === 'none') throw new Error('No randomness on this synthetic page');
    array[0] = draw; return array;
  };
  const cmp = %CMP%, flags = value => Object.fromEntries(Array.from({length: 1000}, (_, i) => [i + 1, value]));
  let decision = cmp === 'pending' ? {gdprApplies: true, listenerId: 1, eventStatus: 'cmpuishown', cmpStatus: 'loaded'}
    : {gdprApplies: true, tcString: '%TC%' + (cmp === 'denied' ? '-denied' : ''), listenerId: 1,
      eventStatus: cmp === 'denied' ? 'useractioncomplete' : 'tcloaded', cmpStatus: 'loaded',
      purpose: {consents: flags(cmp === 'granted'), legitimateInterests: flags(cmp === 'granted')},
      vendor: {consents: flags(cmp === 'granted'), legitimateInterests: flags(cmp === 'granted')},
      specialFeatureOptins: flags(cmp === 'granted'), publisher: {restrictions: {}}};
  const listeners = [];
  window.__fixtureGrantCmp = () => {
    decision = {gdprApplies:true,tcString:'%TC%',listenerId:1,eventStatus:'useractioncomplete',cmpStatus:'loaded',
      purpose:{consents:flags(true),legitimateInterests:flags(true)},vendor:{consents:flags(true),legitimateInterests:flags(true)},
      specialFeatureOptins:flags(true),publisher:{restrictions:{}}};
    for (const callback of listeners) callback(decision,true);
  };
  window.__tcfapi = (command, version, callback) => {
    if (command === 'addEventListener' || command === 'getTCData') { if(command==='addEventListener')listeners.push(callback); callback(decision, true); }
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
SENT = {'A': ['10.00', '1.00', '2.00', '12.00'], 'B': ['10.00', '4.00', '2.00', '12.00']}
COLLECT = '''async () => {
  const ads = window.__testAds, service = ads && window.googletag.pubads();
  return {
    loader: window.__tesseraAbLoader ? window.__tesseraAbLoader.snapshot() : null,
    adVariant: window.AdVariant && typeof window.AdVariant.snapshot === 'function' ? window.AdVariant.snapshot() : null,
    owner: window.__tesseraExperimentOwner === undefined ? null : window.__tesseraExperimentOwner,
    started: !!window.__TESSERA_RUNTIME_STARTED, profile: window.ADOPS_GENERATOR_PROFILE || null,
    bidCache: window.__tesseraBidCache ? window.__tesseraBidCache.snapshot() : null,
    gpt: ads ? {requests: ads.observations.requests, queued: ads.observations.queuedCommands, errors: ads.observations.commandErrors,
      privacy: ads.observations.privacy, configs: ads.observations.gptConfigs, page: Object.fromEntries(service.getTargetingKeys().map(key => [key, service.getTargeting(key)]))} : null,
    arms: [...document.scripts].filter(s => s.src.includes('/r/')).map(s => ({src: s.src, integrity: s.integrity, crossOrigin: s.crossOrigin, nonce: s.nonce})),
    consent:window.AdConsent?.snapshot?.()||window.__tesseraReadiness?.snapshot?.()||null,
    nativeBidRequests:(window.pbjs?.getEvents?.()||[]).filter(e=>e.eventType==='bidRequested').length,
    activeLoaderTimers:(window.__loaderTimers||[]).filter(timer=>timer.active).length,
    publisherWordsOriginal:window.__publisherWordsOriginal||null,
    publisherConfigOriginal:window.__publisherConfigOriginal||null,
    currentWords:window.adsKeywords||null,
    prebid: window.pbjs && window.pbjs.version || null, draws: window.__draws, unnonced: !!window.__unnoncedRan,
    storage: {local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
      indexedDB: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map(db => db.name) : []},
  };
}'''
# The synthetic GPT renders its test creative through iframe srcdoc, so a page that requires Trusted
# Types needs a policy for that HTML. This default policy has no createScriptURL: a string script
# URL is still refused, and the loader must bring its own policy for the arm.
TT_HTML_ONLY = "trustedTypes.createPolicy('default', {createHTML: html => html});\n"
SETTLED = '''() => !window.__tesseraAbLoader || window.__tesseraAbLoader.snapshot().armStatus !== 'loading' '''


def tags(*names, nonce=None):
    attr = ' nonce="%s"' % nonce if nonce else ''
    known = {'prebid': '<script%s src="%s/prebid.js"></script>', 'loader': '<script%s defer src="%s/ads.js"></script>',
             'direct': '<script%s defer src="%s/direct/ads.js"></script>',
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
    cdn.holds = {}
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
        elif url == 'https://prebid-professor.mbaucal.workers.dev/geo/v1/country':
            request.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'known':True,'country':'RS','source':'cloudflare'}))
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
    for path in case.get('hold', []):
        cdn.holds[path] = threading.Event()
    context, page, path, errors, outbound, answered = open_page(browser, width, case['head'], case.get('pageHeaders', []))
    try:
        draw = case.get('draw', 0)
        init = (INIT.replace('%DRAW%', json.dumps(draw)).replace('%CMP%', json.dumps(case.get('cmp', 'granted')))
                .replace('%SCRIPT%', json.dumps(BIDS)).replace('%LOADER%', cdn.url+'/ads.js'))
        page.clock.install(time=NOW)
        page.clock.pause_at(NOW + timedelta(seconds=1))
        page.add_init_script((TT_HTML_ONLY if case.get('trustedHtml') else '') + init + ('\n' + GPT if case.get('gpt', 'early') == 'early' else ''))
        page.goto(site.url + path + case.get('query', ''), wait_until='domcontentloaded')
        if case.get('lateArm'):
            wait_until(page, "__tesseraAbLoader.snapshot().armStatus==='loading'")
            advance(page, 9000)
            assert any(row['path']==ARM['A'] for row in cdn.log),'Timeout must request control A'
            first='A' if case.get('releaseAfterA') else 'B'
            second='B' if first=='A' else 'A'
            cdn.holds[ARM[first]].set()
            wait_until(page,"__tesseraAbLoader.snapshot().executionArm==='"+first+"'")
            advance(page,2000)
            assert page.evaluate('!!window.__TESSERA_RUNTIME_STARTED && __testAds.observations.requests.length===2'),'The first valid arm must really start before the competing response'
            cdn.holds[ARM[second]].set()
            wait_until(page,"__tesseraAbLoader.snapshot().blockedLateArmStarts>=1",seconds=5)
            before_control=page.evaluate('({started:!!window.__TESSERA_RUNTIME_STARTED,bids:(pbjs.getEvents?.()||[]).filter(e=>e.eventType===\'bidRequested\').length,gam:__testAds.observations.requests.length,snapshot:__tesseraAbLoader.snapshot()})')
            assert before_control['started'] is True and before_control['gam']==2,before_control
            assert before_control['snapshot']['executionArm']==first,before_control
            assert before_control['snapshot']['fallback']==(first=='A'),before_control
            assert before_control['snapshot']['blockedLateArmStarts']>=1,before_control
        if case.get('lateKeywords'):
            wait_until(page,"__tesseraAbLoader.snapshot().armStatus==='loading'")
            page.evaluate("window.__publisherWordsOriginal=window.adsKeywords={Variant:['publisher-A','publisher-B'],TestId:['existing-1','existing-2'],section:['news','sports']}")
            cdn.holds[ARM['B']].set()
        wait_until(page, SETTLED)
        if case.get('gpt') == 'late':
            # The guarded loader waits for GPT before inserting an arm, so labels are usable
            # before the first runtime can execute.
            assert page.evaluate('Array.isArray(window.googletag && window.googletag.cmd) && !window.__testAds'), 'GPT must load last'
            assert not arm_log({'cdn':cdn.log}),'No arm may run before the label gate exists'
            page.add_script_tag(content=GPT)
            wait_until(page, SETTLED)
        advance(page, 2000)
        if case.get('lateTargeting'):
            page.evaluate("googletag.pubads().setTargeting('section',['news','sports']);googletag.pubads().setTargeting('Variant',['foreign-A','foreign-B']);googletag.pubads().setTargeting('TestId',['foreign-id-1','foreign-id-2'])")
            advance(page,36000)
        if case.get('lateConfig'):
            assert page.evaluate('__testAds.observations.requests.length===0'), 'The setConfig conflict must precede every GAM request'
            page.evaluate("window.__publisherConfigOriginal={targeting:{Variant:['foreign-A','foreign-B'],TestId:['foreign-id-1','foreign-id-2'],section:['news','sports']},centering:true,collapseDiv:'ON_NO_FILL'};googletag.setConfig(window.__publisherConfigOriginal)")
        if case.get('lateSlotTargeting'):
            assert page.evaluate('__testAds.observations.requests.length===2'), 'Both initial requests must really precede the slot conflict'
            page.evaluate("const bill=googletag.pubads().getSlots().find(s=>s.getSlotElementId()==='Billboard'),p1=googletag.pubads().getSlots().find(s=>s.getSlotElementId()==='P1');bill.setTargeting('Variant',['slot-A','slot-B']).setTargeting('TestId',['slot-id-1','slot-id-2']).setTargeting('slot_section',['news','sports']);p1.setConfig({targeting:{Variant:['slot-A','slot-B'],TestId:['slot-id-1','slot-id-2'],slot_section:['news','sports']}})")
            advance(page,36000)
        if case.get('refresh'):
            for _ in range(3):
                advance(page, 36000)
        elif case.get('wait'):
            advance(page, case['wait'], 1000)
        if case.get('lateArm'):
            page.wait_for_timeout(1500)
        if case.get('lazy'):
            assert page.evaluate("!__testAds.observations.requests.some(r=>r.id==='P2')"),'P2 must really be lazy'
            page.locator('#P2').scroll_into_view_if_needed();advance(page,2500)
            wait_until(page,"__testAds.observations.requests.some(r=>r.id==='P2')")
        pending_before_release = None
        if case.get('grantAfterPending'):
            pending_before_release = page.evaluate("({gam:__testAds.observations.requests.length,bids:(pbjs.getEvents?.()||[]).filter(e=>e.eventType==='bidRequested').length})")
            assert pending_before_release == {'gam':0,'bids':0},pending_before_release
            page.evaluate('__fixtureGrantCmp()');advance(page,2500)
            wait_until(page,'__testAds.observations.requests.length>0')
        state = page.evaluate(COLLECT)
        state['pendingBeforeRelease'] = pending_before_release
        state['cookies'] = context.cookies()
        if case['name'].startswith(('cache OFF','cache ON')):
            shots=fixtures/'screenshots';shots.mkdir(exist_ok=True)
            page.screenshot(path=str(shots/('cache-'+('on' if case['draw'] else 'off')+'-'+str(width)+'.png')))
    finally:
        for gate in cdn.holds.values(): gate.set()
        context.close()
    return {'state': state, 'errors': errors, 'outbound': outbound, 'answered': len(answered), 'cdn': list(cdn.log)}


# Helpers for the expectations below.
def requests(ev):
    return ev['state']['gpt']['requests'] if ev['state']['gpt'] else []


def arm_log(ev):
    return [(entry['path'], entry['status']) for entry in ev['cdn'] if entry['path'].startswith('/r/')]


def labelled(ev, variant, test_id):
    found = requests(ev)
    assert found, 'GPT requests expected'
    for request in found:
        effective = {**request['page'], **request['slot']}
        assert effective.get('Variant') == [variant] and effective.get('TestId') == [test_id], ('effective labels on every GPT request', request['id'], request['page'], request['slot'])


def unlabelled(ev):
    for request in requests(ev):
        assert all('Variant' not in request[scope] and 'TestId' not in request[scope] for scope in ['page','slot']), ('no effective labels', request['page'], request['slot'])


def sent(ev, code):
    return [(request['slot'].get('hb_pb') or [None])[0] for request in requests(ev) if request['id'] == code]


def ran(ev, version, refresh):
    """The arm that actually ran: its generator profile, its bid cache state and, with refreshes, its GAM sequence."""
    state = ev['state']
    assert state['started'] and state['profile'] == 'tessera-3.25.1', ('runtime', state['profile'])
    assert (state['bidCache'] is not None) == (version == 'B'), ('bid cache diagnostics only in B', state['bidCache'])
    for code in ('Billboard', 'P1'):
        values = sent(ev, code)
        if refresh:
            assert values == SENT[version], ('exact first request and three refreshes', code, values)
        else:
            assert values == ['10.00'], ('exactly one first GPT request', code, values)
    if refresh and version == 'B':
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


def assigned(variant, side=None, refresh=False):
    side = side or variant
    def verify(ev, record, case):
        actual = 'A' if record['arms'][side]['release'] == A_ID else 'B'
        loader(ev, status='assigned', variant=variant, armStatus='loaded', fallback=False,
               scriptRelease=record['arms'][side]['release'], testId=record['testId'], runtimeStarted=True)
        assert ev['state']['adVariant'] == ev['state']['loader']
        assert ev['state']['draws'] == 1, 'Only the loader allocation is forced'
        expected=[(ARM['B'],200),(ARM['A'],200)] if case.get('lateArm') else [('/' + record['arms'][side]['path'], 200)]
        assert arm_log(ev) == expected, arm_log(ev)
        if case.get('lateArm'):
            assert ev['state']['loader']['fallbackRequested'] is True and ev['state']['loader']['blockedLateArmStarts']>=1
        arm_element(ev, record, side)
        labelled(ev, variant, record['testId'])
        ran(ev, actual, refresh)
        if case.get('lazy'):
            assert sent(ev, 'P2') == ['10.00'], ('actual lazy request', sent(ev, 'P2'))
        if case.get('gpt') == 'late':
            assert ev['state']['gpt']['queued'] >= 1, 'The real queue must drain the label gate before arm insertion'
    return verify


def fallback(ev, record, case):
    loader(ev, status='fallback-control', variant='B', armStatus='loaded', fallback=True,
           scriptRelease=record['arms']['A']['release'], runtimeStarted=True)
    assert arm_log(ev) == [(ARM['B'], 404 if case.get('missing') else 200), (ARM['A'], 200)], arm_log(ev)
    labelled(ev, 'B', record['testId'])
    ran(ev, 'A', case.get('refresh', False))
    assert len(ev['state']['arms']) == 1, 'Only the current control element remains installed'
    arm_element(ev, record, 'A')
    if case.get('lateArm'):
        assert ev['state']['loader']['blockedLateArmStarts'] >= 1
        assert ev['state']['loader']['armDeadlineMs']==8000


def duplicate(ev, record, case):
    loader(ev, status='assigned', variant='A', blockedDuplicateLoaders=1, armStatus='loaded')
    assert arm_log(ev) == [(ARM['A'], 200)] and ev['state']['draws'] == 1
    labelled(ev, 'A', record['testId']);ran(ev, 'A', False)


def old_first(ev, record, case):
    loader(ev, status='existing-runtime-conflict', variant=None, armStatus=None, runtimeStarted=True)
    assert not arm_log(ev) and ev['state']['draws'] == 0
    unlabelled(ev);ran(ev, 'A', False)


def old_late(ev, record, case):
    loader(ev, status='existing-runtime-conflict', variant=None, runtimeStarted=True)
    assert arm_log(ev) == [(ARM['B'], 200)]
    unlabelled(ev);ran(ev, 'A', False)
    assert 'Variant' not in ev['state']['gpt']['page'] and 'TestId' not in ev['state']['gpt']['page']


def pending(ev, record, case):
    loader(ev, status='assigned', variant='B', armStatus='loaded', runtimeStarted=True)
    assert not requests(ev) and ev['answered'] == 0 and ev['state']['nativeBidRequests'] == 0
    assert ev['state']['gpt']['page']['Variant'] == ['B']
    assert ev['state']['gpt']['page']['TestId'] == [record['testId']]


def released(ev, record, case):
    assert ev['state']['pendingBeforeRelease'] == {'gam': 0, 'bids': 0}
    assigned('B')(ev, record, case)


def denied(ev, record, case):
    loader(ev, status='assigned', variant='A', armStatus='loaded')
    labelled(ev, 'A', record['testId'])
    assert ev['answered'] == 0 and ev['state']['nativeBidRequests'] == 0
    assert requests(ev), 'A completed rejection preserves the existing clean GAM fallback'
    assert all(clean_hb(row) for row in requests(ev))
    assert not any(value.get('nonPersonalizedAds') is True for value in ev['state']['gpt']['privacy'])


def direct_denied(ev, record, case):
    assert ev['state']['loader'] is None and ev['answered'] == 0
    assert ev['state']['nativeBidRequests'] == 0 and requests(ev)
    unlabelled(ev)
    assert all(clean_hb(row) for row in requests(ev))


def clean_hb(row):
    return not {key:value for key,value in row['slot'].items()
                if key.startswith('hb_') and key not in ['hb_ver','hb_version'] and value}


def missing_prebid(ev, record, case):
    loader(ev, status='assigned', variant='A', armStatus='loaded')
    assert ev['state']['prebid'] is None and ev['answered'] == 0
    assert not [row for row in ev['cdn'] if row['path'].endswith('/prebid.js')], ev['cdn']
    assert not [row for row in ev['cdn'] if row['path'].startswith('/r/') and row['path'].endswith('/prebid.js')]
    # This is deliberately NOT a ready native-Prebid installation. The frozen
    # runtime's clean GAM-only fallback, if dispatched, retains assigned labels.
    for row in requests(ev):
        assert row['page'].get('Variant') == ['A'] and row['page'].get('TestId') == [record['testId']]
        assert clean_hb(row)


def no_arm(ev, record, case):
    loader(ev, status='control-load-error', armStatus=case.get('armStatus', 'error'), runtimeStarted=False)
    assert not requests(ev) and not ev['state']['started']
    if case.get('armStatus') == 'trusted-types-blocked':
        assert not arm_log(ev)
    else:
        status=404 if case.get('missing') else 200
        assert arm_log(ev) == [(ARM['A'], status), (ARM['A'], status)]


def nonce(ev, record, case):
    assigned('A')(ev, record, case)
    assert ev['state']['arms'][0]['nonce'] == case['nonce']
    if case['nonce'] == 'ab-nonce-1':
        assert not ev['state']['unnonced'], 'The unnonced negative-control script must be blocked'


def forced(ev, record, case):
    loader(ev, status='forced', variant='B', scriptRelease=record['arms']['B']['release'])
    assert ev['state']['draws'] == 0
    unlabelled(ev);ran(ev, 'B', False)


def random_unavailable(ev, record, case):
    loader(ev, status='random-unavailable', variant=None, scriptRelease=record['arms']['A']['release'])
    unlabelled(ev);ran(ev, 'A', False)


def keyword_conflict(ev, record, case):
    loader(ev,status='excluded-key-conflict',variant=None,scriptRelease=record['arms']['A']['release'],keyConflict=True)
    unlabelled(ev);ran(ev,'A',False)
    original={'Variant':['publisher-A','publisher-B'],'TestId':['existing-1','existing-2'],'section':['news','sports']}
    assert ev['state']['publisherWordsOriginal']==original, 'Do not mutate the publisher-owned keyword object'
    assert ev['state']['currentWords']=={'section':['news','sports']}
    assert ev['state']['gpt']['page'].get('section')==['news','sports']
    if case.get('lateKeywords'):
        assert arm_log(ev)==[(ARM['B'],200),(ARM['A'],200)]
    else:
        assert arm_log(ev)==[(ARM['A'],200)]


def existing_page_keys(ev, record, case):
    loader(ev,status='excluded-key-conflict',variant=None,scriptRelease=record['arms']['A']['release'],keyConflict=True)
    ran(ev,'A',False)
    for row in requests(ev):
        assert row['page'].get('Variant')==['publisher-A','publisher-B']
        assert row['page'].get('TestId')==['existing-1','existing-2']
        assert row['page'].get('section')==['news','sports']


def late_page_keys(ev, record, case):
    loader(ev,status='excluded-key-conflict',variant=None,keyConflict=True,runtimeStarted=True)
    rows=requests(ev)
    for code in ['Billboard','P1']:
        selected=[row for row in rows if row['id']==code]
        assert len(selected)==2
        assert selected[0]['page']['Variant']==['B'] and selected[0]['page']['TestId']==[record['testId']]
        assert 'Variant' not in selected[1]['page'] and 'TestId' not in selected[1]['page']
        assert selected[1]['page']['section']==['news','sports']
    assert arm_log(ev)==[(ARM['B'],200)], 'A running arm is never replaced by a second runtime'


def pending_config_keys(ev, record, case):
    loader(ev,status='excluded-key-conflict',variant=None,keyConflict=True,runtimeStarted=True)
    assert ev['state']['pendingBeforeRelease']=={'gam':0,'bids':0}
    unlabelled(ev);ran(ev,'B',False)
    original={'targeting':{'Variant':['foreign-A','foreign-B'],'TestId':['foreign-id-1','foreign-id-2'],'section':['news','sports']},'centering':True,'collapseDiv':'ON_NO_FILL'}
    assert ev['state']['publisherConfigOriginal']==original, 'The publisher-owned full setConfig input is unchanged'
    forwarded=[row for row in ev['state']['gpt']['configs'] if row.get('centering') is True]
    assert forwarded==[{'targeting':{'section':['news','sports']},'centering':True,'collapseDiv':'ON_NO_FILL'}], forwarded
    for row in requests(ev):
        assert row['page'].get('section')==['news','sports']
    assert arm_log(ev)==[(ARM['B'],200)], 'The pending running arm remains single after exclusion'


def late_slot_keys(ev, record, case):
    loader(ev,status='excluded-key-conflict',variant=None,keyConflict=True,runtimeStarted=True)
    for code in ['Billboard','P1']:
        rows=[row for row in requests(ev) if row['id']==code]
        assert len(rows)==2, (code,rows)
        first,later=rows
        assert {**first['page'],**first['slot']}.get('Variant')==['B']
        assert {**first['page'],**first['slot']}.get('TestId')==[record['testId']]
        assert 'Variant' not in later['page'] and 'TestId' not in later['page'], later
        assert later['slot'].get('Variant')==['slot-A','slot-B'], later
        assert later['slot'].get('TestId')==['slot-id-1','slot-id-2'], later
        assert later['slot'].get('slot_section')==['news','sports'], later
    assert arm_log(ev)==[(ARM['B'],200)], 'Foreign slot values exclude attribution without replacing the running arm'


SRI_ERROR = "Failed to find a valid digest in the 'integrity' attribute"
CORS_ERROR = 'has been blocked by CORS policy'
CSP_ERROR = 'violates the following Content Security Policy directive'
TT_SCRIPT_URL, TT_POLICY = "requires 'TrustedScriptURL' assignment", "TrustedTypePolicy named 'tessera-ab-loader'"
TT_CSP = "script-src 'nonce-ab-tt' 'strict-dynamic'; object-src 'none'; base-uri 'none'; require-trusted-types-for 'script'"
CASES = [
    {'name':'cache OFF first/refresh/lazy','bundle':'ab','draw':0,'head':tags('prebid','loader'),'refresh':True,'lazy':True,'widths':[1280,390],'check':assigned('A',refresh=True)},
    {'name':'cache ON first/refresh/lazy, GPT late','bundle':'ab','draw':4294967295,'gpt':'late','head':tags('prebid','loader'),'refresh':True,'lazy':True,'widths':[1280,390],'check':assigned('B',refresh=True)},
    {'name':'A/A assigned B executes identical A','bundle':'aa','draw':4294967295,'head':tags('prebid','loader'),'check':assigned('B','A')},
    {'name':'b=0','bundle':'b0','draw':4294967295,'head':tags('prebid','loader'),'check':assigned('A')},
    {'name':'b=100','bundle':'b100','draw':0,'head':tags('prebid','loader'),'check':assigned('B')},
    {'name':'duplicate loader','bundle':'ab','head':tags('prebid','loader','loader'),'check':duplicate},
    {'name':'old direct runtime first','bundle':'ab','head':tags('prebid','direct','loader'),'check':old_first},
    {'name':'old tag wins after loader','bundle':'ab','draw':4294967295,'slow':{ARM['B']:0.5},'head':tags('prebid','loader','direct'),'check':old_late},
    {'name':'arm wins before old tag','bundle':'ab','draw':4294967295,'slow':{'/direct/ads.js':0.5},'head':tags('prebid','loader','direct'),'check':assigned('B')},
    {'name':'B 404 falls back to A, labels remain B','bundle':'ab','draw':4294967295,'missing':[ARM['B']],'head':tags('prebid','loader'),'refresh':True,'lazy':True,'check':fallback},
    {'name':'B SRI failure falls back to A, labels remain B','bundle':'ab','draw':4294967295,'tamper':[ARM['B']],'head':tags('prebid','loader'),'refresh':True,'lazy':True,'allow':[SRI_ERROR],'require':[SRI_ERROR],'check':fallback},
    {'name':'B deadline still permits B to win before held control','bundle':'ab','draw':4294967295,'hold':[ARM['B'],ARM['A']],'lateArm':True,'head':tags('prebid','loader'),'check':assigned('B')},
    {'name':'control wins and blocks pending B after its deadline','bundle':'ab','draw':4294967295,'hold':[ARM['B'],ARM['A']],'lateArm':True,'releaseAfterA':True,'head':tags('prebid','loader'),'check':fallback},
    {'name':'A terminal 404 retries once and clears timers','bundle':'ab','missing':[ARM['A']],'head':tags('prebid','loader'),'wait':24000,'check':no_arm},
    {'name':'successful A clears deadline timers','bundle':'ab','head':tags('prebid','loader'),'wait':20000,'check':assigned('A')},
    {'name':'early multivalue publisher keyword conflict','bundle':'ab','draw':4294967295,'head':["<script>window.__publisherWordsOriginal=window.adsKeywords={Variant:['publisher-A','publisher-B'],TestId:['existing-1','existing-2'],section:['news','sports']}</script>"]+tags('prebid','loader'),'check':keyword_conflict},
    {'name':'late multivalue publisher keyword conflict','bundle':'ab','draw':4294967295,'hold':[ARM['B']],'lateKeywords':True,'head':tags('prebid','loader'),'check':keyword_conflict},
    {'name':'existing multivalue GPT publisher keys preserved','bundle':'ab','draw':4294967295,'head':["<script>googletag.pubads().setTargeting('Variant',['publisher-A','publisher-B']);googletag.pubads().setTargeting('TestId',['existing-1','existing-2']);googletag.pubads().setTargeting('section',['news','sports'])</script>"]+tags('prebid','loader'),'check':existing_page_keys},
    {'name':'late multivalue GPT targeting conflict excludes later requests','bundle':'ab','draw':4294967295,'lateTargeting':True,'head':tags('prebid','loader'),'check':late_page_keys},
    {'name':'setConfig reserved multivalue conflict while CMP pending','bundle':'ab','draw':4294967295,'cmp':'pending','lateConfig':True,'grantAfterPending':True,'head':tags('prebid','loader'),'wait':60000,'check':pending_config_keys},
    {'name':'both slot targeting APIs exclude later refresh attribution','bundle':'ab','draw':4294967295,'lateSlotTargeting':True,'head':tags('prebid','loader'),'check':late_slot_keys},
    {'name':'real CORS rejection','bundle':'ab','acao':False,'head':tags('prebid','loader'),'allow':[CORS_ERROR],'require':[CORS_ERROR],'check':no_arm},
    {'name':'forced QA stays excluded','bundle':'b0','query':'?tessera_ab=B','head':tags('prebid','loader'),'check':forced},
    {'name':'missing allocation entropy stays excluded','bundle':'ab','draw':'none','head':tags('prebid','loader'),'check':random_unavailable},
    {'name':'CMP pending beyond all deadlines','bundle':'ab','draw':4294967295,'cmp':'pending','head':tags('prebid','loader'),'wait':60000,'check':pending},
    {'name':'late CMP grant follows actual decision','bundle':'ab','draw':4294967295,'cmp':'pending','head':tags('prebid','loader'),'wait':60000,'grantAfterPending':True,'check':released},
    {'name':'CMP denied preserves clean GAM fallback','bundle':'ab','cmp':'denied','head':tags('prebid','loader'),'check':denied},
    {'name':'direct same-version denied baseline','bundle':'ab','cmp':'denied','head':tags('direct-prebid','direct'),'check':direct_denied},
    {'name':'only ads.js is not a native-Prebid installation','bundle':'ab','head':tags('loader'),'wait':60000,'nativeExpected':False,'check':missing_prebid},
    {'name':'nonce CSP with unnonced negative control','bundle':'ab','nonce':'ab-nonce-1','head':['<script>window.__unnoncedRan=true</script>']+tags('prebid','loader',nonce='ab-nonce-1'),'allow':[CSP_ERROR],'require':[CSP_ERROR],'pageHeaders':[('Content-Security-Policy',"script-src 'nonce-ab-nonce-1'; object-src 'none'; base-uri 'none'")],'check':nonce},
    {'name':'Trusted Types permitted','bundle':'ab','nonce':'ab-tt','head':tags('prebid','loader',nonce='ab-tt'),'trustedHtml':True,'pageHeaders':[('Content-Security-Policy',TT_CSP)],'check':nonce},
    {'name':'Trusted Types disallowed','bundle':'ab','head':tags('prebid','loader',nonce='ab-tt'),'allow':[TT_SCRIPT_URL,TT_POLICY],'require':[TT_SCRIPT_URL,TT_POLICY],'pageHeaders':[('Content-Security-Policy',TT_CSP+"; trusted-types 'none'")],'armStatus':'trusted-types-blocked','check':no_arm},
]


def common(ev, case):
    allowed = ['Failed to load resource'] + case.get('allow', [])
    unexpected = [error for error in ev['errors'] if not any(text in error for text in allowed)]
    assert not unexpected, ('page/console errors', unexpected)
    for text in case.get('require', []):
        assert any(text in error for error in ev['errors']), ('Browser must enforce negative control', text, ev['errors'])
    assert not ev['outbound'], ('Unexpected external request was blocked', ev['outbound'])
    if case.get('nativeExpected', True):
        assert ev['state']['prebid'] == 'v' + manifest['prebid']['version']
    assert ev['state']['gpt']['errors'] == []
    assert ev['state']['activeLoaderTimers']==0, 'No loader gate/arm deadline remains after settling'
    assert ev['state']['storage'] == {'local':0,'session':0,'cookie':'','indexedDB':[]}, ev['state']['storage']
    assert ev['state']['cookies'] == []


results, evidence = [], []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
    browser_version = browser.version
    try:
        for case in CASES:
            for width in case.get('widths', [1280]):
                try:
                    ev = run(browser, case, width)
                    common(ev, case);case['check'](ev, BUNDLES[case['bundle']][0], case)
                    evidence.append((case['name'],ev))
                    results.append({'case':case['name'],'width':width,'passed':True,'loader':ev['state']['loader'],
                      'armRequests':arm_log(ev),'requests':requests(ev),'syntheticBidRows':ev['answered'],
                      'resourceRequests':ev['cdn'],
                      'nativeBidRequests':ev['state']['nativeBidRequests'],'queuedBeforeGpt':ev['state']['gpt']['queued'],
                      'storage':ev['state']['storage'],'nativeInstallationReady':case.get('nativeExpected',True)})
                    print('PASS '+case['name']+' '+str(width),flush=True)
                except Exception as error:
                    results.append({'case':case['name'],'width':width,'passed':False,'error':repr(error)[:6000]})
                    print('FAIL '+case['name']+' '+str(width)+' '+repr(error)[:6000],flush=True)
        denied_runs={name:ev for name,ev in evidence if 'denied' in name}
        try:
            assert len(denied_runs)==2,'Both denied cases must complete before policy comparison'
            controlled=denied_runs['CMP denied preserves clean GAM fallback'];direct=denied_runs['direct same-version denied baseline']
            assert controlled['state']['gpt']['privacy']==direct['state']['gpt']['privacy'],'Loader must not alter rejection policy'
            assert [r['id'] for r in requests(controlled)]==[r['id'] for r in requests(direct)]
            results.append({'case':'denied policy matches direct same-version baseline','passed':True})
        except Exception as error:
            results.append({'case':'denied policy matches direct same-version baseline','passed':False,'error':repr(error)})
    finally:
        browser.close();site.server.shutdown();cdn.server.shutdown()
report={'scope':'Complete MAIN 3.25.1 Generate/readPackage ZIPs; native Prebid11.34; synthetic GPT/CMP/demand; real loopback SRI/CORS/CSP; no live ads',
  'site':manifest['site'],'versions':manifest['versions'],'bundles':manifest['bundles'],'prebid':manifest['prebid'],
  'environment':{'node':manifest['nodeVersion'],'playwright':package_version('playwright'),'chromium':browser_version},'results':results,
  'installationBoundary':'Load approved CMP/GPT and the identical root prebid.js before generic ads.js. Loader-only HTML is not a ready native-Prebid setup.',
  'passed':sum(row['passed'] for row in results),'failed':sum(not row['passed'] for row in results)}
(fixtures/'browser-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':report['passed'],'failed':report['failed']}),flush=True)
sys.exit(1 if report['failed'] else 0)
