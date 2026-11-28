"""Independently check actual GAM request gaps when CMP delays a refresh.

Input must be generated from a local fixture with Billboard refresh enabled,
minSeconds=30 and minGapSeconds=100. All network is intercepted. Use --expect-fixed
for an acceptance assertion, otherwise this records the pre-fix regression.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--script', required=True, type=Path)
parser.add_argument('--expect-fixed', action='store_true')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
source = args.script.read_text()
output = args.output or root / '.generated/audit-independent-review/native-cmp-min-gap.json'
html = '<!doctype html><body style="margin:0"><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:2400px"></div><div id="P1" class="wrapperAd" style="height:250px"></div></body>'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors, network = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def route(request):
        if request.request.url == 'https://audit.test/':
            request.fulfill(status=200, content_type='text/html', body=html)
        else:
            network.append(request.request.url)
            request.abort()
    page.route('**/*', route)
    page.goto('https://audit.test/')
    page.clock.install(time=datetime(2026, 10, 24, tzinfo=timezone.utc))
    page.clock.pause_at(datetime(2026, 10, 24, 0, 0, 1, tzinfo=timezone.utc))
    page.add_script_tag(content=(root / 'tests/runtime/mock-ad-libraries.js').read_text())
    page.evaluate('''() => {
      window.__auditCmp = [];
      window.__tcfapi = (command, version, callback) => {
        if (command === 'addEventListener') {
          __auditCmp.push(callback);
          callback({gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded',listenerId:1},true);
        }
      };
    }''')
    page.add_script_tag(content=source)
    start = page.evaluate('Date.now()')
    page.clock.run_for(5000)
    page.evaluate('() => __auditCmp.forEach(cb => cb({gdprApplies:true,cmpStatus:"loaded",eventStatus:"cmpuishown",listenerId:1},true))')
    page.clock.run_for(100000)
    pending = page.evaluate('({requests:__testAds.observations.requests,consent:__tesseraReadiness.snapshot().consent})')
    assert not pending['consent']['ready'], pending
    assert len(pending['requests']) == 1, pending
    page.evaluate('() => __auditCmp.forEach(cb => cb({gdprApplies:false,cmpStatus:"loaded",eventStatus:"tcloaded",listenerId:1},true))')
    page.clock.run_for(250000)
    after = page.evaluate('''() => {
      var debug = adopsDebug.slot('Billboard');
      return {requests:__testAds.observations.requests,rule:debug.refreshRule,refreshCount:debug.refreshCount,consent:__tesseraReadiness.snapshot().consent};
    }''')
    offsets = [row['at'] - start for row in after['requests'] if row['id'] == 'Billboard']
    gaps = [right - left for left, right in zip(offsets, offsets[1:])]
    report = {
        'scope': 'Real Chromium; local generated script, synthetic GPT/TCF, every network route intercepted',
        'script': str(args.script.resolve()),
        'scriptSha256': hashlib.sha256(args.script.read_bytes()).hexdigest(),
        'expectFixed': args.expect_fixed,
        'pendingFromOffsetMs': 5000,
        'readyOffsetMs': 105000,
        'offsetsMs': offsets,
        'actualGapsMs': gaps,
        'rule': after['rule'],
        'refreshCount': after['refreshCount'],
        'requestsWhilePending': len(pending['requests']) - 1,
        'pageErrors': errors,
        'unexpectedNetwork': network,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    assert not errors, errors
    assert not network, network
    assert after['rule']['minSeconds'] == 30, after['rule']
    assert after['rule']['minGapSeconds'] == 100, after['rule']
    assert after['refreshCount'] == len(offsets) - 1, report
    assert len(offsets) >= 3, report
    if args.expect_fixed:
        assert all(gap >= 100000 for gap in gaps), report
    else:
        assert any(gap < 100000 for gap in gaps[1:]), report
    print(json.dumps(report))
    browser.close()
