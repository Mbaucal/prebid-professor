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
    page.goto('https://tessera.fixture.invalid/site-workspace')
    page.get_by_label('Script version',exact=True).select_option(label='3.10.0-tessera.preview.1')
    page.get_by_role('checkbox',name='Use this Preview script').check()
    page.get_by_role('button',name='Save script version',exact=True).click()
    page.get_by_role('status').filter(has_text='Script version saved').wait_for()
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
    page.get_by_role('button',name='Script versions',exact=True).click()
    page.get_by_role('button',name='Download candidate ZIP',exact=True).wait_for()
    with page.expect_download() as download:
        page.get_by_role('button',name='Download candidate ZIP',exact=True).click()
    assert download.value.suggested_filename=='test-site-candidate.zip'
    page.get_by_role('status').filter(has_text='Candidate downloaded').wait_for()
    page.screenshot(path=str(out/'mobile-versions.png'),full_page=True)
    assert not errors,errors
    browser.close()
    (out/'result.json').write_text(json.dumps({'passed':True,'pageErrors':errors,'requests':requests,'externalRequests':0},indent=2))
    print('PASS shared React version selection, saved TakeOver controls, mobile layout and real generated ZIP')
finally:
 process.stdin.close();process.wait(timeout=10)
