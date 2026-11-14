"""Desktop/mobile deletion, exact request, cancellation, storage error and retry."""
import base64, json, os, subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/release-deletion-ui'; out.mkdir(parents=True, exist_ok=True)
for width in (1280, 390):
    process = subprocess.Popen(['node', '--experimental-strip-types', '--experimental-loader', './tests/support/ts-extension-loader.mjs', 'scripts/release-deletion-browser-fixture.mjs'], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    calls, errors = [], []
    try:
        ready = json.loads(process.stdout.readline()); assert ready['ready'], ready
        def fixture(path, method='GET', headers=None, body=None):
            data = dict(path=path, method=method, headers=headers or {}, body=body)
            process.stdin.write(json.dumps(data)+'\n'); process.stdin.flush()
            response = json.loads(process.stdout.readline()); assert 'error' not in response, response
            return response
        def route(request):
            url = urlsplit(request.request.url); assert url.netloc == 'dashboard.invalid'
            calls.append(dict(path=url.path, method=request.request.method, headers=request.request.headers))
            response = fixture(url.path, request.request.method, request.request.headers, request.request.post_data)
            request.fulfill(status=response['status'], headers=response['headers'], body=base64.b64decode(response['body']))
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH')); page = browser.new_page(viewport={'width':width, 'height':900})
            page.route('**/*', route); page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto('https://dashboard.invalid/')
            draft = page.locator('article').filter(has_text='Sticky desktop maximum')
            draft.get_by_role('button', name='Delete release', exact=True).wait_for()
            for title, reason in [('Staging package', 'Stage another release'), ('Production package', 'Publish or restore another release')]:
                card = page.locator('article').filter(has_text=title)
                assert card.get_by_role('button', name='Delete release', exact=True).is_disabled()
                assert card.get_by_text(reason, exact=False).is_visible()
            assert page.locator('article').filter(has_text='Earlier archived package').get_by_role('button', name='Delete release', exact=True).is_enabled()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.screenshot(path=str(out/f'{width}-releases.png'), full_page=True)
            draft.get_by_role('button', name='Delete release', exact=True).click()
            dialog = page.get_by_role('dialog'); assert dialog.is_visible()
            assert dialog.get_by_role('button', name='No', exact=True).evaluate('(button)=>button===document.activeElement')
            dialog.get_by_role('button', name='No', exact=True).click()
            assert not any(call['method']=='DELETE' for call in calls)
            fixture('/__fixture/fail-next', 'POST')
            draft.get_by_role('button', name='Delete release', exact=True).click()
            dialog.get_by_role('button', name='Yes', exact=True).click()
            dialog.get_by_role('alert').filter(has_text='Release files could not be removed').wait_for()
            assert draft.count()==1
            page.screenshot(path=str(out/f'{width}-retry.png'), full_page=True)
            dialog.get_by_role('button', name='Yes', exact=True).click()
            page.get_by_role('status').filter(has_text='Deleted GAM + Prebid').wait_for()
            assert draft.count()==0; assert not dialog.is_visible()
            deletes = [call for call in calls if call['method']=='DELETE']; assert len(deletes)==2
            assert all(call['headers']['x-confirm-delete']==ready['id'] for call in deletes)
            snapshot = json.loads(base64.b64decode(fixture('/__fixture/snapshot')['body']))
            assert not snapshot['exists']; assert len(snapshot['deleted'])==2
            assert len(snapshot['rows'])==4
            assert not errors, errors
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.screenshot(path=str(out/f'{width}-deleted.png'), full_page=True)
            browser.close()
    finally:
        process.stdin.close(); process.wait(timeout=15)
print('Release deletion desktop/mobile UI: cancel, blockers, exact confirmation, error and retry passed.')
