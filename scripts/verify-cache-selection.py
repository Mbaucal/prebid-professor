"""Both TEST editors and exact downloaded package via ephemeral SQLite/fake R2."""
import base64,json,subprocess,zipfile,io
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
out=Path('.generated/cache-selection-evidence');out.mkdir(exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','scripts/site-workspace-browser-fixture.mjs','--cache'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert json.loads(process.stdout.readline())['ready']
errors=[];requests=[];checks=[]
def check(name,ok):
    assert ok,name
    checks.append(name)
def route(r):
    url=urlsplit(r.request.url);assert url.netloc=='tessera.fixture.invalid','External request forbidden'
    payload={'path':url.path,'method':r.request.method,'body':r.request.post_data}
    process.stdin.write(json.dumps(payload)+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    requests.append({'path':url.path,'method':payload['method'],'status':result['status']})
    r.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
try:
 with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);context=browser.new_context(accept_downloads=True,viewport={'width':1280,'height':900})
    context.route('**/*',route);context.on('page',lambda page:page.on('pageerror',lambda e:errors.append(str(e))))
    page=context.new_page();page.goto('https://tessera.fixture.invalid/runtime-selection')
    page.locator('#runtime').select_option(label='3.13.0 · preview')
    page.locator('#allow-preview').check()
    check('Selecting version alone cannot save implicit cache rules',page.locator('#save-selection').is_disabled())
    page.locator('#cache-mode').select_option('auction-with-cache');page.locator('#cache-age').fill('30')
    check('Age warning explains unchanged refresh interval','30-second-or-longer' in page.locator('#cache-age-note').inner_text())
    page.locator('#cache-age').fill('60');page.locator('#allow-preview').check();page.locator('#save-selection').click()
    page.locator('#message').filter(has_text='Runtime selection saved').wait_for();page.reload()
    page.locator('#saved').filter(has_text='3.13.0').wait_for()
    check('Plain editor reload retains explicit saved mode and age',page.locator('#cache-mode').input_value()=='auction-with-cache' and page.locator('#cache-age').input_value()=='60')
    react=context.new_page();react.goto('https://tessera.fixture.invalid/site-workspace')
    react.get_by_label('Auction mode',exact=True).wait_for()
    check('React editor reads same saved rules',react.get_by_label('Auction mode',exact=True).input_value()=='auction-with-cache' and react.get_by_label('Maximum bid age (seconds)',exact=True).input_value()=='60')
    react.get_by_label('Auction mode',exact=True).select_option('fresh-only');react.get_by_label('Maximum bid age (seconds)',exact=True).fill('301');react.get_by_role('checkbox',name='Use this script version').check()
    check('React rejects out-of-range age before saving',react.get_by_role('button',name='Save script version',exact=True).is_disabled())
    react.get_by_label('Maximum bid age (seconds)',exact=True).fill('90')
    check('Changing rules resets approval',not react.get_by_role('checkbox',name='Use this script version').is_checked())
    react.get_by_role('checkbox',name='Use this script version').check();react.get_by_role('button',name='Save script version',exact=True).click()
    react.get_by_role('status').filter(has_text='Script version saved').wait_for()
    page.locator('#cache-age').fill('120');page.locator('#allow-preview').check();page.locator('#save-selection').click()
    page.locator('#message.error').wait_for()
    check('Stale plain editor cannot overwrite React update',page.locator('#save-selection').is_disabled())
    page.locator('#reload-selection').click();page.locator('#message').filter(has_text='Choose a version').wait_for()
    check('Reload recovers latest rules after stale rejection',page.locator('#cache-mode').input_value()=='fresh-only' and page.locator('#cache-age').input_value()=='90')
    with react.expect_download() as download:react.get_by_role('button',name='Download candidate ZIP',exact=True).click()
    with zipfile.ZipFile(download.value.path()) as z:
        config=json.loads(z.read('config.json'));manifest=json.loads(z.read('manifest.json'))
    check('Downloaded candidate contains saved rules and immutable 3.13 pin',config['bidCache']=={'mode':'fresh-only','maxAgeSeconds':90} and manifest['runtime']['runtimeVersion']=='3.13.0')
    for current,label in [(page,'plain'),(react,'react')]:
        current.set_viewport_size({'width':390,'height':844})
        check(label+' fits phone width',current.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
        check(label+' editor never executes ads',current.evaluate("typeof window.pbjs==='undefined' && typeof window.__tesseraRuntimeDiagnostics==='undefined'"))
        current.screenshot(path=str(out/(label+'.png')),full_page=True)
    check('No JavaScript errors',not errors)
    browser.close()
    report={'scope':'Ephemeral TEST editors and downloaded package; no hosted writes or ad traffic','checks':checks,'passed':len(checks),'requests':requests,'errors':errors}
    (out/'browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
finally:
    process.stdin.close();process.wait(timeout=10)
