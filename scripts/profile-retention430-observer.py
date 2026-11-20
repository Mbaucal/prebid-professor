"""One isolated ReportingObserver availability pair for the sealed MBA-430 fixture.

This is a causal diagnostic of the synthetic native display-render path, not a
production patch or a memory budget. Run only after the shared quiet window.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import traceback


ROOT = Path(__file__).resolve().parent.parent
VERSION, LABEL, OPPORTUNITIES, WARMUP = '11.34.0', 'long-on', 20, 5
HARNESS_FILES = (
    'scripts/prepare-retention430-fixtures.mjs', 'scripts/profile-retention430.py',
    'scripts/retention430_metrics.py', 'tests/runtime/retention430-browser-fixture.js',
)
SCOPE = ('One local synthetic native Prebid11.34 display-render pair; bounded0/0/120 '
         'and cache ON. No paid traffic, production change, CPU benchmark or '
         'exclusive Prebid retained-byte measurement.')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def observer_prefix(disabled):
    # Neither branch stores a constructor, observer, document or window reference.
    # A context init script runs before scripts in every new child realm too.
    return """(() => {
      const requestedDisabled = DISABLED;
      const originalAvailable = 'ReportingObserver' in globalThis;
      let deleteSucceeded = null;
      if (requestedDisabled) {
        try { deleteSucceeded = delete globalThis.ReportingObserver; }
        catch (_) { deleteSucceeded = false; }
      }
      Object.defineProperty(globalThis, '__retention430ObserverProbe', {
        value: Object.freeze({requestedDisabled, originalAvailable, deleteSucceeded,
          availableAfterInit: 'ReportingObserver' in globalThis})
      });
    })();""".replace('DISABLED', 'true' if disabled else 'false')


class ClockFacade:
    def __init__(self, clock, commands):
        self.clock, self.commands = clock, commands

    def run_for(self, milliseconds):
        self.commands.append(milliseconds)
        return self.clock.run_for(milliseconds)

    def __getattr__(self, name):
        return getattr(self.clock, name)


class PageFacade:
    def __init__(self, page, commands):
        self.native_page = page
        self.clock = ClockFacade(page.clock, commands)

    def __getattr__(self, name):
        return getattr(self.native_page, name)


class ContextFacade:
    def __init__(self, context, commands):
        self.context, self.commands = context, commands

    def new_page(self):
        return PageFacade(self.context.new_page(), self.commands)

    def new_cdp_session(self, page):
        return self.context.new_cdp_session(page.native_page)

    def __getattr__(self, name):
        return getattr(self.context, name)


class BrowserFacade:
    def __init__(self, browser, disabled, commands):
        self.browser, self.disabled, self.commands = browser, disabled, commands
        self.contexts = []

    def new_context(self, **kwargs):
        context = self.browser.new_context(**kwargs)
        self.contexts.append(context)
        context.add_init_script(observer_prefix(self.disabled))
        return ContextFacade(context, self.commands)

    def close_contexts(self):
        for context in self.contexts:
            context.close()
        self.contexts.clear()


def realm_status(page, disabled):
    # Only detached scalar results leave evaluate; no page handles are retained.
    rows = [frame.evaluate("""() => ({url:location.href,
      probe:globalThis.__retention430ObserverProbe || null,
      availableNow:'ReportingObserver' in globalThis,
      nativeRenderer:typeof globalThis.render === 'function'})""")
      for frame in page.frames]
    assert rows and any(row['nativeRenderer'] for row in rows), 'Native renderer realm missing'
    for row in rows:
        probe = row['probe']
        assert probe and probe['originalAvailable'], ('Original observer API/marker missing', row)
        assert probe['requestedDisabled'] is disabled, ('Wrong observer branch', row)
        assert probe['availableAfterInit'] is (not disabled), ('Init did not isolate API', row)
        assert row['availableNow'] is (not disabled), ('Observer API restored or unexpectedly absent', row)
    return rows


def run_case(harness, browser, manifest, fixtures, out, disabled):
    name = 'observer-disabled' if disabled else 'observer-available'
    commands, samples = [], []
    facade = BrowserFacade(browser, disabled, commands)
    result = {'case': name, 'passed': False, 'reportingObserverDisabled': disabled,
              'clockRunForMs': commands, 'samples': samples}
    dispatch_count, wire_count = Counter(), Counter()
    gam_ids, submitted_ids, bidder_ids = set(), set(), set()
    cpms = {code: [] for code in ['Billboard', 'P1']}
    peak_rows = 0
    context = page = client = None
    try:
        context, page, client, errors, escaped = harness.open_page(
            facade, manifest, fixtures, VERSION, LABEL, harness.POLICIES['bounded'])
        result.update(errors=errors, blockedUnexpectedRequests=escaped)
        def sample(number, gc=False):
            nonlocal peak_rows
            row = page.evaluate(harness.COLLECT)
            peak_rows = max(peak_rows, sum(len(row[key]) for key in ['dispatches', 'wire', 'renders']))
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
            assert not [r for r in renders if r['kind'] in ['expiredRender', 'adRenderFailed']], renders
            assert row['cache']['status'] == 'active', row['cache']
            assert row['cache']['trackedAuctions'] <= 64 and row['cache']['trackedBids'] <= 512
            assert row['pendingRenders'] == 0, row
            row.update(opportunity=number, dispatchesByCode=dict(dispatch_count), wireByCode=dict(wire_count))
            if gc:
                row['realms'] = realm_status(page, disabled)
                client.send('HeapProfiler.collectGarbage')
                row['heapAfterGC'] = client.send('Runtime.getHeapUsage')
                row['dom'] = client.send('Memory.getDOMCounters')
            samples.append(row)
            return row

        # Both branches execute the identical extra 1.05s visibility-timer drain.
        # Exact clock-command equality is checked before causal interpretation.
        harness.tick(page, 1050)
        sample(1, gc=True)
        for number in range(2, OPPORTUNITIES + 1):
            harness.next_opportunity(page, number)
            harness.tick(page, 1050)
            sample(number, gc=number in [WARMUP, 10, OPPORTUNITIES])
        final = samples[-1]
        assert final['counts']['gam'] == final['counts']['rendered'] == OPPORTUNITIES * 2
        assert final['counts']['renderFailed'] == final['counts']['expired'] == 0
        assert len(wire_count) == 4 and all(n == OPPORTUNITIES for n in wire_count.values())
        assert all(n == OPPORTUNITIES for n in dispatch_count.values()) and len(dispatch_count) == 2
        expected = [[10, 4, 2, 12][n % 4] for n in range(OPPORTUNITIES)]
        assert all(values == expected for values in cpms.values()), cpms
        assert not errors and not escaped, (errors, escaped)
        result.update(passed=True, primaryCpmSequence=cpms, fixturePeakQueuedScalarRows=peak_rows,
                      final=final, afterWarmup=samples[WARMUP - 1], clockRunForCount=len(commands),
                      virtualElapsedMs=final['at'] - samples[0]['at'])
    except Exception as error:
        result.update(error=repr(error), traceback=traceback.format_exc())
        if page is not None:
            try:
                result['failureObservation'] = page.evaluate(harness.COLLECT)
            except Exception as observation_error:
                result['observationError'] = repr(observation_error)
    finally:
        # Also close contexts created before open_page could return successfully.
        try:
            facade.close_contexts()
        except Exception as close_error:
            result.update(passed=False, contextCloseError=repr(close_error))
        write_json(out / (name + '.json'), result)
    return result


def compare(cases):
    assert len(cases) == 2 and all(row['passed'] for row in cases), 'Incomplete pair'
    available, disabled = cases
    checks = {
        'exactClockCommandSequence': available['clockRunForMs'] == disabled['clockRunForMs'],
        'exactVirtualDuration': available['virtualElapsedMs'] == disabled['virtualElapsedMs'],
        'sameCpmSequence': available['primaryCpmSequence'] == disabled['primaryCpmSequence'],
        'sameNativeCounters': available['final']['counts'] == disabled['final']['counts'],
        'sameDemandRounds': available['final']['rounds'] == disabled['final']['rounds'],
        'sameAppliedPolicy': available['final']['settings'] == disabled['final']['settings'],
    }
    changes = {}
    for key, getter in [('documents', lambda s: s['dom']['documents']),
                        ('nodes', lambda s: s['dom']['nodes']),
                        ('listeners', lambda s: s['dom']['jsEventListeners']),
                        ('usedHeapBytes', lambda s: s['heapAfterGC']['usedSize'])]:
        a, b = [getter(row['final']) for row in cases]
        growth = [getter(row['final']) - getter(row['afterWarmup']) for row in cases]
        changes[key] = {'availableFinal': a, 'disabledFinal': b, 'disabledMinusAvailable': b - a,
                        'availableGrowthAfterWarmup': growth[0], 'disabledGrowthAfterWarmup': growth[1]}
    return {'matched': all(checks.values()), 'checks': checks, 'postGCDifferences': changes,
            'interpretation': ('Observed availability-only fixture effect; inspect direction and size. '
                               'No effect is also a valid result; this does not establish a production regression.'
                               if all(checks.values()) else
                               'Unmatched pair: do not attribute memory differences to ReportingObserver.')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixtures', type=Path)
    parser.add_argument('--harness-root', type=Path, default=ROOT)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out, fixtures, harness_root = args.out.resolve(), args.fixtures.resolve(), args.harness_root.resolve()
    assert not out.exists() or not any(out.iterdir()), 'Use a new empty receipt directory'
    out.mkdir(parents=True, exist_ok=True)
    report = {'schemaVersion': 1, 'scope': SCOPE, 'cases': [], 'passed': False,
              'parameters': {'version': VERSION, 'package': LABEL, 'opportunities': OPPORTUNITIES,
                             'warmup': WARMUP, 'harnessRoot': str(harness_root), 'fixtures': str(fixtures)},
              'startedAtUTC': datetime.now(timezone.utc).isoformat(),
              'hostLoadAtStart': list(os.getloadavg()),
              'limits': ['Single availability pair, no replication or CPU comparison.',
                         'Whole-page post-GC heap/documents include fixture and Playwright clock effects.',
                         'Current frame API checks and all-frame init scripts store scalar metadata only.',
                         'No observer/disconnect production intervention or source modification.']}
    pins = None
    try:
        assert importlib.metadata.version('playwright') == '1.55.0', 'Pinned Playwright required'
        pins = {str(harness_root / name): sha(harness_root / name) for name in HARNESS_FILES}
        pins[str(Path(__file__).resolve())] = sha(Path(__file__).resolve())
        pins[str(fixtures / 'manifest.json')] = sha(fixtures / 'manifest.json')
        manifest = json.loads((fixtures / 'manifest.json').read_text())
        for basename in ['ads.min.js', 'prebid.js', 'config.json', 'manifest.json']:
            name = f'{VERSION}/{LABEL}/{basename}'
            actual = sha(fixtures / name)
            assert actual == manifest['files'][name], ('Changed package', name)
            pins[str(fixtures / name)] = actual
        report.update(inputSha256=pins, runtime=manifest['runtime'],
                      nativeBuild=manifest['versions'][VERSION])
        sys.path.insert(0, str(harness_root / 'scripts'))
        spec = importlib.util.spec_from_file_location('retention430_sealed_harness', harness_root / HARNESS_FILES[1])
        harness = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(harness)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
            try:
                assert browser.version == '140.0.7339.16', browser.version
                report['browser'] = browser.version
                for disabled in [False, True]:
                    row = run_case(harness, browser, manifest, fixtures, out, disabled)
                    report['cases'].append(row)
                    if not row['passed']:
                        break  # No blind reruns or extra scenarios after a failed branch.
            finally:
                browser.close()
        report['pair'] = compare(report['cases'])
        report['passed'] = report['pair']['matched']
    except Exception as error:
        report.update(error=repr(error), traceback=traceback.format_exc())
    finally:
        if pins is not None:
            report['inputsUnchanged'] = all(Path(path).exists() and sha(Path(path)) == expected for path, expected in pins.items())
            report['passed'] = report['passed'] and report['inputsUnchanged']
        report['completedAtUTC'] = datetime.now(timezone.utc).isoformat()
        report['hostLoadAtEnd'] = list(os.getloadavg())
        write_json(out / 'summary.json', report)
        print(json.dumps({'passed': report['passed'], 'cases': len(report['cases']), 'summary': str(out / 'summary.json')}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
