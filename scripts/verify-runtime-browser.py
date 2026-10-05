"""Offline Chromium regression checks with mocked GPT/Prebid and local test creatives.
Usage: python scripts/verify-runtime-browser.py GENERATED_REPORT_DIRECTORY
All http(s) requests are blocked and counted. This does not verify real GAM delivery.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise SystemExit('Supply output from verify-reference-bridge.mjs; missing fixtures are errors.')
fixtures = Path(sys.argv[1]).resolve()
if not (fixtures / 'generation-report.json').is_file():
    raise SystemExit('Generation report is missing.')
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
html = '<!doctype html><html><body><div id="Billboard" class="wrapperAd"></div><div style="height:2000px"></div><div id="P1" class="wrapperAd" style="min-height:250px"></div><div id="Sticky" class="wrapperAd"></div></body></html>'
results = []

def require(value, message):
    if not value:
        raise AssertionError(message)

def state(page):
    return page.evaluate('takeOverDebug.state()')

def count(page, slot):
    return page.evaluate('(id) => __testAds.observations.requests.filter(r => r.id === id).length', slot)

def wait_visible(page):
    page.wait_for_function('takeOverDebug.state().visible', timeout=3000)

def run_case(browser, name, callback, source='standard', width=1280, options=None):
    page = browser.new_page(viewport={'width': width, 'height': 900 if width > 1000 else 740})
    errors, requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: requests.append(request.url) if request.url.startswith(('https:', 'http:')) else None)
    page.route('**/*', lambda route: route.abort())
    try:
        page.set_content(html)
        page.evaluate('(v) => { window.__testOptions = v; }', options or {})
        page.add_script_tag(content=mock)
        code = (fixtures / f'{source}.js').read_text()
        page.add_script_tag(content=code)
        callback(page, code)
        require(not errors, f'Uncaught browser errors: {errors}')
        require(not requests, f'Unexpected external requests: {requests}')
        results.append({'name': name, 'passed': True, 'externalRequests': len(requests)})
    except Exception as error:
        results.append({'name': name, 'passed': False, 'error': str(error), 'browserErrors': errors, 'externalRequests': len(requests)})
    finally:
        page.close()

def desktop(page, code):
    wait_visible(page)
    require(state(page)['requestedSize'] == [800, 600], 'Wrong desktop request size')
    require(page.locator('#adsx-takeover-close').is_visible(), 'Close not immediately available')
    require(count(page, 'adsx-takeover-slot') == 1, 'More than one TakeOver request')
    require(count(page, 'interstitial-guard') == 0, 'Guard requested while TakeOver filled')
    require(page.evaluate('__testAds.observations.bids.every(b => b.adUnits.every(u => u.code !== "adsx-takeover-slot"))'), 'TakeOver entered Prebid')
    page.screenshot(path=str(fixtures / 'takeover-desktop.png'))
    page.locator('#adsx-takeover-close').click()
    require(state(page)['closeReason'] == 'manual-close', 'Manual close failed')
    require(page.locator('#adsx-takeover-overlay').count() == 0, 'Modal DOM not removed')
    require(not page.evaluate('document.documentElement.classList.contains("adsx-takeover-open")'), 'Scroll lock remains')

def mobile(page, code):
    wait_visible(page)
    require(state(page)['requestedSize'] == [300, 250], 'Wrong mobile request size')
    require(state(page)['autoCloseSec'] == 5, 'Mobile timer differs from configuration')
    box = page.locator('#adsx-takeover-panel').bounding_box()
    require(box['x'] >= 0 and box['x'] + box['width'] <= 360, 'Panel outside viewport')
    page.screenshot(path=str(fixtures / 'takeover-mobile.png'))
    page.keyboard.press('Escape')
    require(state(page)['closeReason'] == 'escape-close', 'Escape failed')

def failure(reason, requests=1):
    def check(page, code):
        page.wait_for_function('(reason) => takeOverDebug.state().closeReason === reason', arg=reason, timeout=3000)
        page.wait_for_function('takeOverDebug.state().fallbackRequested', timeout=1000)
        require(count(page, 'adsx-takeover-slot') == requests, 'Unexpected TakeOver request count')
        require(count(page, 'interstitial-guard') == 1, 'Fallback not requested exactly once')
        require(page.locator('#adsx-takeover-overlay').count() == 0, 'Failed modal remains')
        require(page.evaluate('document.documentElement.getAttribute("data-google-interstitial")') is None, 'Interstitial attribute not restored')
    return check

def resize(page, code):
    wait_visible(page)
    page.set_viewport_size({'width': 360, 'height': 740})
    page.wait_for_timeout(70)
    box = page.locator('#adsx-takeover-creative-viewport').bounding_box()
    require(box['width'] <= 336.1 and box['height'] <= 676, 'Scaled creative exceeds available area')
    require(state(page)['requestedSize'] == [800, 600], 'Resize changes the original auction size')
    require(count(page, 'adsx-takeover-slot') == 1, 'Resize creates an extra impression')

def duplicate_load(page, code):
    wait_visible(page)
    before = page.evaluate('__testAds.observations.requests.length')
    page.add_script_tag(content=code)
    page.wait_for_timeout(120)
    require(page.evaluate('__testAds.observations.requests.length') == before, 'Duplicate script creates new requests')
    require(page.locator('#adsx-takeover-overlay').count() == 1, 'Duplicate modal')

def auto_close(page, code):
    wait_visible(page)
    require(state(page)['requestedSize'] == [640, 480], 'Custom desktop size ignored')
    page.wait_for_function('takeOverDebug.state().closeReason === "auto-close"', timeout=2500)

def pause_timer(page, code):
    wait_visible(page)
    page.evaluate('''() => {
      window.__testHidden = true;
      Object.defineProperty(document, 'hidden', {configurable: true, get: () => window.__testHidden});
      document.dispatchEvent(new Event('visibilitychange'));
    }''')
    remaining = state(page)['remainingMs']
    page.wait_for_timeout(1100)
    require(state(page)['visible'], 'Timer closed the modal during simulated hidden state')
    require(abs(state(page)['remainingMs'] - remaining) < 25, 'Paused remaining time changed')
    page.evaluate('window.__testHidden = false; document.dispatchEvent(new Event("visibilitychange"));')
    page.wait_for_function('takeOverDebug.state().closeReason === "auto-close"', timeout=2500)

def no_timer(page, code):
    wait_visible(page)
    page.wait_for_timeout(1100)
    require(state(page)['visible'] and state(page)['autoCloseSec'] == 0, 'Zero timer not honored')

def direct_lazy(page, code):
    wait_visible(page)
    page.locator('#adsx-takeover-close').click()
    page.wait_for_timeout(1100)
    page.locator('#P1').scroll_into_view_if_needed()
    page.wait_for_function('__testAds.observations.requests.some(r => r.id === "P1")', timeout=1500)
    require(page.evaluate('__testAds.observations.bids.length') == 0, 'GPT-only path issued Prebid requests')

def absent_sticky(page, code):
    wait_visible(page)
    require(page.locator('#close_sticky_ad').count() == 0, 'Disabled sticky has close control')
    require(page.evaluate('getComputedStyle(document.getElementById("Sticky")).position') == 'static', 'Disabled sticky still fixed')
    require(page.evaluate('window.STICKY_TARGET_ID') == '', 'Disabled ID not cleared')

def disabled_takeover(page, code):
    page.wait_for_timeout(150)
    require(not state(page)['initialized'], 'Disabled TakeOver was initialized')
    require(count(page, 'adsx-takeover-slot') == 0 and count(page, 'interstitial-guard') == 0, 'Disabled TakeOver made a request')

def explicit_id(page, code):
    wait_visible(page)
    require(page.evaluate('window.ID5EspConfig.partnerId') == 42, 'Configured ID5 partner not applied')

def no_id(page, code):
    wait_visible(page)
    require(page.evaluate('typeof window.ID5EspConfig') == 'undefined', 'Inherited default ID5 partner')

def no_floor(page, code):
    wait_visible(page)
    require(page.evaluate('__testAds.observations.configs[0].floors.enabled') is False, 'Disabled floors enabled')
    require(page.evaluate('pbjs.bidderSettings.standard.bidCpmAdjustment(0.01, {currency:"EUR"})') == 0.01, 'Disabled floor still suppresses bids')

def bidder_params(page, code):
    wait_visible(page)
    require(page.evaluate('__testAds.observations.bids.some(b => b.adUnits.some(u => u.code === "Billboard" && u.bids[0].params.siteId === "exact"))'), 'Exact per-unit bidder override lost')
    require(page.evaluate('__testAds.observations.bids.some(b => b.adUnits.some(u => u.code === "Billboard" && JSON.stringify(u.mediaTypes.banner.sizes) === "[[300,250]]"))'), 'Mobile size map lost')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    run_case(browser, 'desktop-fill-and-manual-close', desktop)
    run_case(browser, 'mobile-fill-and-escape-close', mobile, width=360)
    run_case(browser, 'no-fill-exactly-one-fallback', failure('empty'), options={'takeoverResult':'empty'})
    run_case(browser, 'wrong-size-exactly-one-fallback', failure('size-mismatch'), options={'takeoverResult':'wrong-size'})
    run_case(browser, 'timeout-exactly-one-fallback', failure('request-timeout'), source='short-timeout', options={'takeoverResult':'timeout'})
    run_case(browser, 'define-null-cleanup-and-fallback', failure('define-failed', 0), options={'takeoverResult':'define-null'})
    run_case(browser, 'onload-missing-render-fallback', lambda page, code: wait_visible(page), source='short-timeout', options={'omitOnload':True})
    run_case(browser, 'resize-fit-without-second-request', resize)
    run_case(browser, 'duplicate-script-load-does-not-double-requests', duplicate_load)
    run_case(browser, 'custom-size-and-auto-close', auto_close, source='custom-takeover')
    run_case(browser, 'visibility-handler-pause-and-resume', pause_timer, source='custom-takeover')
    run_case(browser, 'zero-auto-close-timer', no_timer, source='timer-disabled')
    run_case(browser, 'gpt-only-atf-and-lazy-btf', direct_lazy, source='gpt-only')
    run_case(browser, 'empty-bidder-list-atf-and-lazy-btf', direct_lazy, source='no-bidders')
    run_case(browser, 'disabled-sticky-no-phantom-panel', absent_sticky, source='sticky-off')
    run_case(browser, 'disabled-takeover-no-requests', disabled_takeover, source='takeover-off')
    run_case(browser, 'configured-id5-partner', explicit_id, source='id5-explicit')
    run_case(browser, 'no-inherited-id5-partner', no_id)
    run_case(browser, 'disabled-floor-enforcement', no_floor, source='floor-off')
    run_case(browser, 'mobile-size-and-bidder-override', bidder_params, width=360)
    browser.close()
report = {'browser':'Chromium', 'passed':sum(r['passed'] for r in results), 'failed':sum(not r['passed'] for r in results),
          'cases':results, 'scope':'Local real browser; mocked GPT/Prebid, local iframe creatives, blocked external requests. Visibility handler tested with simulated hidden property. Not real GAM/AdX delivery, Cloudflare deployment, or a production acceptance result.'}
(fixtures / 'browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(1 if report['failed'] else 0)
