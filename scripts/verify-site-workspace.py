"""Shared React controls + real Worker/SQLite, all browser requests intercepted."""
import base64,json,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/site-workspace-evidence';out.mkdir(exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','scripts/site-workspace-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert json.loads(process.stdout.readline())['ready']
errors=[];requests=[]
def route(request):
    url=urlsplit(request.request.url)
    assert url.netloc=='tessera.fixture.invalid','Unexpected external request'
    payload={'path':url.path,'method':request.request.method,'body':request.request.post_data}
    process.stdin.write(json.dumps(payload)+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    requests.append({'path':url.path,'method':payload['method'],'status':result['status']})
    request.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
try:
 with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900});page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('https://tessera.fixture.invalid/')
    page.get_by_role('link',name='Loading rules',exact=True).click()
    assert page.url=='https://tessera.fixture.invalid/site-workspace#loading'
    page.get_by_role('heading',name='Effective behavior by ad unit',exact=True).wait_for()
    page.locator('.runtime-loading-table').get_by_text('Script setup required',exact=True).first.wait_for()
    page.reload()
    page.locator('.runtime-loading-table').get_by_text('Script setup required',exact=True).first.wait_for()
    assert all(r['method']=='GET' for r in requests)
    page.goto('https://tessera.fixture.invalid/')
    page.get_by_role('link',name='Generate and releases',exact=True).click()
    assert page.url=='https://tessera.fixture.invalid/site-workspace#packages'
    page.get_by_role('heading',name='Script setup',exact=True).wait_for()
    assert page.get_by_role('button',name='Generate and save package',exact=True).is_disabled()
    assert all(r['method']=='GET' for r in requests)
    page.get_by_role('radio',name='GAM / AdX only',exact=False).check()
    assert page.get_by_role('combobox',name='Script version',exact=True).count()==0
    page.screenshot(path=str(out/'desktop-script-setup.png'),full_page=True)
    page.get_by_role('button',name='Save script setup',exact=True).click()
    page.get_by_role('button',name='Generate and save package',exact=True).wait_for(state='visible')
    page.get_by_role('button',name='Change script setup',exact=True).wait_for()
    page.get_by_role('button',name='Ad positions',exact=True).click()
    page.get_by_role('button',name='Configure Billboard',exact=True).click()
    page.get_by_label('Display',exact=True).select_option('takeover')
    page.get_by_label('Minimum interval in this tab (minutes)',exact=True).fill('20')
    page.get_by_role('button',name='Save position settings',exact=True).click()
    page.get_by_role('status').filter(has_text='Position settings saved').wait_for()
    page.get_by_role('button',name='Reload saved settings',exact=True).click()
    page.get_by_role('status').filter(has_text='Saved settings loaded').wait_for()
    page.get_by_role('button',name='Configure Billboard',exact=True).click()
    assert page.get_by_label('Minimum interval in this tab (minutes)',exact=True).input_value()=='20'
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'mobile-position.png'),full_page=True)
    page.get_by_role('button',name='Cancel',exact=True).click()
    before_loading=len(requests)
    page.get_by_role('button',name='Loading rules',exact=True).click()
    assert page.url.endswith('#loading')
    page.locator('.runtime-loading-table').get_by_text('TakeOver · after consent',exact=True).wait_for()
    page.reload()
    page.locator('.runtime-loading-table').get_by_text('Automatic · Sticky',exact=True).wait_for()
    page.get_by_role('button',name='Reload loading rules',exact=True).click()
    page.locator('.runtime-loading-table').get_by_text('TakeOver · after consent',exact=True).wait_for()
    assert all(r['method']=='GET' for r in requests[before_loading:])
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'mobile-loading-rules.png'),full_page=True)
    page.set_viewport_size({'width':1280,'height':900})
    page.screenshot(path=str(out/'desktop-loading-rules.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})

    page.get_by_role('button',name='Script setup',exact=True).click()
    page.get_by_role('button',name='Continue to Generate',exact=True).wait_for()
    page.get_by_role('button',name='Change version',exact=True).click()
    assert page.get_by_label('Script version',exact=True).locator('option:checked').inner_text()=='3.10.0'
    page.screenshot(path=str(out/'mobile-versions.png'),full_page=True)
    page.get_by_role('button',name='Generate and releases',exact=True).click()
    page.get_by_label('What changed?',exact=True).fill('Browser package check')
    page.get_by_role('button',name='Generate and save package',exact=True).click()
    page.get_by_role('status').filter(has_text='Package saved in Releases').wait_for()
    page.get_by_text('Browser package check',exact=True).wait_for()
    page.get_by_role('button',name='Reload releases',exact=True).click()
    page.get_by_text('Browser package check',exact=True).wait_for()
    with page.expect_download() as stored_download:
        page.get_by_role('button',name='Download saved ZIP',exact=True).click()
    assert stored_download.value.suggested_filename.startswith('builtin-draft-')
    assert page.get_by_role('link',name='TEST deployments',exact=True).get_attribute('href')=='/deployments'
    assert page.get_by_role('button',name='Publish package',exact=True).count()==0
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'mobile-packages.png'),full_page=True)
    before=len(requests)
    # Existing bookmarks open the generator directly after removing the guide.
    page.goto('https://tessera.fixture.invalid/site-workspace#workflow')
    page.reload()
    page.get_by_text('Browser package check',exact=True).wait_for()
    assert page.get_by_role('button',name='Build workflow',exact=True).count()==0
    assert all(r['method']=='GET' for r in requests[before:])
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'mobile-generator-bookmark.png'),full_page=True)
    page.get_by_role('button',name='Test page',exact=True).click()
    page.get_by_label('Saved package',exact=True).wait_for()
    link=page.get_by_role('link',name='Open test page',exact=True)
    assert link.get_attribute('href').startswith('/test-api/site-test-page/builtin-draft-')
    assert link.get_attribute('target')=='_blank'
    assert all(r['method']=='GET' for r in requests[before:])
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'mobile-test-page-section.png'),full_page=True)
    assert not errors,errors
    browser.close()
    (out/'result.json').write_text(json.dumps({'passed':True,'pageErrors':errors,'requests':requests,'externalRequests':0},indent=2))
    print('PASS shared React version selection, saved TakeOver controls, mobile layout and real generated ZIP')
finally:
 print(json.dumps({'pageErrors':errors,'requests':requests}))
 process.stdin.close();process.wait(timeout=10)
