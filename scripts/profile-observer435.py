"""Matched native control/fixed ReportingObserver pair; API remains available in both.

Run only in a coordinator-approved quiet browser window. This is a synthetic
fixture result, not a publisher memory budget or a revenue measurement.
"""
import argparse
from datetime import datetime, timezone, timedelta
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.parse


ROOT = Path(__file__).resolve().parent.parent
VERSION = '11.34.0'
ORIGIN = 'https://retention430.example.invalid'


def open_page(harness, browser, fixtures):
    """Pin the navigated page clock before loading either tested build script."""
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, service_workers='block', timezone_id='UTC')
    page = context.new_page()
    errors, escaped = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    folder = fixtures / VERSION / 'long-on'
    def route(request):
        url = request.request.url
        if url == ORIGIN + '/page':
            request.fulfill(content_type='text/html', body='<!doctype html><html><head></head><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div></body></html>')
        elif url in (ORIGIN + '/prebid.js', ORIGIN + '/ads.min.js'):
            request.fulfill(content_type='application/javascript', body=(folder / url.rsplit('/', 1)[1]).read_bytes())
        elif url.startswith(ORIGIN + '/bid?'):
            rows = json.loads(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['payload'][0])
            bids = [{**row, 'mediaType': 'banner', 'creativeId': 'synthetic', 'currency': 'EUR', 'netRevenue': True,
                     'ad': '<div data-retention430-creative>Retention430 synthetic creative</div>',
                     'meta': {'advertiserDomains': ['example.invalid']}} for row in rows]
            request.fulfill(content_type='application/json', body=json.dumps({'bids': bids}))
        elif url == 'https://prebid-professor.mbaucal.workers.dev/geo/v1/country':
            request.fulfill(content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps({'known': True, 'country': 'RS', 'source': 'synthetic'}))
        elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
            request.fulfill(content_type='application/json', headers={'access-control-allow-origin': '*'}, body=json.dumps({'conversions': {'EUR': {'EUR': 1, 'USD': 1}, 'USD': {'EUR': 1, 'USD': 1}}}))
        else:
            escaped.append(url)
            request.abort()
    context.route('**/*', route)
    options = {'policy': harness.POLICIES['bounded'], 'bidTTL': 120, 'ttlBuffer': None,
               'suppressExpiredRender': None, 'autoRender': True, 'renderDelayMs': 8000, 'bidUrl': ORIGIN + '/bid'}
    fixture = (harness.ROOT / 'tests/runtime/retention430-browser-fixture.js').read_text()
    page.add_init_script('window.__retention430Options=' + json.dumps(options) + ';\n' + fixture)
    page.goto(ORIGIN + '/page')
    # Installing before navigation allowed a host-time offset in the new document.
    # Both exact scripts load only after this common clock is installed and paused.
    page.clock.install(time=harness.NOW)
    page.clock.pause_at(harness.NOW + timedelta(seconds=1))
    epoch = int((harness.NOW + timedelta(seconds=1)).timestamp() * 1000)
    initial = page.evaluate('({at:Date.now(),gam:__retention430.counts.gam,bidders:__retention430.counts.bidder})')
    assert initial == {'at': epoch, 'gam': 0, 'bidders': 0}, ('Non-deterministic pre-auction epoch', initial)
    page.add_script_tag(url=ORIGIN + '/prebid.js')
    page.add_script_tag(url=ORIGIN + '/ads.min.js')
    assert page.evaluate('Date.now()') == epoch, 'Clock moved while loading tested scripts'
    harness.settle(page)
    for key, expected in harness.POLICIES['bounded'].items():
        assert page.evaluate('(key)=>pbjs.getConfig(key)', key) == expected, ('Bounded policy overwritten', key)
    for milliseconds in [100, 100, 8250]:
        harness.tick(page, milliseconds)
    client = context.new_cdp_session(page)
    client.send('Performance.enable')
    assert page.evaluate('pbjs.version') == 'v' + VERSION
    return context, page, client, errors, escaped, initial


