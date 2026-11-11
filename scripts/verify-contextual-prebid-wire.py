"""Native Prebid RTD + unchanged SSP adapters; every request is intercepted.

Run verify-contextual-prebid-build.mjs first. This proves client serialization,
not SSP receipt, supported taxonomy membership, commercial acceptance or uplift.
"""
import argparse
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = Path(os.environ.get('CONTEXTUAL_PREBID_ROOT', ROOT / '.generated/contextual-prebid')).resolve()
ORIGIN = 'https://contextual-fixture.invalid'
HTML = '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="fixture"></div></body></html>'
ENDPOINTS = {'i.connectad.io': 'connectad', 'rtb.openx.net': 'openx', 'hbopenbid.pubmatic.com': 'pubmatic',
             'htlb.casalemedia.com': 'ix', 'fastlane.rubiconproject.com': 'rubicon',
             'a.teads.tv': 'teads', 'shb.richaudience.com': 'richaudience'}
SUPPORTED = {'connectad', 'openx', 'pubmatic', 'ix', 'rubicon'}
PINS = {'11.11.0': '0f6ba177203d5f63e0a11453ed0c887fcf5efe33',
        '11.34.0': '195e0c6069928ed906bde550cb4e4183d1dc8474'}
MODES = ['route-off', 'disabled', 'no-routes', 'no-category', 'unknown-category', 'foreign-auction',
         'mismatched-auction', 'provider-throws', 'concurrent', 'category-cleared', 'no-leak',
         'mixed-rubicon', 'activity-denied', 'rtd-activity-denied']


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def segments(ortb):
    return ortb.get('site', {}).get('content', {}).get('data', [])


def own_data(data, provider):
    return [item for item in data if item.get('name') == provider]


def own_ids(data, provider):
    return [str(segment['id']) for item in own_data(data, provider) for segment in item.get('segment', [])]


def parse_request(request):
    url = urlsplit(request.url)
    bidder = ENDPOINTS[url.hostname]
    if bidder == 'rubicon':
        payload = parse_qs(url.query, keep_blank_values=True)
        if request.post_data:
            payload.update(parse_qs(request.post_data, keep_blank_values=True))
    else:
        body = request.post_data_buffer or b'{}'
        if body[:2] == b'\x1f\x8b':
            body = gzip.decompress(body)
        payload = json.loads(body)
    return {'bidder': bidder, 'url': f'{url.scheme}://{url.netloc}{url.path}', 'method': request.method, 'payload': payload}


