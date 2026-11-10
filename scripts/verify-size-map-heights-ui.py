"""Size-map editing through actual React and authenticated local Worker; no hosted traffic."""
import base64
import json
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/size-map-height-ui'
out.mkdir(parents=True, exist_ok=True)
origin = 'https://admin-audit.fixture.invalid'
results = []

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    for width in [1440, 390]:
        proc = subprocess.Popen(
            ['node', '--experimental-strip-types', '--experimental-loader', './tests/support/ts-extension-loader.mjs',
             'scripts/admin-audit-browser-fixture.mjs', '--runtime=3.19.0'],
            cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        assert json.loads(proc.stdout.readline())['ready']
        page = browser.new_page(viewport={'width': width, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        fail_next_save = False

        def send(path, method='GET', body=None):
            proc.stdin.write(json.dumps({'path': path, 'method': method, 'body': None if body is None else json.dumps(body)}) + '\n')
            proc.stdin.flush()
            value = json.loads(proc.stdout.readline())
            assert 'error' not in value, value
            return value

        def data(path):
            response = send(path)
            assert response['status'] == 200, response
            return json.loads(base64.b64decode(response['body']))

        def route(r):
            global fail_next_save
            request = r.request
            url = urlsplit(request.url)
            assert url.netloc == 'admin-audit.fixture.invalid', request.url
            if fail_next_save and '/size-maps/' in url.path and request.method == 'PATCH':
                fail_next_save = False
                r.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Temporary save failure. Please retry.'}))
                return
            value = send(url.path + ('?' + url.query if url.query else ''), request.method,
                         json.loads(request.post_data) if request.post_data else None)
            r.fulfill(status=value['status'], headers=value['headers'], body=base64.b64decode(value['body']))

        page.route('**/*', route)

        def screen(name):
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Horizontal page overflow'
            assert page.locator('[role=dialog]').count() == 0 or page.locator('[role=dialog]').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1'), 'Horizontal dialog overflow'
            page.screenshot(path=str(out / f'{name}-{width}.png'), full_page=True)

        def maps():
            page.get_by_role('button', name='Size maps', exact=True).click()
            expect(page.get_by_role('heading', name='display', exact=True)).to_be_visible()

        def edit():
            page.locator('article.size-map-card').filter(has=page.get_by_role('heading', name='display', exact=True)).get_by_role('button', name='Edit', exact=True).click()
            return page.get_by_role('dialog', name='Edit display', exact=True)

        def saved_map():
            return json.loads(next(item['map_json'] for item in data('/__fixture/snapshot')['maps'] if item['name'] == 'display'))

        try:
            page.goto(origin + '/', wait_until='domcontentloaded')
            before = data('/__fixture/snapshot')
            maps()
            dialog = edit()
            expect(dialog.get_by_label('Breakpoint 1 reserved ad height', exact=True)).to_have_text('250px')
            expect(dialog.get_by_label('Breakpoint 1 minimum browser viewport height', exact=True)).not_to_be_visible()
            dialog.locator('.breakpoint-viewport-height').first.get_by_text('Advanced: browser viewport height', exact=True).click()
            viewport_height = dialog.get_by_label('Breakpoint 1 minimum browser viewport height', exact=True)
            viewport_height.fill('600')
            expect(dialog.get_by_label('Breakpoint 1 reserved ad height', exact=True)).to_have_text('250px')
            sizes = dialog.get_by_label('Breakpoint 1 sizes', exact=True)
            sizes.fill('fluid')
            expect(dialog.get_by_label('Breakpoint 1 reserved ad height', exact=True)).to_have_text('0px · fluid varies')
            sizes.fill('')
            expect(dialog.get_by_label('Breakpoint 1 reserved ad height', exact=True)).to_have_text('0px · no ad')
            sizes.fill('bad-size')
            dialog.get_by_role('button', name='Save size map', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('must use 970x250 or fluid')
            assert saved_map()[0]['minViewPort'] == [0, 0], 'Invalid edit must not be saved'
            sizes.fill('300x250 | fluid')
            expect(dialog.get_by_label('Breakpoint 1 reserved ad height', exact=True)).to_have_text('250px · fluid varies')
            fail_next_save = True
            dialog.get_by_role('button', name='Save size map', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('Temporary save failure')
            expect(viewport_height).to_have_value('600')
            expect(sizes).to_have_value('300x250 | fluid')
            screen('save-error')
            dialog.get_by_role('button', name='Save size map', exact=True).click()
            expect(dialog).to_have_count(0)
            assert saved_map()[0] == {'minViewPort': [0, 600], 'sizes': [[300, 250], 'fluid']}
            assert data('/__fixture/snapshot')['config']['builtinRuntimeSelection'] == before['config']['builtinRuntimeSelection']
            page.reload(wait_until='domcontentloaded')
            maps()
            dialog = edit()
            expect(dialog.get_by_label('Breakpoint 1 minimum browser viewport height', exact=True)).to_be_visible()
            expect(dialog.get_by_label('Breakpoint 1 minimum browser viewport height', exact=True)).to_have_value('600')
            expect(dialog.get_by_label('Breakpoint 1 reserved ad height', exact=True)).to_have_text('250px · fluid varies')
            screen('preserved-viewport-height')
            dialog.get_by_role('button', name='Cancel', exact=True).click()
            page.get_by_role('button', name='Generate and releases', exact=True).first.click()
            generate = page.get_by_role('button', name='Generate and save package', exact=True)
            expect(generate).to_be_visible()
            # Older servers reject only at Generate; the compatibility preflight rejects earlier.
            if generate.is_enabled():
                generate.click()
            expect(page.locator('.runtime-error').filter(has_text='height').first).to_be_visible()
            assert saved_map()[0]['minViewPort'] == [0, 600], 'Validation must not reset a viewport condition'
            screen('legacy-generation-error')
            maps()
            dialog = edit()
            # An explicit user edit removes the condition; reservation still comes from Sizes.
            dialog.get_by_label('Breakpoint 1 minimum browser viewport height', exact=True).fill('0')
            expect(dialog.get_by_label('Breakpoint 1 reserved ad height', exact=True)).to_have_text('250px · fluid varies')
            dialog.get_by_role('button', name='Save size map', exact=True).click()
            expect(dialog).to_have_count(0)
            page.get_by_role('button', name='Generate and releases', exact=True).first.click()
            generate = page.get_by_role('button', name='Generate and save package', exact=True)
            expect(generate).to_be_enabled()
            generate.click()
            download = page.get_by_role('button', name='Download saved ZIP', exact=True)
            expect(download).to_be_visible(timeout=30000)
            with page.expect_download() as event:
                download.click()
            archive = zipfile.ZipFile(event.value.path())
            config = json.loads(archive.read('config.json'))
            assert config['runtime']['runtimeVersion'] == '3.19.0'
            assert config['core']['sizeMapsRaw']['display'][0]['viewport'] == [0, 0]
            assert config['core']['sizeMapsRaw']['display'][0]['sizes'] == [[300, 250], 'fluid']
            assert b'min-height:250px' in archive.read('min-height.css').replace(b' ', b'')
            assert not errors, errors
            screen('generated')
            results.append({'width': width, 'passed': True, 'preservedExistingHeight': True,
                            'fluidAndEmptyReservation': True, 'saveRetry': True,
                            'legacyErrorNoReset': True, 'explicitRecoveryAndDownloadedPackage': True})
        except Exception:
            screen('failure')
            print(page.locator('body').inner_text())
            raise
        finally:
            page.close()
            proc.stdin.close()
            proc.wait(timeout=10)
    browser.close()

(out / 'results.json').write_text(json.dumps(results, indent=2))
print('2/2 size-map desktop/mobile edit, save failure/retry, reload and Generate recovery checks passed.')
