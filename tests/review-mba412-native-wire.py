#!/usr/bin/env python3
"""Independent alias/SChain native QA. Intercepts every request; never sends paid traffic."""
import argparse, hashlib, json, os, subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('ACCOUNTS_PREBID_ROOT', ROOT / '.generated/accounts-prebid')).resolve()
RUNTIME = Path(os.environ.get('ACCOUNTS_RUNTIME_ROOT', ROOT)).resolve()
PINS = {'11.11.0': '0f6ba177203d5f63e0a11453ed0c887fcf5efe33', '11.34.0': '195e0c6069928ed906bde550cb4e4183d1dc8474', '11.45.0': '4bd01c0c587b1047cfffe9da88dd7437d01197d3'}
ORIGIN = 'https://account-fixture.invalid'
NORMAL = ['baseline', 'repeat-configure', 'repeat-auction', 'concurrent', 'existing-alias', 'bidder-current', 'bidder-legacy-path', 'bidder-legacy-config', '11.45-replacement', 'late-merge-bidder-current', 'late-bidder-legacy-config', 'late-empty-config', 'late-option-only', 'late-bidder-current']
CONFLICTS = ['global-current', 'global-legacy-path', 'global-legacy-config', 'late-global-current', 'late-global-legacy-config', 'request-current', 'request-legacy-path']
MODES = NORMAL + CONFLICTS + ['alias-conflict', 'private-registry', 'private-alias-conflict', 'activity-denied', 'bid-current', 'guard-replaced', 'base-adapter-collision']
def check(ok, message):
    if not ok: raise AssertionError(message)
def schain(ortb):
    return ortb.get('source', {}).get('schain') or ortb.get('source', {}).get('ext', {}).get('schain')
def validate(result, wire, errors, mode):
    check(not errors, 'Uncaught browser errors: ' + str(errors))
    check(result['accounts'] == result['accountsAfter'], 'Helper mutated source account configuration')
    check(result['firstPartyBefore'] == result['firstPartyAfter'], 'Helper replaced firstPartyData options')
    check(len(result['callbacks']) == (2 if mode in ['concurrent', 'repeat-auction'] else 1), 'Missing or duplicate auction callback')
    if mode in NORMAL:
        check(result['globalBefore'] == result['globalAfter'], 'Helper mutated global publisher FPD')
        expected_count = 8 if mode in ['concurrent', 'repeat-auction'] else 4
        check(len(result['calls']) == expected_count, f'Expected {expected_count} native bidder requests, got {len(result["calls"])}')
        check(len(wire) == expected_count, f'Expected {expected_count} real Adform HTTP requests, got {len(wire)}')
    by_mid = {'999990': 'adf', '999991': 'adf_smn', '999992': 'adf_ag', '999993': 'adf_custom'}
    for request in result['calls']:
        code = request['bidder']
        expected = result['customChain'] if code == 'adf_custom' else None if code == 'adf_ag' else result['siteChain']
        for ortb in [request['ortb2']] + [b['ortb2'] for b in request['bids']]:
            check(schain(ortb) == expected, f'{mode}/{code}: wrong chain at native bidRequested: {schain(ortb)}')
            check(ortb.get('site', {}).get('content', {}).get('data') == [{'name':'qa.invalid','ext':{'segtax':6},'segment':[{'id':'synthetic-context'}]}], f'{mode}/{code}: contextual data lost')
            if code == 'adf_ag':
                check(ortb.get('site', {}).get('content', {}).get('title') == 'keep-bidder-title', 'Bidder-specific FPD lost')
    for body in wire:
        code = by_mid.get(str(body.get('imp', [{}])[0].get('tagid')))
        check(code is not None, 'Unknown placement/account serialization')
        expected = result['customChain'] if code == 'adf_custom' else None if code == 'adf_ag' else result['siteChain']
        check(schain(body) == expected, f'{mode}/{code}: wrong chain in actual Adform HTTP payload: {schain(body)}')
    if mode in ['alias-conflict', 'private-alias-conflict', 'activity-denied', 'bid-current']:
        check(not any(r['bidder'] == 'adf_ag' for r in result['calls']), f'{mode}: blocked alias reached bidder request')
    if mode == 'guard-replaced': check(not result['calls'], 'Replaced configuration guard must not pass bidder requests')
    if mode == 'base-adapter-collision': check(not any(r['bidder'] == 'pubmatic' for r in result['calls']), 'Base-adapter collision sent wrong account')
