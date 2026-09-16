"""Reported missing-Prebid state, actual main React components + real services."""
import base64,json,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/site-workspace-evidence';out.mkdir(exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','scripts/site-workspace-browser-fixture.mjs','--release-setup'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
requests=[];errors=[]
def route(request):
    url=urlsplit(request.request.url)
    assert url.netloc=='tessera.fixture.invalid'
    body={'path':url.path,'method':request.request.method,'body':request.request.post_data}
    process.stdin.write(json.dumps(body)+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    requests.append(body);assert result['status']==200,result
    request.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
try:
 assert json.loads(process.stdout.readline())['ready']
 with sync_playwright() as p:
    browser=p.chromium.launch()
    page=browser.new_page(viewport={'width':390,'height':844});page.route('**/*',route)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('https://tessera.fixture.invalid/setup')
    page.get_by_text('No current Prebid file',exact=False).wait_for()
    assert page.get_by_role('button',name='Generate and save package',exact=True).is_disabled()
    assert page.get_by_text('Choose a generator profile',exact=False).count()==0
    assert not any('/validate' in r['path'] for r in requests)
    page.get_by_role('button',name='Open Prebid.js',exact=True).click()
    page.get_by_role('heading',name='Prebid.js destination',exact=True).wait_for()
    page.get_by_role('button',name='Script versions',exact=True).click()
    page.get_by_label('Script version',exact=True).select_option(label='3.10.0')
    page.get_by_role('checkbox',name='Use this script version').check()
    assert page.get_by_role('button',name='Save script version',exact=True).is_disabled()
    assert page.get_by_role('button',name='Download candidate ZIP',exact=True).is_disabled()
    assert page.get_by_label('Script version',exact=True).locator('option',has_text='preview').count()==0
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'missing-prebid-versions.png'),full_page=True)
    page.get_by_role('button',name='Open Prebid.js',exact=True).click()
    page.get_by_role('heading',name='Prebid.js destination',exact=True).wait_for()
    assert all(r['method']=='GET' for r in requests)
    assert not errors,errors
    browser.close()
    (out/'release-setup-result.json').write_text(json.dumps({'passed':True,'requests':requests,'errors':errors},indent=2))
    print('PASS main Releases setup, Prebid navigation, short version labels and no writes')
finally:
 process.stdin.close();process.wait(timeout=10)
