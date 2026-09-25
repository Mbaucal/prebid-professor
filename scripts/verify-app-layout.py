"""CI regression: actual dashboard and shared TEST frame, synthetic data only."""
import json, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
out = root / '.generated/layout-evidence'
out.mkdir(parents=True, exist_ok=True)
process = subprocess.Popen(['node', 'scripts/layout-ui-fixture.mjs'], cwd=root, stdout=subprocess.PIPE, text=True)
checks = []
try:
    assert 'ready' in process.stdout.readline()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        page = browser.new_page()
        errors, external, writes = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        def route(request):
            if not request.request.url.startswith('http://127.0.0.1:4182/'):
                external.append(request.request.url)
                request.abort()
            else:
                if request.request.method != 'GET': writes.append(request.request.url)
                request.continue_()
        page.route('**/*', route)
        for path in ['/', '/layout-preview']:
            for width, height in [(1440, 1000), (1024, 720), (800, 600), (1280, 400), (844, 390), (390, 844), (760, 500), (320, 640)]:
                page.set_viewport_size({'width': width, 'height': height})
                page.goto('http://127.0.0.1:4182' + path)
                expect(page.locator('.workspace h1')).to_have_text('site1.example.com')
                expect(page.locator('.publisher-tree-group')).to_have_count(12)
                content = page.locator('.workspace-content')
                sidebar = page.locator('.sidebar')
                header = page.locator('.topbar')
                tabs = page.locator('.tabbar')
                before = [node.bounding_box() for node in [sidebar, header, tabs]]
                content.evaluate('(e) => { e.scrollTop = e.scrollHeight; }')
                assert content.evaluate('(e) => e.scrollTop > 0'), (path, width, height, 'content must scroll')
                assert before == [node.bounding_box() for node in [sidebar, header, tabs]], 'frame moved with content'
                assert page.evaluate('scrollY === 0 && document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1'), (path, width, height, 'document overflow')
                if width > 760:
                    account = page.locator('.auth-account-card')
                    before_account = account.bounding_box()
                    publisher_list = page.locator('.sidebar-content')
                    publisher_list.evaluate('(e) => { e.scrollTop = e.scrollHeight; }')
                    assert publisher_list.evaluate('(e) => e.scrollTop > 0')
                    assert account.bounding_box() == before_account
                    box = publisher_list.bounding_box()
                    assert box['y'] + box['height'] <= before_account['y'] + 1, 'account overlaps publisher list'
                    assert abs(sidebar.bounding_box()['height'] - height) <= 1
                    expect(page.locator('.publisher-tree-group').last).to_be_in_viewport()
                else:
                    page.get_by_role('button', name='Menu', exact=True).click()
                    expect(page.get_by_role('button', name='Close menu', exact=True)).to_have_attribute('aria-expanded', 'true')
                    expect(page.locator('.auth-account-card')).to_be_in_viewport()
                    page.locator('.sidebar-content').evaluate('(e) => { e.scrollTop = e.scrollHeight; }')
                    expect(page.locator('.publisher-tree-group').last).to_be_in_viewport()
                    page.locator('.publisher-tree-group').last.locator('.site-link:not(.add-site-link)').click()
                    expect(page.locator('.workspace h1')).to_have_text('site12.example.com')
                    expect(page.get_by_role('button', name='Menu', exact=True)).to_have_attribute('aria-expanded', 'false')
                    assert content.evaluate('(e) => e.scrollTop == 0'), 'new site keeps old scroll'
                    # Off-screen tabs remain reachable by keyboard in their own horizontal scroller.
                    page.locator('.tab').last.focus()
                    expect(page.locator('.tab').last).to_be_in_viewport()
                page.screenshot(path=str(out / f'{"dashboard" if path == "/" else "preview"}-{width}x{height}.png'))
                checks.append({'page': path, 'width': width, 'height': height, 'passed': True})
            page.set_viewport_size({'width': 1440, 'height': 900})
            page.goto('http://127.0.0.1:4182' + path)
            expect(page.locator('.workspace h1')).to_have_text('site1.example.com')
            if path == '/':
                page.get_by_role('button', name='Edit site', exact=True).first.click()
                expect(page.get_by_role('dialog')).to_be_in_viewport()
                page.get_by_role('button', name='Cancel', exact=True).click()
                page.get_by_role('button', name='Edit publisher Example Digital News Publisher 1', exact=True).click()
                expect(page.get_by_role('dialog')).to_be_in_viewport()
                page.get_by_role('button', name='Cancel', exact=True).click()
            else:
                page.get_by_role('button', name='Creative templates', exact=True).click()
                expect(page.locator('.tabbar')).to_have_count(0)
                header_before = page.locator('.topbar').bounding_box()
                page.locator('.workspace-content').evaluate('(e) => { e.scrollTop = e.scrollHeight; }')
                assert header_before == page.locator('.topbar').bounding_box()
                page.get_by_role('button', name='O pregledu', exact=True).click()
                expect(page.get_by_role('dialog')).to_be_in_viewport()
                page.get_by_role('button', name='Close preview dialog', exact=True).click()
        page.goto('http://127.0.0.1:4182/layout-preview')
        page.get_by_role('button', name='Export', exact=True).click()
        expect(page.get_by_role('heading', name='Minimum-height CSS', exact=True)).to_be_visible()
        css = page.locator('.export-code').text_content()
        assert '/* 0–468px */' in css and '/* >= 1300px */' in css
        assert '#P1, #P2, #P3, #P4, #P5, #P6, #P7 { min-height: 250px; }' in css
        with page.expect_download() as pending:
            page.get_by_role('button', name='Download', exact=True).click()
        download = pending.value
        assert download.suggested_filename == 'min-height-example.css'
        assert Path(download.path()).read_text() == css
        page.context.grant_permissions(['clipboard-read', 'clipboard-write'])
        page.get_by_role('button', name='Copy', exact=True).click()
        expect(page.get_by_role('button', name='✓ Copied', exact=True)).to_be_visible()
        assert page.evaluate('navigator.clipboard.readText()') == css
        page.screenshot(path=str(out / 'minimum-height-css-export.png'))
        checks.append({'page': '/layout-preview', 'export': 'comments, grouped positions, exact copy and download', 'passed': True})
        assert not errors, errors
        assert not external, external
        assert not writes, writes
        browser.close()
        (out / 'result.json').write_text(json.dumps({'checks': checks, 'pageErrors': errors, 'externalRequests': external, 'writes': writes}, indent=2))
        print('PASS: 16 viewport cases; fixed frame, independent scrolling, account separation, compact navigation, tabs, modals; no writes or external traffic')
finally:
    process.terminate()
    process.wait(timeout=10)
