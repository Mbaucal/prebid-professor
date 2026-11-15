"""3.23.0 bid caching in Chromium with a real Prebid.js; synthetic GPT, TCF and bidders, no paid traffic.

python scripts/verify-bidcache323-browser.py [output]
Run scripts/prepare-bidcache323-browser.mjs first (same output folder; default
.generated/bidcache323-browser). Each scenario is a 3.23.0 package generated through
the TEST workspace Generate path for a synthetic, non-Tanjug site
(tests/runtime/bid-cache323-site.mjs), with the Prebid.js file given to the prepare
step as the site's build: by default the vendored Prebid.js 11.34.0, in CI also a
pinned upstream 11.11.0 build (scripts/build-bidcache-prebid.mjs). The expected
Prebid version comes from the prepared manifest. The page loads the package's own
prebid.js and ads.min.js (and, for the on scenario, also ads.js). GPT is
tests/runtime/mock-ad-libraries.js, the CMP is a local TCF stub that grants every
purpose and vendor, and the pubmatic and openx adapters are replaced with synthetic
adapters whose requests are answered by a route. Every other request is aborted.
The page clock is virtual; a refresh step waits only for in-flight bid requests.

Each position gets four auctions: the initial one and three automatic refreshes
(30-second rule). Synthetic bids per auction: pubmatic 10 and 4, then 1, then 2,
then 12; openx 0.5 every time. GAM requests are read from the slot targeting at
the moment of each request.
- on (site default on): Billboard and P1 send 10, then the unsent earlier 4 against
  fresh 1, then fresh 2 against the unsent earlier 1, then fresh 12.
- off (saved off): fresh bids only, 10, 1, 2, 12, and no bid cache settings in Prebid.
- override (site default on, Billboard off): Billboard fresh only; P1 as in on.
- deal (the on package): pubmatic 10, then 1, 2, 12; openx 6 and 5, then a deal
  D-9 at 3, then 0.5 twice. The refresh sends the fresh openx deal with
  hb_deal_openx, as 3.21.2 does; the unsent openx 5 never takes its place.
Desktop (1280 px) and mobile (390 px) run every scenario. In every scenario Prebid's
targetingControls stay as 3.21.2 sets them (presetGPTTargeting untouched).
"""
import hashlib
import json
import os
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1] if len(sys.argv) > 1 else root / '.generated/bidcache323-browser')
manifest = json.loads((output / 'manifest.json').read_text())
for name, expected in manifest['files'].items():
    assert hashlib.sha256((output / name).read_bytes()).hexdigest() == expected, 'Generated file changed: ' + name
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
# Keep synthetic GPT only: Prebid is the real file and the CMP is the stub below.
start, end = mock.index('  window.pbjs = {'), mock.index('  window.__testAds =')
mock = mock[:start] + mock[end:]
now = datetime(2026, 11, 15, 12, tzinfo=timezone.utc)
ORIGIN = 'https://bidcache.example.invalid'
PAGE, BID = ORIGIN + '/article', ORIGIN + '/__synthetic-bid'
TC_STRING = 'synthetic-bidcache-tc-string'
BODY = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<script src="/prebid.js"></script><script defer src="/ads.min.js"></script></head><body style="margin:0">'
        '<div id="Billboard" class="wrapperAd" style="min-height:250px"></div><div id="P1" class="wrapperAd" style="min-height:250px"></div>'
        '<main style="height:2000px"></main></body></html>')
