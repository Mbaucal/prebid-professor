"""Actual isolated editor HTML/JS with synthetic storage and the real draft validator.

No HTTP server, publisher settings or ad requests. Playwright intercepts every
request. Screenshots and the result are written under .generated/draft-inventory-ui.
"""
import copy
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.generated/draft-inventory-ui'
ORIGIN = 'https://draft-inventory-ui.invalid'
OUT.mkdir(parents=True, exist_ok=True)

# Read the exact served sources; use the real validator for each synthetic POST.
NODE = r"""
import {createInterface} from 'node:readline';
import {siteDraftPage,siteDraftScript} from './worker/test-workspace/site-draft-page.mjs';
import {normalizeSiteDraft} from './worker/test-workspace/site-draft.mjs';
globalThis.fetch=()=>{throw Error('UI fixture cannot fetch external resources');};
console.log(JSON.stringify({html:siteDraftPage(),script:siteDraftScript}));
createInterface({input:process.stdin}).on('line',line=>{
  try {console.log(JSON.stringify({draft:normalizeSiteDraft(JSON.parse(line))}));}
  catch(error){console.log(JSON.stringify({error:error.message,status:error.status??422}));}
});
"""
process = subprocess.Popen(['node', '--input-type=module', '-e', NODE], cwd=ROOT,
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
sources = json.loads(process.stdout.readline())
initial = {
    'revision': 'a' * 64, 'needsRuntimeSelection': False, 'formatReviewRequired': [],
    'draft': {
        'site': {'name': 'Draft inventory check', 'domain': 'example.invalid', 'gamPath': '/123/test/'},
        'units': [
            {'code': 'Billboard', 'type': 'ATF', 'sizeMap': 'display', 'enabled': True},
            {'code': 'm.box_5', 'type': 'DRAFT', 'sizeMap': 'display', 'enabled': False},
        ],
        'maps': [{'name': 'display', 'breakpoints': [{'minWidth': 0, 'sizes': [[300, 250]]}]}],
        'bottomStickyId': '',
        'takeOver': {'enabled': False, 'adUnitCode': 'TakeOver', 'desktopMinWidth': 1024,
                     'desktopSize': [800, 600], 'mobileSize': [300, 250],
                     'autoCloseDesktopSec': 10, 'autoCloseMobileSec': 5, 'showCountdown': True},
    },
}
results, external = [], []

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True,
                                            executable_path=os.environ.get('CHROMIUM_PATH'))
        for width, height in [(1280, 900), (390, 844)]:
            state, calls, pending, errors = copy.deepcopy(initial), [], [], []
            context = browser.new_context(viewport={'width': width, 'height': height}, service_workers='block')
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))

            def handle(route):
                request = route.request
                url = urlsplit(request.url)
                if url.netloc != urlsplit(ORIGIN).netloc:
                    external.append(request.url)
                    route.abort()
                elif url.path == '/site-settings.js' and request.method == 'GET':
                    route.fulfill(status=200, content_type='application/javascript', body=sources['script'])
                elif url.path == '/site-settings' and request.method == 'GET':
                    route.fulfill(status=200, content_type='text/html', body=sources['html'])
                elif url.path == '/test-api/site-settings':
                    if request.method == 'POST':
                        body = request.post_data_json
                        assert body['acknowledge'] is True and body['expectedRevision'] == state['revision']
                        assert body['draft']['units'][1]['code'] == 'm.box_5'
                        assert body['draft']['units'][1]['type'] == 'DRAFT'
                        calls.append(body)
                        process.stdin.write(json.dumps(body['draft']) + '\n')
                        process.stdin.flush()
                        result = json.loads(process.stdout.readline())
                        if 'error' in result:
                            route.fulfill(status=result['status'], content_type='application/json', body=json.dumps(result))
                            return
                        state['draft'], state['revision'], state['changed'] = result['draft'], 'b' * 64, True
                        pending.append(route)
                        return
                    assert request.method == 'GET'
                    route.fulfill(status=200, content_type='application/json', body=json.dumps(state))
                elif url.path == '/favicon.ico':
                    route.fulfill(status=204)
                else:
                    external.append(request.url)
                    route.abort()

            context.route('**/*', handle)
            page.goto(ORIGIN + '/site-settings')
            group = page.get_by_label('Group', exact=True).nth(1)
            expect(group).to_have_value('DRAFT')
            expect(page.locator('#bottom-sticky option[value="m.box_5"]')).to_have_count(0)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            group.select_option('BTF')
            group.select_option('DRAFT')

            # The real validator rejects active display on DRAFT. Keep all entered
            # values visible, then repair the display without losing the code/type.
            page.get_by_label('Display', exact=True).nth(1).select_option('sticky')
            page.locator('#confirm-draft').check()
            save = page.get_by_role('button', name='Save site settings', exact=True)
            save.click()
            expect(page.locator('#editor-message')).to_have_text('Choose ATF or BTF before enabling Sticky or TakeOver display.')
            expect(group).to_have_value('DRAFT')
            expect(page.get_by_label('Position ID', exact=True).nth(1)).to_have_value('m.box_5')
            page.screenshot(path=str(OUT / f'draft-{width}-error.png'), full_page=True)

            page.get_by_label('Display', exact=True).nth(1).select_option('standard')
            page.locator('#confirm-draft').check()
            with page.expect_request(lambda request: request.url.endswith('/test-api/site-settings') and request.method == 'POST'):
                save.click()
            expect(save).to_be_disabled()
            expect(group).to_be_disabled()
            assert len(pending) == 1
            pending.pop().fulfill(status=200, content_type='application/json', body=json.dumps(state))
            expect(page.locator('#editor-message')).to_have_text('Site settings saved. Back to Generate creates a new package with these settings.')
            expect(group).to_have_value('DRAFT')
            expect(page.get_by_label('Position ID', exact=True).nth(1)).to_have_value('m.box_5')
            expect(page.locator('#bottom-sticky option[value="m.box_5"]')).to_have_count(0)
            assert len(calls) == 2 and not state['draft']['units'][1]['enabled']
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            assert not errors, errors
            page.screenshot(path=str(OUT / f'draft-{width}-saved.png'), full_page=True)
            results.append({'viewport': [width, height], 'draftPreserved': True, 'saveErrorRecovery': True,
                            'pendingSaveLocked': True, 'horizontalOverflow': False, 'pageErrors': errors})
            context.close()
        browser.close()
    assert not external, external
    report = {'passed': True, 'checks': results, 'externalRequests': external,
              'scope': 'Actual served editor and validator; synthetic intercepted storage. No hosted writes or ad requests.'}
    (OUT / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
finally:
    process.stdin.close()
    process.wait(timeout=10)