def validate(result, rows, errors, blocked, parse_errors, version):
    check(not errors, f'Browser errors: {errors}')
    check(not blocked, f'Unexpected network attempts (aborted): {blocked}')
    check(not parse_errors, f'Could not parse native adapter requests: {parse_errors}')
    check(result['prebidVersion'].lstrip('v') == version, 'Wrong native Prebid version')
    check({'rtdModule', 'contextualSignalsRtdProvider', 'allowActivities'}.issubset(result['installedModules']),
          'Real RTD/activity-control modules missing')
    check(result['beforeGlobal'] == result['afterGlobal'], 'Contextual routing mutated global FPD')
    check(not result['bidderConfigWrites'], 'Runtime wrote persistent bidder configuration')
    check(len(result['callbacks']) == len(result['expected']), 'Optional contextual data blocked an auction callback')
    check(len(result['auctionEnds']) == len(result['expected']), 'A native auction did not end')
    provider = result['providerName']
    scenario = result['scenario']
    if scenario['mode'] == 'rtd-activity-denied':
        check(any(item['denied'] for item in result['activityChecks']), 'RTD-only activity denial did not execute')
        check(len(result['guardedReads']) == len(result['expected']), 'Missing native guarded RTD read observation')
        check(all(not item['privateVisible'] and not item['eidVisible'] for item in result['guardedReads']),
              'Native RTD Proxy exposed user/EID fields denied to the provider')
    for expected in result['expected']:
        requests = [item for item in result['requested'] if item['auctionId'] == expected['auctionId']]
        check({item['bidder'] for item in requests} == set(ENDPOINTS.values()),
              f'Missing native bidder requests for {expected["auctionId"]}')
        for request in requests:
            bidder, ortb = request['bidder'], request['ortb2']
            ids = expected['routeIds'][bidder]
            check(own_ids(segments(ortb), provider) == ids, f'{bidder}: wrong auction-local adapter input')
            for item in own_data(segments(ortb), provider):
                check(item['ext']['segtax'] == (6 if expected['taxonomy'] == 'iab-content-2.2' else 7),
                      f'{bidder}: wrong segtax in adapter input')
            check(any(item.get('name') == 'existing-context.invalid' for item in segments(ortb)),
                  f'{bidder}: lost pre-existing contextual data')
            schain = ortb.get('source', {}).get('ext', {}).get('schain') or ortb.get('source', {}).get('schain')
            check(schain == result['schain'], f'{bidder}: changed SChain')
            check('native-22-' not in json.dumps(ortb.get('user', {})) and 'native-30-' not in json.dumps(ortb.get('user', {})),
                  f'{bidder}: contextual segments leaked into audience/user data')
            if bidder == 'openx':
                check(ortb.get('site', {}).get('content', {}).get('title') == 'existing-bidder-context',
                      'OpenX: lost existing bidder-scoped content')
                if scenario['mode'] != 'activity-denied':
                    check('bidder-private-marker' in json.dumps(ortb.get('user', {})), 'OpenX: lost bidder-permitted user FPD')
                    check('synthetic-existing-id' in json.dumps(ortb.get('user', {})), 'OpenX: lost bidder-permitted existing EID')
            if scenario['mode'] == 'activity-denied':
                check('existing-user-marker' not in json.dumps(ortb), f'{bidder}: native activity redaction bypassed')
    for bidder in ENDPOINTS.values():
        actual = [row for row in rows if row['bidder'] == bidder]
        check(len(actual) == len(result['expected']), f'{bidder}: expected one intercepted wire request per auction, got {len(actual)}')
        expected_sets = sorted(sorted(item['routeIds'][bidder]) for item in result['expected'])
        actual_sets = []
        for row in actual:
            payload = row['payload']
            if bidder == 'rubicon':
                # Banner adapter intentionally flattens supported IAB segment IDs. No segtax survives on wire.
                wire_ids = ','.join(payload.get('tg_i.iab', [])).split(',')
                actual_sets.append(sorted(value for value in wire_ids if value.startswith('native-')))
                if scenario['mode'] == 'mixed-rubicon':
                    check('foreign-other-taxonomy' in wire_ids, 'Rubicon lost pre-existing foreign taxonomy')
            elif bidder in SUPPORTED:
                data = segments(payload)
                actual_sets.append(sorted(own_ids(data, provider)))
                for item in own_data(data, provider):
                    check(item['ext']['segtax'] == (6 if scenario.get('taxonomy', 'iab-content-2.2') == 'iab-content-2.2' else 7),
                          f'{bidder}: wrong segtax serialized')
                check(any(item.get('name') == 'existing-context.invalid' for item in data),
                      f'{bidder}: existing context did not serialize')
                if bidder == 'connectad' and version == '11.11.0':
                    check(payload.get('sdc') == data, 'ConnectAd v2 sdc differs from site.content.data')
                if bidder == 'openx':
                    check(payload['site']['content'].get('title') == 'existing-bidder-context', 'OpenX lost existing title on wire')
                    if scenario['mode'] != 'activity-denied':
                        check('bidder-private-marker' in json.dumps(payload.get('user', {})), 'OpenX lost user FPD on wire')
                        check('synthetic-existing-id' in json.dumps(payload.get('user', {})), 'OpenX lost EID on wire')
            else:
                check(provider not in json.dumps(payload) and 'native-22-' not in json.dumps(payload) and 'native-30-' not in json.dumps(payload),
                      f'{bidder}: unsupported contextual route was attempted')
                actual_sets.append([])
            check('synthetic-seller' in json.dumps(payload), f'{bidder}: SChain missing on native wire')
            check('native-22-' not in json.dumps(payload.get('user', {})) and 'native-30-' not in json.dumps(payload.get('user', {})),
                  f'{bidder}: contextual IDs in user data on wire')
            if scenario['mode'] == 'activity-denied':
                check('existing-user-marker' not in json.dumps(payload), f'{bidder}: prohibited user data serialized')
        check(sorted(actual_sets) == expected_sets, f'{bidder}: wrong serialized route sets: {actual_sets}, expected {expected_sets}')
    if scenario['mode'] not in ['disabled', 'no-routes']:
        providers = result['realTimeData'].get('dataProviders', [])
        configured = [item for item in providers if item.get('name') == 'contextualSignals']
        check(len(configured) == 1 and configured[0].get('waitForIt') is False, 'Contextual provider must be synchronous/nonwaiting')
        check(len(result['providerCalls']) == len(result['expected']), 'Native RTD hook did not execute once per auction')


