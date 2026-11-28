"""Actual React + authenticated local Worker controls; no publisher or hosted requests."""
import base64
import json
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/runtime-controls-validation-ui'
out.mkdir(parents=True, exist_ok=True)
origin = 'https://admin-audit.fixture.invalid'
results = []

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'])
    for width in [1440, 390]:
        for legacy in [False, True]:
            command = ['node', '--experimental-strip-types', '--experimental-loader', './tests/support/ts-extension-loader.mjs',
                       'scripts/admin-audit-browser-fixture.mjs', '--runtime=3.19.0']
            if legacy:
                command.append('--saved-unsupported-sticky')
            proc = subprocess.Popen(command, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            assert json.loads(proc.stdout.readline())['ready']
            page = browser.new_page(viewport={'width': width, 'height': 1000})
            errors, puts = [], []
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
                body = json.loads(request.post_data) if request.post_data else None
                if request.method == 'PUT' and url.path.endswith('/runtime-controls'):
                    puts.append(body)
                value = send(url.path + ('?' + url.query if url.query else ''), request.method, body)
                r.fulfill(status=value['status'], headers=value['headers'], body=base64.b64decode(value['body']))

            page.route('**/*', route)

            def screen(name):
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Horizontal overflow'
                page.screenshot(path=str(out / f'{name}-{width}-legacy-{legacy}.png'), full_page=True)

            try:
                page.goto(origin + '/', wait_until='domcontentloaded')
                page.get_by_role('button', name='Runtime controls', exact=True).click()
                expect(page.get_by_role('heading', name='Runtime controls', exact=True)).to_be_visible()
                top = page.get_by_label('Top sticky ad unit', exact=False)
                portal = page.get_by_role('checkbox', name='Allow close-button portal fallback', exact=False)
                save = page.get_by_role('button', name='Save runtime controls', exact=True)
                state = data('/api/publishers/main-site/runtime-controls')
                assert state['unsupportedStickyControls'] is True
                if legacy:
                    expect(top).to_have_value('Billboard')
                    expect(top).to_be_enabled()
                    assert top.locator('option[value=P1]').evaluate('(option) => option.disabled'), 'A different unsupported Top Sticky must not be selectable'
                    expect(portal).to_be_checked()
                    expect(portal).to_be_enabled()
                    expect(page.get_by_role('status').filter(has_text='Saved Top Sticky')).to_be_visible()
                    save.click()
                    expect(page.get_by_role('status').filter(has_text='Runtime controls saved')).to_be_visible()
                    preserved = data('/api/publishers/main-site/runtime-controls')['controls']['sticky']
                    assert preserved['topAdUnitId'] == 'Billboard' and preserved['allowClosePortal'] is True
                    page.get_by_role('status').filter(has_text='Saved Top Sticky').scroll_into_view_if_needed()
                    screen('saved-unsupported-visible')
                    top.select_option('')
                    portal.uncheck()
                    save.click()
                    expect(page.get_by_role('status').filter(has_text='Runtime controls saved')).to_be_visible()
                    expect(top).to_be_disabled()
                    expect(portal).to_be_disabled()
                    cleared = data('/api/publishers/main-site/runtime-controls')['controls']['sticky']
                    assert cleared['topAdUnitId'] is None and cleared['allowClosePortal'] is False
                    top.scroll_into_view_if_needed()
                    screen('explicitly-disabled')
                else:
                    expect(top).to_be_disabled()
                    expect(portal).to_be_disabled()
                    hard = page.get_by_label('Global hard floor', exact=True)
                    bidder = page.get_by_label('pubmatic', exact=True)
                    hard.fill('1001')
                    save.click()
                    expect(page.get_by_role('alert')).to_contain_text('Global hard floor must be a number between 0 and 1000')
                    expect(hard).to_have_value('1001')
                    hard.fill('0')
                    bidder.fill('1001')
                    save.click()
                    expect(page.get_by_role('alert')).to_contain_text('Bidder floor "pubmatic" must be a number between 0 and 1000')
                    expect(bidder).to_have_value('1001')
                    bidder.fill('1000')
                    page.get_by_role('button', name='＋ Rule', exact=True).click()
                    key = page.get_by_label('Floor rule 1 key', exact=True)
                    value = page.get_by_label('Floor rule 1 value', exact=True)
                    key.fill('*|*|*|*|*')
                    value.fill('1001')
                    save.click()
                    expect(page.get_by_role('alert')).to_contain_text('Floor rule "*|*|*|*|*" must be a number between 0 and 1000')
                    expect(value).to_have_value('1001')
                    assert len(puts) == 0, 'Invalid floor edits must be explained before Save reaches the server'
                    assert page.get_by_role('alert').evaluate('(el) => { const r=el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }'), 'Save error must be brought into view'
                    screen('floor-range-error')
                    value.fill('')
                    save.click()
                    expect(page.get_by_role('alert')).to_contain_text('must be a number between 0 and 1000')
                    value.fill('0')
                    page.get_by_role('button', name='＋ Rule', exact=True).click()
                    page.get_by_label('Floor rule 2 key', exact=True).fill('*|*|*|*|*')
                    page.get_by_label('Floor rule 2 value', exact=True).fill('1')
                    save.click()
                    expect(page.get_by_role('alert')).to_contain_text('is duplicated')
                    assert len(puts) == 0, 'Duplicate keys must not overwrite one another silently'
                    page.locator('.runtime-floor-rule-row').last.get_by_role('button', name='Remove floor rule', exact=True).click()
                    save.click()
                    expect(page.get_by_role('status').filter(has_text='Runtime controls saved')).to_be_visible()
                    saved = data('/api/publishers/main-site/runtime-controls')['controls']['floors']
                    assert saved['hardFloor'] == 0 and saved['bidderFloors']['pubmatic'] == 1000 and saved['rules']['*|*|*|*|*'] == 0
                    page.reload(wait_until='domcontentloaded')
                    page.get_by_role('button', name='Runtime controls', exact=True).click()
                    expect(page.get_by_label('pubmatic', exact=True)).to_have_value('1000')
                    expect(page.get_by_label('Floor rule 1 value', exact=True)).to_have_value('0')
                    screen('saved-floor-boundaries')
                    page.get_by_role('button', name='Ad units', exact=True).click()
                    card = page.locator('.ad-unit-card').filter(has=page.locator('code').filter(has_text='Billboard'))
                    card.get_by_role('button', name='Edit', exact=True).click()
                    dialog = page.get_by_role('dialog', name='Edit Billboard', exact=True)
                    expect(dialog.get_by_text('Built-in scripts use Banner.', exact=False)).to_be_visible()
                    media = dialog.get_by_label('Media type', exact=False)
                    media.select_option('video')
                    dialog.get_by_role('button', name='Save changes', exact=True).click()
                    expect(dialog.get_by_role('alert')).to_contain_text('Banner')
                    expect(media).to_have_value('video')
                    screen('unsupported-media-error')
                    media.select_option('banner')
                    dialog.get_by_role('button', name='Save changes', exact=True).click()
                    expect(dialog).to_have_count(0)
                assert not errors, errors
                results.append({'width': width, 'legacyUnsupportedSettings': legacy, 'passed': True})
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
print('4/4 desktop/mobile floor validation, unsupported controls preservation/removal and media recovery checks passed.')
