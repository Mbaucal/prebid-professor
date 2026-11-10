"""Independent inactive-media recovery actions against local authenticated Worker."""
import base64
import json
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/inactive-media-ui-qa'
out.mkdir(parents=True, exist_ok=True)
origin = 'https://admin-audit.fixture.invalid'
results = []

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    for width in [1440, 390]:
        proc = subprocess.Popen(['node', '--experimental-strip-types', '--experimental-loader',
                                 './tests/support/ts-extension-loader.mjs',
                                 'scripts/admin-audit-browser-fixture.mjs', '--runtime=3.19.0'],
                                cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        assert json.loads(proc.stdout.readline())['ready']
        page = browser.new_page(viewport={'width': width, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

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
            request = r.request
            url = urlsplit(request.url)
            assert url.netloc == 'admin-audit.fixture.invalid', request.url
            value = send(url.path + ('?' + url.query if url.query else ''), request.method,
                         json.loads(request.post_data) if request.post_data else None)
            r.fulfill(status=value['status'], headers=value['headers'], body=base64.b64decode(value['body']))

        def saved():
            return next(unit for unit in data('/api/publishers/main-site/ad-units')['adUnits'] if unit['code'] == 'Billboard')

        def edit():
            page.locator('.ad-unit-card').filter(has=page.locator('code').filter(has_text='Billboard')).get_by_role('button', name='Edit', exact=True).click()
            return page.get_by_role('dialog', name='Edit Billboard', exact=True)

        def screen(name):
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Horizontal overflow'
            page.screenshot(path=str(out / f'{name}-{width}.png'), full_page=True)

        page.route('**/*', route)
        try:
            page.goto(origin + '/', wait_until='domcontentloaded')
            page.get_by_role('button', name='Ad units', exact=True).click()
            dialog = edit()
            dialog.get_by_label('Media type', exact=False).select_option('video')
            dialog.get_by_label('State', exact=False).uncheck()
            dialog.get_by_role('button', name='Save changes', exact=True).click()
            expect(dialog).to_have_count(0)
            assert saved()['mediaType'] == 'video' and saved()['enabled'] is False

            # Unsaved activation is rejected, retained for correction, then Cancel
            # leaves the exact persisted row and audit trail unchanged.
            before = saved()
            audits_before = data('/__fixture/snapshot')['audits']
            dialog = edit()
            dialog.get_by_label('State', exact=False).check()
            dialog.get_by_role('button', name='Save changes', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('Banner')
            expect(dialog.get_by_label('Media type', exact=False)).to_have_value('video')
            expect(dialog.get_by_label('State', exact=False)).to_be_checked()
            assert saved() == before
            assert data('/__fixture/snapshot')['audits'] == audits_before
            dialog.get_by_role('alert').scroll_into_view_if_needed()
            screen('activation-error')
            dialog.get_by_role('button', name='Cancel', exact=True).click()
            expect(dialog).to_have_count(0)
            page.reload(wait_until='domcontentloaded')
            page.get_by_role('button', name='Ad units', exact=True).click()
            dialog = edit()
            expect(dialog.get_by_label('Media type', exact=False)).to_have_value('video')
            expect(dialog.get_by_label('State', exact=False)).not_to_be_checked()

            # Explicit Banner recovery enables the position and restores Formats.
            dialog.get_by_label('Media type', exact=False).select_option('banner')
            dialog.get_by_label('State', exact=False).check()
            dialog.get_by_role('button', name='Save changes', exact=True).click()
            expect(dialog).to_have_count(0)
            assert saved()['mediaType'] == 'banner' and saved()['enabled'] is True
            card = page.locator('.ad-unit-card').filter(has=page.locator('code').filter(has_text='Billboard'))
            expect(card.get_by_role('button', name='Formats', exact=True)).to_be_visible()
            screen('recovered-banner')
            assert not errors, errors
            results.append({'width': width, 'inactiveSave': True, 'rejectedEnableNoWrites': True,
                            'cancelReloadPreserved': True, 'explicitBannerRecovery': True})
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
print('2/2 desktop/mobile inactive-media save, rejected enable, Cancel/reload and Banner recovery passed.')
