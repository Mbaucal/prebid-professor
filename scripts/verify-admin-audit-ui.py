"""Actual MAIN React/Worker audit regressions; SQLite/fake R2, no hosted ad traffic."""
import base64,json,os,subprocess,argparse
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
parser=argparse.ArgumentParser();parser.add_argument('--runtime',default='3.16.0');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent;out=root/'.generated/admin-audit-ui-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://admin-audit.fixture.invalid';endpoint='/api/publishers/main-site/builtin-site-settings';results=[]
with sync_playwright() as pw:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=pw.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/admin-audit-browser-fixture.mjs','--runtime='+args.runtime],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(proc.stdout.readline());assert ready['ready'] and ready['runtimeVersion']==args.runtime
   requests=[];errors=[];page=browser.new_page(viewport={'width':width,'height':1000});page.on('pageerror',lambda error:errors.append(str(error)))
   def send(path,method='GET',body=None):
    proc.stdin.write(json.dumps({'path':path,'method':method,'body':None if body is None else json.dumps(body)})+'\n');proc.stdin.flush();value=json.loads(proc.stdout.readline());assert 'error' not in value,value;return value
   def data(path):
    value=send(path);assert value['status']==200,value;return json.loads(base64.b64decode(value['body']))
   def route(route):
    request=route.request;url=urlsplit(request.url);assert url.netloc=='admin-audit.fixture.invalid','Unexpected external request'
    value=send(url.path,request.method,json.loads(request.post_data) if request.post_data else None);requests.append({'path':url.path,'method':request.method,'status':value['status']});route.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
   page.route('**/*',route)
   def screen(name,target=None):
    if target is not None:target.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal document overflow'
    page.screenshot(path=str(out/f'{args.runtime}-{name}-{width}.png'),full_page=True)
   def nav(name):page.get_by_role('button',name=name,exact=True).first.click()
   try:
    page.goto(origin+'/',wait_until='domcontentloaded');panel=page.get_by_role('region',name='Script setup',exact=True)
    expect(panel.get_by_text('User ID settings have not been saved.',exact=False)).to_be_visible()
    if ready['gapSupported']:
     expect(panel.get_by_text('Minimum wall-clock gap is saved',exact=False)).to_have_count(0)
     expect(panel.get_by_text('Refresh is disabled by this script',exact=False)).to_have_count(0)
    else:
     expect(panel.get_by_text('Minimum wall-clock gap is saved',exact=False)).to_be_visible()
     expect(panel.get_by_text('Refresh is disabled by this script',exact=False)).to_be_visible()
    screen('setup-warnings')
    nav('Unit rules');expect(page.get_by_role('heading',name='Effective behavior by ad unit',exact=True)).to_be_visible()
    row=page.locator('table.effective-rule-table tbody tr').filter(has=page.get_by_text('P1',exact=True));expect(row).to_have_count(1)
    expect(row.locator('td').nth(4)).to_contain_text('Sequence schedule' if ready['gapSupported'] else 'Disabled')
    if not ready['gapSupported']:expect(row.locator('td').nth(4)).to_contain_text('global refresh switch is off')
    screen('effective-refresh',page.locator('table.effective-rule-table'))
    before=data('/__fixture/snapshot')
    page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True)).get_by_role('button',name='Edit',exact=True).click()
    dialog=page.get_by_role('dialog');expect(dialog).to_be_visible();timeout=dialog.locator('input[type="number"][min="100"]');expect(timeout).to_have_attribute('max','30000');timeout.fill('1200');minimum=dialog.get_by_label('Minimum time',exact=False);minimum.fill('60');dialog.get_by_role('button',name='Save rule',exact=True).click()
    expect(dialog.locator('.form-error')).to_contain_text('Refresh schedules');expect(timeout).to_have_value('1200');expect(minimum).to_have_value('60');assert data('/__fixture/snapshot')==before,'Rejected save changed stored settings'
    screen('sequence-save-conflict',dialog.locator('.form-error'))
    minimum.fill('15');dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0);expect(row.locator('td').nth(2)).to_contain_text('1200 ms');after=data('/__fixture/snapshot');assert after['config']['advancedUnitRules']['P1']['timeout']==1200;assert after['config']['advancedUnitRules']['P1']['refresh']['schedule']==before['config']['advancedUnitRules']['P1']['refresh']['schedule'];screen('sequence-save-recovered',row)
    nav('Refresh schedules');expect(page.get_by_label('Prebid auction timeout',exact=False)).to_have_attribute('max','30000');screen('refresh-timeout-limit')
    nav('User ID modules');expect(page.get_by_text('Existing generated scripts use cookie sync off.',exact=False)).to_be_visible();screen('user-sync-unsaved')
    data('/__fixture/explicit-sync-off');off=data('/__fixture/snapshot')['config']['userSync'];nav('Script setup');expect(panel.get_by_role('radio',name='GAM + Prebid',exact=False)).to_be_checked();panel.get_by_role('radio',name='GAM / AdX only',exact=False).check();panel.get_by_role('button',name='Save script setup',exact=True).click();expect(panel.get_by_role('status').filter(has_text='Script setup saved')).to_be_visible()
    panel.get_by_role('radio',name='GAM + Prebid',exact=False).check();panel.get_by_role('button',name='Save script setup',exact=True).click();expect(panel.get_by_role('status').filter(has_text='Script setup saved')).to_be_visible();assert data('/__fixture/snapshot')['config']['userSync']==off;expect(panel.get_by_text('User ID settings have not been saved.',exact=False)).to_have_count(0);screen('explicit-sync-off-preserved')
    nav('Generate and releases');expect(page.get_by_role('button',name='Generate and save package',exact=True)).to_be_enabled()
    if ready['gapSupported']:expect(page.get_by_text('Minimum wall-clock gap is saved',exact=False)).to_have_count(0)
    else:expect(page.get_by_text('Minimum wall-clock gap is saved',exact=False)).to_be_visible()
    screen('generate-warnings');assert not errors,errors
    assert any(r['status']==409 and 'unit-rules' in r['path'] for r in requests)
    results.append({'runtime':args.runtime,'width':width,'passed':True,'gapSupported':ready['gapSupported'],'pageErrors':errors,'externalRequests':0,'requests':requests,'scope':'Actual MAIN components and authenticated Worker with local SQLite/fake R2'})
    print('PASS audit UI and saved settings',args.runtime,width)
   except Exception:
    screen('failure');raise
   finally:page.close();proc.stdin.close();proc.wait(timeout=10)
 finally:browser.close()
(out/f'result-{args.runtime}.json').write_text(json.dumps({'passed':True,'checks':results},indent=2))