def run(pw, version, helper):
    dest = OUT / version
    manifest = json.loads((dest / 'manifest.json').read_text())
    check(manifest['sourceCommit'] == PINS[version], 'Unpinned Prebid build')
    prebid = Path(manifest['buildPath']).read_text()
    check(hashlib.sha256(prebid.encode()).hexdigest() == manifest['buildSha256'], 'Prebid build hash mismatch')
    fixture = (ROOT / 'tests/review-mba412-native-fixture.js').read_text()
    results = []
    report = {'version': version, 'buildSha256': manifest['buildSha256'], 'helperSha256': hashlib.sha256(helper.encode()).hexdigest(), 'cases': results,
              'scope': 'Native Prebid and Adform HTTP serialization with synthetic IDs and intercepted204 responses; not SSP receipt/acceptance.'}
    try:
        browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
        report['browserVersion'] = browser.version
        for mode in MODES:
            context = browser.new_context(service_workers='block')
            page = context.new_page(); wire=[]; errors=[]; other=[]
            page.on('pageerror', lambda e: errors.append(str(e)))
            def route(r):
                req=r.request
                if req.url == ORIGIN + '/fixture': r.fulfill(status=200, content_type='text/html', body='<!doctype html><html><body>Native account QA</body></html>')
                elif urlsplit(req.url).hostname == 'adx.adform.net':
                    if req.method == 'POST': wire.append(json.loads(req.post_data))
                    r.fulfill(status=204, headers={'Access-Control-Allow-Origin':ORIGIN, 'Access-Control-Allow-Credentials':'true', 'Access-Control-Allow-Headers':'content-type', 'Access-Control-Allow-Methods':'POST,OPTIONS'}, body='')
                else:
                    other.append(req.url); r.abort()
            context.route('**/*', route); result=None
            try:
                page.goto(ORIGIN + '/fixture'); page.add_script_tag(content=prebid); page.add_script_tag(content=helper); page.add_script_tag(content=fixture)
                result=page.evaluate('s => runAccountNativeCase(s)', {'mode':mode})
                validate(result,wire,errors,mode)
                results.append({'case':mode,'passed':True,'observation':result,'wire':wire,'blockedOther':other})
                print(f'PASS {version} {mode}',flush=True)
            except Exception as e:
                results.append({'case':mode,'passed':False,'error':str(e),'observation':result,'wire':wire,'pageErrors':errors,'blockedOther':other})
                print(f'FAIL {version} {mode}: {e}',flush=True)
            finally: context.close()
        browser.close()
    except Exception as e:
        report['setupError']=str(e); print(f'BLOCKED {version}: {e}',flush=True)
    report['passed']=len(results)==len(MODES) and all(c['passed'] for c in results)
    (dest / 'account-wire-results.json').write_text(json.dumps(report,indent=2)+'\n')
    return report['passed']
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--version',choices=PINS);args=parser.parse_args()
    module=RUNTIME/'shared/bidder-accounts/browser.mjs'
    helper=subprocess.check_output(['node','--input-type=module','-e',"const {createBidderAccounts}=await import(process.argv[1]); process.stdout.write('window.createBidderAccounts = '+createBidderAccounts.toString()+';');",module.as_uri()],text=True)
    with sync_playwright() as pw: outcomes=[run(pw,v,helper) for v in ([args.version] if args.version else PINS)]
    raise SystemExit(0 if all(outcomes) else 1)
