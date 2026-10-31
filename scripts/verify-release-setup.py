"""Reported missing-Prebid state, actual main React components + real services."""
import base64,json,re,subprocess,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/site-workspace-evidence';out.mkdir(exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/site-workspace-browser-fixture.mjs','--release-setup'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
requests=[];errors=[]
def route(request):
    url=urlsplit(request.request.url)
    assert url.netloc=='tessera.fixture.invalid'
    body={'path':url.path,'method':request.request.method,'body':request.request.post_data}
    process.stdin.write(json.dumps(body)+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    requests.append(body);assert result['status'] in (200,201),result
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
    page.get_by_role('button',name='Script setup',exact=True).click()
    page.get_by_role('radio',name='GAM + Prebid',exact=False).wait_for()
    assert page.get_by_role('button',name='Save script setup',exact=True).is_disabled()
    page.get_by_role('radio',name='GAM / AdX only',exact=False).check()
    assert page.get_by_role('button',name='Save script setup',exact=True).is_enabled()
    assert page.get_by_role('button',name='Open Prebid.js',exact=True).count()==0
    version=page.get_by_role('combobox',name='Script version',exact=True)
    assert version.count()==1
    options=version.locator('option').evaluate_all('(items)=>items.map(item=>({label:item.textContent.trim(),value:item.value}))')
    assert options and all(re.fullmatch(r'\d+\.\d+\.\d+',item['label'].split(' · ')[0]) for item in options),options
    assert not any('preview' in item['label'].lower() for item in options),options
    chosen='3.14.0'
    version.select_option(next(item['value'] for item in options if item['label'].split(' · ')[0]==chosen))
    assert page.get_by_text('Frozen engine',exact=True).count()==0
    assert all(r['method']=='GET' for r in requests)
    page.get_by_role('button',name='Save script setup',exact=True).click()
    page.get_by_role('status').filter(has_text='Script setup saved').wait_for()
    saves=[json.loads(request['body']) for request in requests if request['method']=='POST']
    assert len(saves)==1 and saves[0]['action']=='setup' and saves[0]['runtime']['runtimeVersion']==chosen and saves[0]['enablePrebid'] is False,saves
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'simple-adx-mobile.png'),full_page=True)
    # Return to the real Releases wrapper: setup persists, no profile or Prebid required.
    page.goto('https://tessera.fixture.invalid/setup')
    page.get_by_role('button',name='Change script setup',exact=True).wait_for()
    page.get_by_role('button',name='Generate and save package',exact=True).click()
    page.get_by_role('status').filter(has_text='Package saved in Releases').wait_for()
    with page.expect_download() as download:
        page.get_by_role('button',name='Download saved ZIP',exact=True).click()
    path=out/'simple-adx.zip';download.value.save_as(path)
    with zipfile.ZipFile(path) as package:
        assert 'prebid.js' not in package.namelist()
        assert 'prebid.js' not in package.read('implementation.html').decode()
        config=json.loads(package.read('config.json'))
        assert config['prebidBuild'] is None
        assert config['runtime']['runtimeVersion']==chosen
        assert json.loads(package.read('manifest.json'))['runtime']==config['runtime']
    page.set_viewport_size({'width':1280,'height':900})
    page.screenshot(path=str(out/'simple-adx-desktop-releases.png'),full_page=True)
    assert not errors,errors
    browser.close()
    (out/'release-setup-result.json').write_text(json.dumps({'passed':True,'requests':requests,'errors':errors},indent=2))
    print('PASS main Releases missing-Prebid recovery, one-save GAM-only setup, preserved choice and downloaded ZIP without Prebid')
finally:
 process.stdin.close();process.wait(timeout=10)
