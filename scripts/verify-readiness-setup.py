"""Opt-in 3.14 setup through real React and Worker/SQLite; no remote requests.

Run after npm run build and node scripts/prepare-test-workspace.mjs.
Requires Playwright; CHROMIUM_EXECUTABLE_PATH optionally selects a local binary.
"""
import base64
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/readiness-setup-evidence'
out.mkdir(parents=True, exist_ok=True)
process = subprocess.Popen(
    ['node', '--experimental-strip-types', 'scripts/site-workspace-browser-fixture.mjs', '--release-setup'],
    cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)
assert json.loads(process.stdout.readline())['ready']
errors, requests = [], []

def route(request):
    url = urlsplit(request.request.url)
    assert url.netloc == 'tessera.fixture.invalid', 'Unexpected external request'
    payload = {'path': url.path, 'method': request.request.method, 'body': request.request.post_data}
    process.stdin.write(json.dumps(payload) + '\n')
    process.stdin.flush()
    result = json.loads(process.stdout.readline())
    assert 'error' not in result, result
    requests.append({'path': url.path, 'method': payload['method'], 'status': result['status']})
    request.fulfill(status=result['status'], headers=result['headers'], body=base64.b64decode(result['body']))

try:
    with sync_playwright() as playwright:
        launch = {'headless': True}
        if os.environ.get('CHROMIUM_EXECUTABLE_PATH'):
            launch.update(executable_path=os.environ['CHROMIUM_EXECUTABLE_PATH'], args=['--disable-dev-shm-usage', '--disable-webgl'])
        browser = playwright.chromium.launch(**launch)
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.route('**/*', route)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('https://tessera.fixture.invalid/setup')
        page.get_by_role('button', name='Script setup', exact=True).click()
        page.get_by_role('button', name='Change version', exact=True).click()
        version = page.get_by_label('Script version', exact=True)
        assert version.locator('option:checked').inner_text() == '3.10.0'
        page.get_by_text('Default for new scripts', exact=False).wait_for()
        version.select_option(label='3.14.0')
        assert page.get_by_text('Default for new scripts', exact=False).count() == 0
        page.get_by_text('Unsaved selection', exact=False).wait_for()
        page.get_by_role('radio', name='GAM / AdX only', exact=False).check()
        page.get_by_text('Waits for your CMP decision', exact=False).wait_for()
        page.get_by_text('No Prebid auction values are sent', exact=False).wait_for()
        assert all(request['method'] == 'GET' for request in requests)
        page.screenshot(path=str(out / 'desktop-setup.png'), full_page=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(out / 'mobile-setup.png'), full_page=True)
        page.get_by_role('button', name='Save script setup', exact=True).click()
        page.get_by_role('status').filter(has_text='Script setup saved').wait_for()
        page.reload()
        page.get_by_role('button', name='Script setup', exact=True).click()
        page.get_by_role('button', name='Change version', exact=True).click()
        assert page.get_by_label('Script version', exact=True).locator('option:checked').inner_text() == '3.14.0'
        assert page.get_by_text('Unsaved selection', exact=False).count() == 0
        assert page.get_by_role('radio', name='GAM / AdX only', exact=False).is_checked()
        page.get_by_role('radio', name='GAM + Prebid', exact=False).check()
        page.get_by_text('Also includes current-auction bid counts and timeout.', exact=False).wait_for()
        page.get_by_role('button', name='Open Prebid.js', exact=True).wait_for()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(out / 'mobile-prebid-setup.png'), full_page=True)
        assert not errors, errors
        browser.close()
    (out / 'result.json').write_text(json.dumps({'passed': True, 'pageErrors': errors, 'requests': requests, 'externalRequests': 0}, indent=2))
    print('PASS 3.10 default, explicit 3.14 selection/persistence, mode guidance, desktop/mobile, no external requests')
finally:
    process.stdin.close()
    process.wait(timeout=10)