HOOK = r'''
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
  const grants = Object.fromEntries(Array.from({length: 1000}, (_, i) => [i + 1, true]));
  window.__tcfapi = (command, version, callback) => {
    if (command === 'addEventListener' || command === 'getTCData') {
      callback({gdprApplies: true, tcString: '%TC%', listenerId: 1, eventStatus: 'tcloaded', cmpStatus: 'loaded',
        purpose: {consents: grants, legitimateInterests: grants}, vendor: {consents: grants, legitimateInterests: grants},
        specialFeatureOptins: grants, publisher: {restrictions: {}}}, true);
    } else if (command === 'ping') callback({cmpLoaded: true, gdprApplies: true}, true);
    else callback(true);
  };
  // Bids per bidder and auction: a number is a CPM, an object adds fields such as dealId.
  const script = %SCRIPT%;
  const rounds = new Map();
  window.pbjs = {que: [() => {
    for (const name of ['pubmatic', 'openx']) window.pbjs.registerBidAdapter(null, name, {
      code: name, supportedMediaTypes: ['banner'], isBidRequestValid: () => true,
      buildRequests(bids) {
        return {method: 'GET', url: '%BID%', options: {withCredentials: false}, data: {payload: JSON.stringify(bids.flatMap(bid => {
          const round = (rounds.get(name + ':' + bid.adUnitCode) || 0) + 1;
          rounds.set(name + ':' + bid.adUnitCode, round);
          const size = bid.mediaTypes.banner.sizes.find(item => Array.isArray(item) && item[0] > 1);
          return (script[name][round - 1] || []).map(row => Object.assign({requestId: bid.bidId, ttl: 120, width: size[0], height: size[1], round}, typeof row === 'number' ? {cpm: row} : row));
        }))}};
      },
      interpretResponse: response => response.body.bids,
    });
  }]};
})();
'''.replace('%TC%', TC_STRING).replace('%BID%', BID)
# pubmatic: 10 and 4, then 1, then 2, then 12. openx: 0.5 in every auction.
STANDARD = {'pubmatic': [[10, 4], [1], [2], [12]], 'openx': [[0.5], [0.5], [0.5], [0.5]]}
# openx leaves 5 unsent in the first auction and bids a fresh deal in the refresh.
DEAL = {'pubmatic': [[10], [1], [2], [12]], 'openx': [[6, 5], [{'cpm': 3, 'dealId': 'D-9'}], [0.5], [0.5]]}
RECORD = r'''
(() => {
  // Each GAM request with the Prebid targeting its slot carries at that moment.
  window.__gam = [];
  const service = window.__testAds.service, refresh = service.refresh;
  const events = () => (window.pbjs && typeof window.pbjs.getEvents === 'function' ? window.pbjs.getEvents() : []);
  service.refresh = function(list) {
    for (const slot of list || []) {
      const keys = Object.fromEntries(slot.getTargetingKeys().filter(key => key.startsWith('hb_')).map(key => [key, slot.getTargeting(key)]));
      const all = events(), bid = id => {
        const found = all.find(event => event.eventType === 'bidResponse' && event.args.adId === id);
        return found ? {cpm: found.args.cpm, auctionId: found.args.auctionId, code: found.args.adUnitCode, bidder: found.args.bidderCode, deal: found.args.dealId || null} : null;
      };
      const latest = [...all].reverse().find(event => event.eventType === 'auctionInit' && event.args.adUnitCodes.includes(slot.id));
      window.__gam.push({code: slot.id, at: Date.now(), keys, winner: keys.hb_adid ? bid(keys.hb_adid[0]) : null,
        bids: Object.fromEntries(Object.entries(keys).filter(([key]) => key.startsWith('hb_adid')).map(([key, value]) => [key, bid(value[0])])),
        latestAuction: latest ? latest.args.auctionId : null});
    }
    return refresh.apply(this, arguments);
  };
})();
'''
# package: the prepared package; bids: the synthetic bidders; sent: the winning CPM of the
# four GAM requests per position; reused: positions whose second request reuses the unsent 4;
# openx: the hb_adid_openx CPM per request (always a fresh bid); deal: hb_deal_openx per request.
SCENARIOS = {
    'on': {'package': 'on', 'bids': STANDARD, 'sent': {'Billboard': [10, 4, 2, 12], 'P1': [10, 4, 2, 12]}, 'reused': ['Billboard', 'P1'],
           'enabled': {'Billboard': True, 'P1': True}, 'openx': [0.5] * 4, 'deal': [None] * 4},
    'off': {'package': 'off', 'bids': STANDARD, 'sent': {'Billboard': [10, 1, 2, 12], 'P1': [10, 1, 2, 12]}, 'reused': [],
            'enabled': None, 'openx': [0.5] * 4, 'deal': [None] * 4},
    'override': {'package': 'override', 'bids': STANDARD, 'sent': {'Billboard': [10, 1, 2, 12], 'P1': [10, 4, 2, 12]}, 'reused': ['P1'],
                 'enabled': {'Billboard': False, 'P1': True}, 'openx': [0.5] * 4, 'deal': [None] * 4},
    'deal': {'package': 'on', 'bids': DEAL, 'sent': {'Billboard': [10, 3, 2, 12], 'P1': [10, 3, 2, 12]}, 'reused': [],
             'enabled': {'Billboard': True, 'P1': True}, 'openx': [6, 3, 0.5, 0.5], 'deal': [None, 'D-9', None, None]},
}
PREBID_VERSION = 'v' + manifest['prebid']['version']


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


