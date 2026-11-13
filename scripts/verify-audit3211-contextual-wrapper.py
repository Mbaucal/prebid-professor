"""Full generated 3.21.1 wrapper + native Prebid RTD/TCF + synthetic CMP/GPT.

Every browser request is intercepted; no live ad traffic or SSP acceptance claim.
Native first-provider ownership is tested through complete generated wrappers,
not by calling the contextual helper directly.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
NATIVE = Path(os.environ.get('CONTEXTUAL_PREBID_ROOT', ROOT / '.generated/contextual-prebid')).resolve()
FIXTURES = ROOT / '.generated/audit3211-wrapper'
ORIGIN = 'https://wrapper-audit.invalid'
HTML = '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:3200px"></div><div id="P1" class="wrapperAd" style="height:250px"></div></body></html>'
PINS = {'11.11.0': '0f6ba177203d5f63e0a11453ed0c887fcf5efe33', '11.34.0': '195e0c6069928ed906bde550cb4e4183d1dc8474'}


def require(value, message):
    if not value:
        raise AssertionError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def data_ids(payload, name):
    return [str(segment['id']) for row in payload.get('site', {}).get('content', {}).get('data', [])
            if row.get('name') == name for segment in row.get('segment', [])]


def validate(observation, wire, errors, unexpected, version, mode):
    require(not errors, f'Browser errors: {errors}')
    require(not unexpected, f'Unexpected intercepted network: {unexpected}')
    require(observation['nativePrebidVersion'].lstrip('v') == version, 'Wrong native version')
    require({'rtdModule', 'consentManagementTcf', 'contextualSignalsRtdProvider', 'contextualAuditRtdProvider'}
            .issubset(observation['installedModules']), 'Native RTD/TCF/provider module missing')
    require(not observation['privacy'], 'Wrapper forced GPT privacy settings')
    require(len(observation['auctions']) == len(observation['completed']) == 2, 'Expected exactly two completed native auctions')
    require(len(observation['requested']) == len(wire) == 2, 'Expected one native ConnectAd request per position')
    require([row['id'] for row in observation['sent']] == ['Billboard', 'P1'], 'GAM fallback missing or duplicated')
    require(all(row['bannerSizes'] == [[[300, 250]]] for row in observation['requested']),
            'Unmatched conditional rule replaced the real prefixed Prebid map')
    for row in observation['sent']:
        mapping = sorted(row['mapping'], key=lambda item: item['viewport'][0], reverse=True)
        selected = next(item['sizes'] for item in mapping if item['viewport'][0] <= 1280 and item['viewport'][1] <= 800)
        require(selected == [[300, 250]], 'Unmatched conditional rule replaced the real prefixed GPT map')
    for request in wire:
        if version == '11.11.0':
            formats = [tuple(size) for placement in request.get('placements', []) for size in placement.get('sizes', [])]
        else:
            formats = [(item['w'], item['h']) for impression in request.get('imp', [])
                       for item in impression.get('banner', {}).get('format', [])]
        require(formats == [(300, 250)], f'Native adapter serialized incorrect prefixed map sizes: {formats}')
    require([row['pps']['taxonomies']['IAB_CONTENT_2_2']['values'] for row in observation['sent']] == [['483'], ['42']],
            'Generated request/completion/GPT PPS lost the captured page category')
    require(all(row['consent']['ready'] for row in observation['sent']), 'GAM dispatched while consent unknown')
    expected = [[], []] if mode == 'publisher-first' else [['483'], ['42']]
    require([data_ids(row['ortb2'], 'wrapper-audit.invalid') for row in observation['requested']] == expected,
            'Wrong contextual signal at real adapter input')
    require([data_ids(row, 'wrapper-audit.invalid') for row in wire] == expected,
            'Wrong contextual signal in real serialized ConnectAd request')
    require(all(data_ids(row, 'existing-context.invalid') == ['preserved'] for row in wire), 'Lost publisher contextual data')
    require(all('synthetic' in json.dumps(row.get('source', {})) for row in wire), 'Lost SChain on wire')
    require(all(row['gdprConsent'].get('gdprApplies') is False for row in observation['requested']),
            'Native TCF module did not propagate the explicit CMP scope')
    require(observation['publisherProviderCalls'] == (0 if mode == 'baseline' else 2), 'Publisher RTD hook stopped or duplicated')
    snapshot = observation['snapshot']
    if mode == 'publisher-first':
        require(observation['finalRtd'] == observation['initialRtd'], 'Wrapper rewrote publisher-owned native RTD config')
        require(snapshot['rtd']['status'] == 'rtd-config-preexisting' and not snapshot['providerRegistered'],
                'Missing native contextual provider was not diagnosed accurately')
        require(any(event['kind'] == 'rtd-config-preexisting' for event in snapshot['events']), 'No actionable RTD diagnostic')
    else:
        require(snapshot['providerRegistered'] and snapshot['rtd']['providerObserved'], 'Native contextual provider never ran')
        require(snapshot['rtd']['status'] == 'configured', 'Successful native integration was incorrectly diagnosed')


def run(playwright, version):
    native = json.loads((NATIVE / version / 'manifest.json').read_text())
    generated = json.loads((FIXTURES / 'manifest.json').read_text())
    require(native['sourceCommit'] == PINS[version], 'Unexpected native source pin')
    for path, checksum in [('buildPath', 'buildSha256'), ('runtimeSourcePath', 'runtimeSourceSha256')]:
        require(digest(native[path]) == native[checksum], f'Stale native input {path}')
    require(generated['contextualSourceSha256'] == native['runtimeSourceSha256'], 'Full wrapper and native helper source differ')
    for name, checksum in generated['files'].items():
        require(digest(FIXTURES / name) == checksum, f'Modified generated wrapper {name}')
    cases = []
    report = {'schemaVersion': 1, 'runtimeVersion': '3.21.1', 'prebidVersion': version,
              'nativeBuildSha256': native['buildSha256'], 'wrapperFiles': generated['files'], 'cases': cases,
              'scope': 'Full generated wrapper, native RTD and TCF modules, unchanged ConnectAd adapter serialization, synthetic CMP and GPT. All requests intercepted. No live SSP/GAM-server or revenue claim.'}
    try:
        browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
        report['browserVersion'] = browser.version
        for name in ['ads.js', 'ads.min.js']:
            for mode in ['baseline', 'publisher-first', 'combined-first']:
                context = browser.new_context(viewport={'width': 1280, 'height': 800}, service_workers='block')
                page = context.new_page()
                errors, unexpected, wire = [], [], []
                page.on('pageerror', lambda error: errors.append(str(error)))

                def intercept(route):
                    request = route.request
                    url = urlsplit(request.url)
                    headers = {'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Credentials': 'true',
                               'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers', 'content-type'),
                               'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'}
                    if request.url == ORIGIN + '/':
                        route.fulfill(status=200, content_type='text/html', body=HTML)
                    elif url.hostname == 'i.connectad.io':
                        if request.method != 'OPTIONS':
                            try:
                                body = request.post_data_buffer or b'{}'
                                wire.append(json.loads(gzip.decompress(body) if body[:2] == b'\x1f\x8b' else body))
                            except Exception as error:
                                errors.append('Native request parsing: ' + str(error))
                        route.fulfill(status=204, headers=headers, body='')
                    elif url.hostname in ['prebid-professor.mbaucal.workers.dev', 'prebid-professor-test.mbaucal.workers.dev'] and url.path == '/geo/v1/country':
                        route.fulfill(status=200, content_type='application/json', headers=headers,
                                      body=json.dumps({'version': 1, 'status': 'known', 'country': 'RS', 'source': 'cloudflare'}))
                    else:
                        unexpected.append({'host': url.hostname, 'path': url.path})
                        route.abort()

                context.route('**/*', intercept)
                observation = None
                try:
                    page.goto(ORIGIN + '/')
                    page.add_script_tag(content=(ROOT / 'tests/runtime/mock-ad-libraries.js').read_text())
                    page.add_script_tag(content=(ROOT / 'tests/contextual-native/wrapper-setup.js').read_text())
                    page.evaluate('delete window.pbjs')
                    page.add_script_tag(content=Path(native['buildPath']).read_text())
                    page.evaluate('prepareWrapperPrebidAudit', mode)
                    page.evaluate("__emitWrapperConsent({cmpStatus:'loaded',eventStatus:'tcloaded'})")
                    page.add_script_tag(content=(FIXTURES / name).read_text())
                    # Past the normal missing-Prebid fallback: unknown scope must
                    # not become permission while optional RTD setup executes.
                    page.wait_for_timeout(3200)
                    require(page.evaluate('__wrapperAudit.auctions.length === 0 && __wrapperAudit.sent.length === 0'),
                            'Unknown CMP scope allowed an auction or GAM request')
                    page.evaluate("__emitWrapperConsent({gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'})")
                    page.wait_for_function('__wrapperAudit.sent.some(row => row.id === "Billboard")', timeout=8000)
                    page.evaluate("adsKeywords.category='Books'; document.getElementById('P1').scrollIntoView()")
                    page.wait_for_function('__wrapperAudit.sent.some(row => row.id === "P1")', timeout=8000)
                    page.wait_for_timeout(100)
                    observation = page.evaluate('wrapperAuditResult()')
                    validate(observation, wire, errors, unexpected, version, mode)
                    cases.append({'case': f'{name}/{mode}', 'passed': True, 'observation': observation, 'wire': wire})
                    print(f'PASS wrapper 3.21.1/native {version}: {name}/{mode}', flush=True)
                except Exception as error:
                    if observation is None:
                        try:
                            observation = page.evaluate('window.wrapperAuditResult?.() || window.__wrapperAudit || null')
                        except Exception:
                            pass
                    cases.append({'case': f'{name}/{mode}', 'passed': False, 'error': str(error), 'observation': observation,
                                  'wire': wire, 'pageErrors': errors, 'unexpectedNetwork': unexpected})
                    print(f'FAIL wrapper 3.21.1/native {version}: {name}/{mode}: {error}', flush=True)
                finally:
                    context.close()
        browser.close()
    except Exception as error:
        report['setupError'] = str(error)
    report['passed'] = len(cases) == 6 and all(case['passed'] for case in cases)
    (NATIVE / version / 'wrapper-results.json').write_text(json.dumps(report, indent=2) + '\n')
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', choices=list(PINS))
    args = parser.parse_args()
    with sync_playwright() as playwright:
        outcomes = [run(playwright, version) for version in ([args.version] if args.version else PINS)]
    raise SystemExit(0 if all(outcomes) else 1)