def run_version(playwright, version):
    destination = OUTPUT / version
    manifest = json.loads((destination / 'manifest.json').read_text())
    check(manifest['sourceCommit'] == PINS[version], 'Unpinned source commit')
    for path_key, hash_key in [('buildPath', 'buildSha256'), ('moduleSourcePath', 'moduleSourceSha256'),
                               ('runtimeSourcePath', 'runtimeSourceSha256'), ('browserRuntimePath', 'browserRuntimeSha256')]:
        check(digest(manifest[path_key]) == manifest[hash_key], f'Stale or modified input: {path_key}; rebuild before testing')
    prebid = Path(manifest['buildPath']).read_text()
    runtime = Path(manifest['browserRuntimePath']).read_text()
    fixture = (ROOT / 'tests/contextual-native/auction-fixture.js').read_text()
    cases = [{'name': 'taxonomy-6', 'mode': 'routed', 'taxonomy': 'iab-content-2.2'},
             {'name': 'taxonomy-7', 'mode': 'routed', 'taxonomy': 'iab-content-3.0'}]
    cases += [{'name': mode, 'mode': mode} for mode in MODES]
    results = []
    report = {'schemaVersion': 1, 'prebidVersion': version, 'sourceCommit': manifest['sourceCommit'],
              'buildSha256': manifest['buildSha256'], 'moduleContentSha256': manifest['moduleContentSha256'],
              'runtimeSourceSha256': manifest['runtimeSourceSha256'], 'playwrightVersion': importlib.metadata.version('playwright'),
              'fixtureSha256': hashlib.sha256(fixture.encode()).hexdigest(),
              'scope': 'Native Prebid core, real RTD bridge and unchanged SSP adapter serialization. Synthetic IDs and responses; every browser request intercepted. No SSP acceptance or revenue claim.',
              'cases': results}
    try:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
        report['browserVersion'] = browser.version
        for scenario in cases:
            context = browser.new_context(service_workers='block')
            page = context.new_page()
            rows, errors, blocked, parse_errors = [], [], [], []
            page.on('pageerror', lambda error: errors.append(str(error)))

            def route(intercepted):
                request = intercepted.request
                url = urlsplit(request.url)
                headers = {'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Credentials': 'true',
                           'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers', 'content-type'),
                           'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'}
                if request.url == ORIGIN + '/fixture':
                    intercepted.fulfill(status=200, content_type='text/html', body=HTML)
                elif url.hostname in ENDPOINTS:
                    if request.method != 'OPTIONS':
                        try:
                            rows.append(parse_request(request))
                        except Exception as error:
                            parse_errors.append(f'{url.hostname}: {type(error).__name__}: {error}')
                    intercepted.fulfill(status=204, headers=headers, body='')
                else:
                    blocked.append({'host': url.hostname, 'path': url.path})
                    intercepted.abort()

            context.route('**/*', route)
            result = None
            try:
                page.goto(ORIGIN + '/fixture')
                page.add_script_tag(content=prebid)
                page.add_script_tag(content=runtime)
                page.add_script_tag(content=fixture)
                result = page.evaluate('''scenario => Promise.race([
                    runContextualNativeCase(scenario),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Auction callback watchdog expired')), 8000))
                ])''', scenario)
                validate(result, rows, errors, blocked, parse_errors, version)
                results.append({'case': scenario['name'], 'passed': True, 'requests': len(rows),
                                'observation': result, 'wire': rows})
                print(f'PASS Prebid {version}: {scenario["name"]}', flush=True)
            except Exception as error:
                results.append({'case': scenario['name'], 'passed': False, 'error': str(error), 'observation': result,
                                'wire': rows, 'pageErrors': errors, 'blocked': blocked, 'parseErrors': parse_errors})
                print(f'FAIL Prebid {version}: {scenario["name"]}: {error}', flush=True)
            finally:
                context.close()
        browser.close()
    except Exception as error:
        report['setupError'] = str(error)
        print(f'BLOCKED Prebid {version}: native browser setup: {error}', flush=True)
    report['passed'] = bool(results) and len(results) == len(cases) and all(item['passed'] for item in results)
    (destination / 'wire-results.json').write_text(json.dumps(report, indent=2) + '\n')
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', choices=list(PINS))
    args = parser.parse_args()
    with sync_playwright() as playwright:
        outcomes = [run_version(playwright, version) for version in ([args.version] if args.version else PINS)]
    raise SystemExit(0 if all(outcomes) else 1)