def run(browser, scenario, width, program):
    folder = output / SCENARIOS[scenario]['package']
    context = browser.new_context(viewport={'width': width, 'height': 900 if width > 600 else 844}, service_workers='block')
    page = context.new_page()
    errors, outbound, answered = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    # Aborted requests (the country lookup) log 'Failed to load resource'; every other console error fails the run.
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' and not message.text.startswith('Failed to load resource') else None)

    def route(request):
        url = request.request.url
        path = urllib.parse.urlsplit(url).path
        if url == PAGE:
            request.fulfill(content_type='text/html', body=BODY)
        elif url.startswith(ORIGIN + '/') and path in ('/prebid.js', '/ads.min.js'):
            request.fulfill(content_type='application/javascript', body=(folder / (program if path == '/ads.min.js' else 'prebid.js')).read_bytes())
        elif url.startswith(BID + '?'):
            rows = json.loads(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['payload'][0])
            answered.extend(rows)
            bids = [{**row, 'mediaType': 'banner', 'creativeId': 'synthetic', 'currency': 'EUR', 'netRevenue': True,
                     'ad': '<div>Synthetic bid cache test</div>', 'meta': {'advertiserDomains': ['example.invalid']}} for row in rows]
            request.fulfill(status=200, content_type='application/json', body=json.dumps({'bids': bids}))
        elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
            # Prebid's currency module asks for rates; answer with identity rates, never the network.
            request.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                            body=json.dumps({'conversions': {'EUR': {'EUR': 1, 'USD': 1}, 'USD': {'USD': 1, 'EUR': 1}}}))
        else:
            outbound.append(urllib.parse.urlsplit(url).hostname)
            request.abort()
    context.route('**/*', route)
    page.clock.install(time=now)
    page.clock.pause_at(now + timedelta(seconds=1))
    page.add_init_script(mock + '\n' + HOOK.replace('%SCRIPT%', json.dumps(SCENARIOS[scenario]['bids'])) + '\n' + RECORD)
    page.goto(PAGE)
    advance(page, 2000)
    for _ in range(3):
        advance(page, 36000)
    state = page.evaluate('''() => ({gam: window.__gam, version: pbjs.version, useBidCache: pbjs.getConfig('useBidCache'),
      filter: typeof pbjs.getConfig('bidCacheFilterFunction'), preset: pbjs.getConfig('targetingControls.presetGPTTargeting'),
      alwaysIncludeDeals: pbjs.getConfig('targetingControls.alwaysIncludeDeals'),
      sendAllBids: pbjs.getConfig('enableSendAllBids'),
      consent: pbjs.getEvents().filter(event => event.eventType === 'bidRequested').map(event => event.args.gdprConsent && event.args.gdprConsent.consentString),
      snapshot: window.__tesseraBidCache ? window.__tesseraBidCache.snapshot() : null,
      auctions: pbjs.getEvents().filter(event => event.eventType === 'auctionInit').length})''')
    context.close()
    return state, errors, outbound, answered


