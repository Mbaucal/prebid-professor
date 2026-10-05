"""Real React editor + real package service; all browser requests intercepted."""
import base64,json,subprocess,hashlib
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/ab-editor-ui';out.mkdir(exist_ok=True)
process=subprocess.Popen(['node','scripts/ab-editor-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert json.loads(process.stdout.readline())['ready']
errors=[];requests=[];checks=[];last_generated=None
def check(name,condition):
    assert condition,name
    checks.append(name)
def route(request):
    global last_generated
    url=urlsplit(request.request.url)
    assert url.netloc=='tessera.fixture.invalid','Unexpected external request'
    payload={'path':url.path+('?' + url.query if url.query else ''),'method':request.request.method,'body':request.request.post_data}
    process.stdin.write(json.dumps(payload)+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    requests.append({'method':payload['method'],'status':result['status']})
    body=base64.b64decode(result['body'])
    if payload['method']=='POST' and result['status'] in [200,201]:last_generated=json.loads(body)['package']
    request.fulfill(status=result['status'],headers=result['headers'],body=body)
try:
 with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':1000});page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('https://tessera.fixture.invalid/')
    page.get_by_role('button',name='Generate and save A/B package',exact=True).wait_for()
    page.screenshot(path=str(out/'initial.png'),full_page=True)
    check('Opening the editor is read-only',all(r['method']=='GET' for r in requests))
    check('Baseline and publication scope are visible',page.get_by_text('Starting point: Tanjug',exact=False).is_visible() and page.get_by_text('The active Pages deployment is not tracked here.',exact=False).is_visible())
    page.get_by_label('Traffic to variant B (%)',exact=False).fill('10')
    for variant in ['A','B']:
        arm=page.get_by_role('group',name='Variant '+variant,exact=True)
        arm.get_by_label('Refresh',exact=True).select_option('fixed')
        arm.get_by_label('Standard interval (seconds)',exact=True).fill('10')
    page.get_by_label('Package note',exact=True).fill('90/10 cache comparison')
    page.get_by_role('button',name='Generate and save A/B package',exact=True).click()
    page.get_by_role('status').filter(has_text='New A/B package saved').wait_for()
    saved=last_generated.copy()
    check('UI inputs are consumed by generation',saved['settings']['trafficBPercent']==10 and saved['settings']['arms']['A']['refreshSeconds']==10 and saved['settings']['arms']['B']['refreshSeconds']==10)
    page.screenshot(path=str(out/'desktop.png'),full_page=True)
    with page.expect_download() as download:page.get_by_role('button',name='Download A/B ZIP',exact=True).click()
    download.value.save_as(str(out/'download.zip'))
    check('Downloaded bytes match the immutable saved package',hashlib.sha256((out/'download.zip').read_bytes()).hexdigest()==saved['sha256'])
    page.reload()
    page.get_by_role('button',name='Use these settings',exact=True).click()
    check('Saved settings can be restored after reload',page.get_by_label('Traffic to variant B (%)',exact=False).input_value()=='10')
    for variant in ['A','B']:
        arm=page.get_by_role('group',name='Variant '+variant,exact=True)
        check('Saved interval restored for '+variant,arm.get_by_label('Standard interval (seconds)',exact=True).input_value()=='10')
    page.get_by_role('button',name='Generate and save A/B package',exact=True).click()
    page.get_by_role('status').filter(has_text='already saved').wait_for()
    check('Identical settings preserve history',page.get_by_role('button',name='Download A/B ZIP',exact=True).count()==1 and last_generated['sha256']==saved['sha256'])
    page.set_viewport_size({'width':390,'height':844})
    page.get_by_text('Package details',exact=True).click()
    check('Long package identities do not overflow mobile layout',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
    page.screenshot(path=str(out/'mobile.png'),full_page=True)
    page.get_by_label('Traffic to variant B (%)',exact=False).fill('90')
    page.get_by_role('button',name='Generate and save A/B package',exact=True).click()
    page.get_by_role('status').filter(has_text='New A/B package saved').wait_for()
    check('Changed inputs create a new version',page.get_by_role('button',name='Download A/B ZIP',exact=True).count()==2 and last_generated['release']!=saved['release'])
    check('No unhandled UI error',not errors)
    browser.close()
finally:
 process.stdin.close();process.wait(timeout=10)
(out/'report.json').write_text(json.dumps({'checks':checks,'passed':len(checks),'failed':0,'errors':errors,'requests':requests},indent=2))
print(json.dumps({'passed':len(checks),'failed':0}))