def run_case(harness, pair, browser, fixtures, out):
    """One explicit common clock program; missing native progress fails, never adapts."""
    commands, samples = [], []
    facade = pair.BrowserFacade(browser, False, commands)
    result = {'passed': False, 'reportingObserverDisabled': False, 'clockRunForMs': commands, 'samples': samples}
    dispatch_count, wire_count = Counter(), Counter()
    gam_ids, submitted_ids, bidder_ids = set(), set(), set()
    cpms = {code: [] for code in ['Billboard', 'P1']}
    page = None
    try:
        context, page, client, errors, escaped, initial = open_page(harness, facade, fixtures)
        result.update(errors=errors, blockedUnexpectedRequests=escaped, commonInitialState=initial)
        def sample(number):
            row = page.evaluate(harness.COLLECT)
            for dispatch in row.pop('dispatches'):
                identity = (dispatch['code'], dispatch['at'])
                assert identity not in gam_ids, ('Duplicate GAM', identity)
                gam_ids.add(identity)
                dispatch_count[dispatch['code']] += 1
                assert dispatch['bidId'] and dispatch['bidCode'] == dispatch['code'], dispatch
                cpms[dispatch['code']].append(dispatch['cpm'])
                for value in {v for values in dispatch['targets'].values() for v in values}:
                    identity = (dispatch['code'], value)
                    assert identity not in submitted_ids, ('Submitted adId resent', identity)
                    submitted_ids.add(identity)
            for wire in row.pop('wire'):
                identity = (wire['bidder'], wire['code'], wire['round'])
                assert identity not in bidder_ids, ('Duplicate bidder request', identity)
                bidder_ids.add(identity)
                wire_count[wire['bidder'] + ':' + wire['code']] += 1
            renders = row.pop('renders')
            assert not [event for event in renders if event['kind'] in ['expiredRender', 'adRenderFailed']], renders
            assert row['cache']['status'] == 'active', row['cache']
            assert row['cache']['trackedAuctions'] <= 64 and row['cache']['trackedBids'] <= 512
            for key, expected in harness.POLICIES['bounded'].items():
                assert row['settings'][key] == expected, ('Bounded policy overwritten at checkpoint', number, key)
            assert row['pendingRenders'] == 0, row
            assert row['counts']['gam'] == row['counts']['rendered'] == number * 2, ('Missing or extra native opportunity', number, row)
            row.update(opportunity=number, dispatchesByCode=dict(dispatch_count), wireByCode=dict(wire_count))
            if number in [1, 5, 10, 20]:
                row['realms'] = pair.realm_status(page, False)
                client.send('HeapProfiler.collectGarbage')
                row['heapAfterGC'] = client.send('Runtime.getHeapUsage')
                row['dom'] = client.send('Memory.getDOMCounters')
            samples.append(row)
        harness.tick(page, 1050)
        sample(1)
        for number in range(2, 21):
            # These fixed inputs come from the retained control clock trace.
            # No count-dependent clock advancement or lastDispatchAt adjustment.
            for milliseconds in [20400] + [100] * (68 if number == 2 else 6) + [7950, 1050]:
                harness.tick(page, milliseconds)
            sample(number)
        final = samples[-1]
        assert final['counts']['renderFailed'] == final['counts']['expired'] == 0
        assert len(wire_count) == 4 and all(value == 20 for value in wire_count.values())
        assert len(dispatch_count) == 2 and all(value == 20 for value in dispatch_count.values())
        expected = [[10, 4, 2, 12][number % 4] for number in range(20)]
        assert all(values == expected for values in cpms.values()), cpms
        assert not errors and not escaped, (errors, escaped)
        result.update(passed=True, primaryCpmSequence=cpms, final=final, afterWarmup=samples[4],
                      clockRunForCount=len(commands), virtualElapsedMs=final['at'] - samples[0]['at'])
    except Exception as error:
        import traceback
        result.update(error=repr(error), traceback=traceback.format_exc())
    finally:
        facade.close_contexts()
        (out / 'case.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def compare(rows):
    assert len(rows) == 2 and all(row['passed'] for row in rows), 'Incomplete native pair'
    control, fixed = rows
    checks = {
        'exactClockCommands': control['clockRunForMs'] == fixed['clockRunForMs'],
        'exactVirtualDuration': control['virtualElapsedMs'] == fixed['virtualElapsedMs'],
        'sameCpmSequence': control['primaryCpmSequence'] == fixed['primaryCpmSequence'],
        'sameNativeCounters': control['final']['counts'] == fixed['final']['counts'],
        'sameDemandRounds': control['final']['rounds'] == fixed['final']['rounds'],
        'sameAppliedPolicy': control['final']['settings'] == fixed['final']['settings'],
        'samePreAuctionEpoch': control['commonInitialState'] == fixed['commonInitialState'],
        'sameSampleTimes': [sample['at'] for sample in control['samples']] == [sample['at'] for sample in fixed['samples']],
        'observerAvailableBoth': all(not row['reportingObserverDisabled'] and all(
            realm['availableNow'] and realm['probe']['originalAvailable']
            for sample in row['samples'] if 'realms' in sample for realm in sample['realms']) for row in rows),
    }
    measurements = {}
    getters = {'documents': lambda sample: sample['dom']['documents'],
               'nodes': lambda sample: sample['dom']['nodes'],
               'listeners': lambda sample: sample['dom']['jsEventListeners'],
               'usedHeapBytes': lambda sample: sample['heapAfterGC']['usedSize']}
    for key, get in getters.items():
        measurements[key] = {'controlFinal': get(control['final']), 'fixedFinal': get(fixed['final']),
                             'controlGrowthAfterWarmup': get(control['final']) - get(control['afterWarmup']),
                             'fixedGrowthAfterWarmup': get(fixed['final']) - get(fixed['afterWarmup'])}
    fixed_document_samples = [sample['dom']['documents'] for sample in fixed['samples']
                              if 'dom' in sample and sample['opportunity'] >= 5]
    checks['controlReproducesDocumentRetention'] = measurements['documents']['controlGrowthAfterWarmup'] > 12
    checks['fixedDocumentPlateau'] = max(fixed_document_samples) - min(fixed_document_samples) <= 4
    return {'matched': all(checks.values()), 'checks': checks, 'measurements': measurements,
            'documentPlateauFixtureAllowance': 4,
            'limits': 'Single pinned synthetic native pair; whole-page post-GC counts include fixture/browser effects. No production memory or revenue conclusion.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', type=Path, required=True)
    parser.add_argument('--fixed', type=Path, required=True)
    parser.add_argument('--harness-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    assert not out.exists() or not any(out.iterdir()), 'Use an empty receipt directory'
    out.mkdir(parents=True, exist_ok=True)
    harness_root = args.harness_root.resolve()
    pins = {str(Path(__file__).resolve()): sha(Path(__file__).resolve())}
    for relative in ['scripts/profile-retention430.py', 'scripts/profile-retention430-observer.py',
                     'scripts/retention430_metrics.py', 'tests/runtime/retention430-browser-fixture.js']:
        path = harness_root / relative
        pins[str(path)] = sha(path)
    sys.path.insert(0, str(harness_root / 'scripts'))
    harness = module('observer435_native_harness', harness_root / 'scripts/profile-retention430.py')
    pair = module('observer435_scalar_probe', harness_root / 'scripts/profile-retention430-observer.py')
    manifests, fixtures = {}, {}
    for label in ['control', 'fixed']:
        fixture = getattr(args, label).resolve()
        manifest_path = fixture / 'manifest.json'
        pins[str(manifest_path)] = sha(manifest_path)
        manifest = json.loads(manifest_path.read_text())
        for name, expected in manifest['files'].items():
            assert sha(fixture / name) == expected, ('Changed generated fixture', label, name)
            pins[str(fixture / name)] = expected
        manifests[label], fixtures[label] = manifest, fixture
    assert manifests['control']['runtime'] == manifests['fixed']['runtime']
    assert manifests['control']['versions'][VERSION]['modules'] == manifests['fixed']['versions'][VERSION]['modules']
    for package in ['long-on', 'long-off', 'static-on', 'static-off', 'cap20-on', 'cap20-off']:
        assert sha(fixtures['control'] / VERSION / package / 'ads.min.js') == sha(fixtures['fixed'] / VERSION / package / 'ads.min.js'), 'Frozen ads.js changed'
    report = {'kind': 'observer435-control-fixed-native-pair', 'startedAtUTC': datetime.now(timezone.utc).isoformat(),
              'hostLoadAtStart': list(os.getloadavg()), 'inputSha256': pins, 'passed': False, 'cases': []}
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
            try:
                assert browser.version == '140.0.7339.16', browser.version
                report['browser'] = browser.version
                for label in ['control', 'fixed']:
                    case_out = out / label
                    case_out.mkdir()
                    # False leaves the real ReportingObserver API untouched in every realm.
                    row = run_case(harness, pair, browser, fixtures[label], case_out)
                    row['buildVariant'] = label
                    report['cases'].append(row)
                    if not row['passed']:
                        break
            finally:
                browser.close()
        report['comparison'] = compare(report['cases'])
        report['passed'] = report['comparison']['matched']
    except Exception as error:
        import traceback
        report.update(error=repr(error), traceback=traceback.format_exc())
    finally:
        report['inputsUnchanged'] = all(Path(path).is_file() and sha(Path(path)) == expected for path, expected in pins.items())
        report['passed'] = report['passed'] and report['inputsUnchanged']
        report['hostLoadAtEnd'] = list(os.getloadavg())
        report['completedAtUTC'] = datetime.now(timezone.utc).isoformat()
        (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'passed': report['passed'], 'summary': str(out / 'summary.json'), 'comparison': report.get('comparison')}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
