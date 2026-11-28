"""Run the unchanged native cache verifier with one controlled RPC delay.

Only the synthetic bidder endpoint is delayed. Packaged runtime/Prebid bytes,
GAM request attribution, round/CPM/cache assertions and all deadlines are kept.
"""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import time
import urllib.parse


def delayed_round(rows, seen):
    """Return round 3 once per browser context, only for Billboard RPCs."""
    if 3 not in seen and any(
        row.get('fixtureCode') == 'Billboard' and row.get('fixtureRound') == 3
        for row in rows
    ):
        seen.add(3)
        return 3
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--delay-ms', type=int, default=700)
    args = parser.parse_args()
    if not 0 < args.delay_ms < 800:
        parser.error('Delay must be positive and below the frozen 800 ms ATF auction timeout.')
    from playwright.sync_api import BrowserContext

    original_route = BrowserContext.route
    delays = []

    def instrumented_route(context, url, handler, *route_args, **route_kwargs):
        seen = set()

        def controlled_handler(route):
            request = urllib.parse.urlsplit(route.request.url)
            if request.hostname == 'readiness-fixture.invalid' and request.path == '/bid':
                rows = json.loads(urllib.parse.parse_qs(request.query)['payload'][0])
                number = delayed_round(rows, seen)
                if number is not None:
                    delays.append({'round': number, 'delayMs': args.delay_ms})
                    time.sleep(args.delay_ms / 1000)
            return handler(route)

        return original_route(context, url, controlled_handler, *route_args, **route_kwargs)

    BrowserContext.route = instrumented_route
    try:
        result = runpy.run_path(str(Path(__file__).with_name('verify-tanjug-cache.py')), run_name='__main__')
        assert delays, 'The controlled round 3 RPC delay was not exercised.'
        root = result['root']
        manifest = result['manifest']
        files = {}
        for name, declared in manifest['files'].items():
            package_file = (root / name).resolve()
            assert root.resolve() in package_file.parents, 'Manifest file is outside the package.'
            data = package_file.read_bytes()
            files[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            assert files[name] == declared, 'Packaged bytes do not match the declared manifest.'
        report = {'controlledNativeRpcDelays': delays, 'verifier': 'verify-tanjug-cache.py',
                  'assertionsAndDeadlines': 'unchanged', 'checks': result['checks'],
                  'packageId': manifest['id'], 'files': files}
        target = root.parent / 'browser-latency-report.json'
        target.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'controlledNativeRpcDelays': delays, 'assertionsAndDeadlines': 'unchanged',
                          'checksPassed': len(result['checks']), 'report': str(target)}))
    finally:
        BrowserContext.route = original_route


if __name__ == '__main__':
    main()