def check(scenario, width, program, state, errors, outbound, answered):
    spec = SCENARIOS[scenario]
    expected = spec['sent']
    assert not errors, errors
    assert not [host for host in outbound if host and host.endswith(('doubleclick.net', 'googlesyndication.com', 'pubmatic.com', 'openx.net'))], ('no ad server or bidder request', outbound)
    assert state['version'] == PREBID_VERSION, (state['version'], PREBID_VERSION)
    assert state['sendAllBids'] is True and state['alwaysIncludeDeals'] is True, 'send-all-bids and deal keys stay on'
    assert state['preset'] is None, ('targetingControls.presetGPTTargeting stays as in 3.21.2', state['preset'])
    assert state['consent'] and all(value == TC_STRING for value in state['consent']), ('bidders get the CMP string', state['consent'])
    for code, cpms in expected.items():
        requests = [request for request in state['gam'] if request['code'] == code]
        assert len(requests) >= 4, (code, 'four GAM requests', requests)
        requests = requests[:4]
        sent = [request['winner']['cpm'] if request['winner'] else None for request in requests]
        assert sent == cpms, (scenario, width, code, sent)
        assert all(request['keys']['hb_pb'] == ['%.2f' % cpm] for request, cpm in zip(requests, cpms)), (code, [r['keys'].get('hb_pb') for r in requests])
        auctions = [request['latestAuction'] for request in requests]
        assert all(auctions) and len(set(auctions)) == 4, ('every request has its own new auction', code, auctions)
        for index, request in enumerate(requests):
            for key, bid in request['bids'].items():
                assert bid and bid['code'] == code, ('targeting stays with its own position', code, key, bid)
            reused = request['winner']['auctionId'] != request['latestAuction']
            assert reused == (index == 1 and code in spec['reused']), ('only the unsent earlier 4 is reused', code, index, request)
            openx = request['bids'].get('hb_adid_openx')
            assert openx and openx['cpm'] == spec['openx'][index] and openx['auctionId'] == request['latestAuction'], ('send-all-bids: fresh openx only; a sent bid is never sent again', code, index, openx)
            deal = spec['deal'][index]
            assert request['keys'].get('hb_deal_openx') == ([deal] if deal else None) and openx['deal'] == deal, ('a fresh deal reaches GAM as in 3.21.2', code, index, request['keys'].get('hb_deal_openx'), openx)
        # hb_adid and hb_adid_<bidder> of one request name the same winner; across requests no ID repeats.
        sent_ids = [id for request in requests for id in {value[0] for key, value in request['keys'].items() if key.startswith('hb_adid')}]
        assert len(sent_ids) == len(set(sent_ids)), ('no bid is sent to GAM twice', code, sent_ids)
    if spec['enabled'] is None:
        assert state['useBidCache'] is False and state['filter'] == 'undefined' and state['snapshot'] is None, state
    else:
        snapshot = state['snapshot']
        assert state['useBidCache'] is True and state['filter'] == 'function', state
        assert snapshot['status'] == 'active' and snapshot['reason'] is None, snapshot
        assert snapshot['counters']['cachedWins'] == len(spec['reused']), snapshot['counters']
        assert snapshot['positions'] == [{'code': code, 'enabled': spec['enabled'][code]} for code in sorted(expected)], snapshot['positions']
        # Each refused bid counts once per reason, however often Prebid reads targeting.
        bids = sum(len(rows) for rows in spec['bids'].values()) * len(expected)
        assert all(count <= bids for count in snapshot['counters']['filterRejections'].values()), (bids, snapshot['counters'])
        if scenario == 'deal':
            assert snapshot['counters']['filterRejections'].get('deal') == len(expected), snapshot['counters']
        text = json.dumps(snapshot)
        leaked = [value for value in [TC_STRING] + [value[0] for request in state['gam'] for key, value in request['keys'].items() if key.startswith('hb_adid')] if value in text]
        assert not leaked, ('diagnostics hold no consent string or ad ID', leaked)
    return {'scenario': scenario, 'width': width, 'program': program, 'sent': {code: [r['winner']['cpm'] for r in state['gam'] if r['code'] == code][:4] for code in expected},
            'auctions': state['auctions'], 'syntheticBidRows': len(answered), 'blockedHosts': sorted({host for host in outbound if host}),
            'diagnostics': state['snapshot'] and {key: state['snapshot'][key] for key in ('status', 'reason', 'counters', 'positions')}}


results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
    try:
        runs = [(scenario, width, 'ads.min.js') for scenario in SCENARIOS for width in [1280, 390]] + [('on', 1280, 'ads.js'), ('on', 390, 'ads.js')]
        for scenario, width, program in runs:
            try:
                evidence = check(scenario, width, program, *run(browser, scenario, width, program))
                results.append({'passed': True, **evidence})
                print('PASS %s %dpx %s %s' % (scenario, width, program, json.dumps(evidence['sent'])), flush=True)
            except Exception as error:
                results.append({'scenario': scenario, 'width': width, 'program': program, 'passed': False, 'error': repr(error)[:4000]})
                print('FAIL %s %dpx %s %s' % (scenario, width, program, repr(error)[:4000]), flush=True)
    finally:
        browser.close()
report = {'scope': '3.23.0 packages with Prebid.js %s in Chromium; synthetic GPT, TCF and bidders; every other request aborted; virtual clock' % manifest['prebid']['version'],
          'runtime': manifest['runtime'], 'prebid': manifest['prebid'], 'results': results, 'passed': sum(r['passed'] for r in results), 'failed': sum(not r['passed'] for r in results)}
(output / 'browser-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': report['passed'], 'failed': report['failed']}), flush=True)
sys.exit(1 if report['failed'] else 0)
