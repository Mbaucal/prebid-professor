"""CI browser regression against the real React dashboard and TEST agency module."""
import base64, json, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/agency-evidence';out.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','scripts/agency-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
checks=[]
try:
    assert 'ready' in process.stdout.readline()
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':960})
        errors=[];external=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        def route(r):
            if r.request.url.startswith('http://127.0.0.1:4183/') or r.request.url.startswith('data:'):r.continue_()
            else:external.append(r.request.url);r.abort()
        page.route('**/*',route)
        for path in ['/', '/agencies']:
            page.goto('http://127.0.0.1:4183'+path)
            page.get_by_role('button',name='Agencies',exact=True).click()
            expect(page.locator('.agency-assignment')).to_have_count(3)
            for name in ['Example Agency','Second Agency']:
                page.get_by_role('button',name='New agency',exact=False).click()
                page.get_by_label('Agency name',exact=True).fill(name)
                if name=='Example Agency':
                    # Browser-generated valid PNG; image upload is re-encoded by the actual component.
                    png=page.evaluate("() => {const c=document.createElement('canvas');c.width=64;c.height=32;const x=c.getContext('2d');x.fillStyle='#ff6d22';x.fillRect(0,0,64,32);return c.toDataURL().split(',')[1]}")
                    page.locator('dialog input[type=file]').set_input_files({'name':'logo.png','mimeType':'image/png','buffer':base64.b64decode(png)})
                    expect(page.locator('dialog .agency-logo img')).to_be_visible()
                page.get_by_role('button',name='Save agency',exact=True).click()
                expect(page.get_by_role('dialog')).to_have_count(0)
            row=page.locator('.agency-assignment').filter(has_text='Example Publisher')
            row.get_by_role('combobox').select_option(label='Example Agency')
            row.get_by_role('button',name='Save assignment').click()
            expect(row.get_by_role('status')).to_have_text('Agency saved.')
            row.get_by_role('button',name='Example Publisher',exact=True).click()
            page.locator('.site-link').filter(has_text='site12.example.com').click()
            expect(page.locator('.agency-selection-breadcrumb')).to_contain_text('Example Agency / Example Publisher / site12.example.com')
            page.locator('.agency-overview').screenshot(path=str(out/f'{"main" if path=="/" else "test"}-agency-overview.png'))
            # Expanding/collapsing groups does not select a different site.
            group=page.locator('.agency-tree-heading').filter(has_text='Example Agency')
            group.click();expect(page.locator('.workspace h1')).to_have_text('site12.example.com')
            group.click()
            toggle=page.get_by_role('button',name='Toggle sites for Example Publisher',exact=True)
            toggle.click();expect(page.locator('.workspace h1')).to_have_text('site12.example.com')
            search=page.get_by_label('Search hierarchy',exact=True)
            search.fill('site12.example.com');expect(page.locator('.publisher-tree-group')).to_have_count(1)
            expect(page.locator('.site-link:not(.add-site-link)')).to_have_count(1)
            search.fill('Second Agency');expect(page.locator('.agency-tree-heading')).to_have_count(1)
            search.fill('no-such-agency');expect(page.get_by_text('No matching agencies, publishers or sites.')).to_be_visible()
            search.fill('');toggle.click()
            page.get_by_role('button',name='Agencies',exact=True).click()
            row=page.locator('.agency-assignment').filter(has_text='Example Publisher')
            row.get_by_role('combobox').select_option(label='Second Agency');row.get_by_role('button',name='Save assignment').click()
            expect(row.get_by_role('status')).to_have_text('Agency saved.')
            page.reload();page.get_by_role('button',name='Agencies',exact=True).click()
            row=page.locator('.agency-assignment').filter(has_text='Example Publisher')
            expect(row.get_by_role('combobox').locator('option:checked')).to_have_text('Second Agency')
            card=page.locator('.agency-card').filter(has=page.get_by_role('heading',name='Example Agency',exact=True))
            expect(card.locator('img')).to_be_visible()
            card.get_by_role('button',name='Edit Example Agency',exact=True).click()
            page.get_by_label('Agency name',exact=True).fill('Agency renamed')
            page.get_by_role('button',name='Remove logo',exact=True).click();page.get_by_role('button',name='Save agency',exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            row.get_by_role('combobox').select_option(label='Without agency');row.get_by_role('button',name='Save assignment').click()
            expect(row.get_by_role('status')).to_have_text('Agency saved.')
            page.locator('.agency-card').filter(has=page.get_by_role('heading',name='Agency renamed',exact=True)).get_by_role('button',name='Open publishers').click()
            expect(page.locator('.publisher-tree-group')).to_have_count(0)
            expect(page.locator('.workspace h1')).to_contain_text('No publisher') if path=='/agencies' else expect(page.get_by_role('heading',name='No publisher selected')).to_be_visible()
            for width,height in [(1440,960),(1024,720),(390,844),(320,640)]:
                page.set_viewport_size({'width':width,'height':height})
                if width<=760:page.get_by_role('button',name='Menu',exact=True).click()
                page.get_by_role('button',name='Agencies',exact=True).click()
                expect(page.locator('.agency-page')).to_be_visible()
                assert page.evaluate('scrollY===0 && document.documentElement.scrollHeight<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth+1')
                before=page.locator('.topbar').bounding_box()
                page.locator('.workspace-content').evaluate('(e)=>e.scrollTop=e.scrollHeight')
                assert before==page.locator('.topbar').bounding_box()
                page.screenshot(path=str(out/f'{"main" if path=="/" else "test"}-{width}.png'))
            checks.append({'page':path,'createLogoAssignMoveReloadSearchCollapseFilterMobile':True})
            page.set_viewport_size({'width':1440,'height':960})
        assert not errors,errors
        assert not external,external
        browser.close()
    (out/'result.json').write_text(json.dumps({'checks':checks,'errors':errors,'external':external},indent=2))
    print('PASS: agency CRUD, logo, assign/move/unassign, reload, search, collapse, empty filter and fixed mobile/desktop layout')
finally:
    process.terminate();process.wait(timeout=10)
