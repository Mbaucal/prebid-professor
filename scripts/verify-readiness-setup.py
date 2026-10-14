"""One current script in native MAIN React/Worker with SQLite/fake R2.

Includes the older 3.14 CMP/reporting regression. No hosted or paid traffic.
"""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/readiness-setup-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://main-revenue.fixture.invalid';endpoint='/api/publishers/main-site/builtin-site-settings'
current='3.16.0-revenue.preview.3';checks=[]
with sync_playwright() as playwright:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=playwright.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   for scenario in ['new','legacy','readiness']:
    process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/main-revenue-browser-fixture.mjs','--script-setup='+scenario],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    ready=json.loads(process.stdout.readline());assert ready['ready'] and ready['setupScenario']==scenario
    errors,requests,pending=[],[],[]
    faults={'holdGet':scenario=='new','failPost':False,'invalidCurrent':False}
    page=browser.new_page(viewport={'width':width,'height':900})
    page.on('pageerror',lambda error:errors.append(str(error)))
    def send(path,body=None):
     process.stdin.write(json.dumps({'path':path,'method':'POST' if body is not None else 'GET','body':json.dumps(body) if body is not None else None})+'\n');process.stdin.flush()
     value=json.loads(process.stdout.readline());assert 'error' not in value,value;return value
    def data(path=endpoint,body=None):
     value=send(path,body);result=json.loads(base64.b64decode(value['body']));assert value['status']==200,result;return result
    def fulfill(route,failure=None):
     request=route.request;url=urlsplit(request.url)
     if failure:value={'status':503,'headers':{'content-type':'application/json'},'body':base64.b64encode(json.dumps({'error':failure}).encode()).decode()}
     else:
      process.stdin.write(json.dumps({'path':url.path,'method':request.method,'body':request.post_data})+'\n');process.stdin.flush()
      value=json.loads(process.stdout.readline());assert 'error' not in value,value
      if url.path==endpoint and request.method=='GET' and faults['invalidCurrent']:
       faults['invalidCurrent']=False;payload=json.loads(base64.b64decode(value['body']));payload.pop('currentRuntime')
       value['body']=base64.b64encode(json.dumps(payload).encode()).decode()
     requests.append({'path':url.path,'method':request.method,'status':value['status'],'body':json.loads(request.post_data) if request.post_data else None})
     route.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
    def route(request):
     url=urlsplit(request.request.url);assert url.netloc=='main-revenue.fixture.invalid','External request blocked'
     if url.path==endpoint and request.request.method=='GET' and faults['holdGet']:
      faults['holdGet']=False;pending.append(request)
     elif url.path==endpoint and request.request.method=='POST' and faults['failPost']:
      faults['failPost']=False;fulfill(request,'Synthetic save unavailable. Reload script setup and retry.')
     else:fulfill(request)
    page.route('**/*',route)
    panel=page.get_by_role('region',name='Script setup',exact=True);summary=panel.locator('.script-version-summary')
    save=panel.get_by_role('button',name='Save script setup',exact=True);upgrade=panel.get_by_role('button',name='Use current version',exact=True)
    reload=panel.get_by_role('button',name='Reload script setup',exact=True)
    gam=panel.get_by_role('radio',name='GAM / AdX only',exact=False);prebid=panel.get_by_role('radio',name='GAM + Prebid',exact=False)
    def screen(name):
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal overflow'
     page.screenshot(path=str(out/f'{scenario}-{name}-{width}.png'),full_page=True)
    def saved():
     save.click();expect(panel.get_by_role('status')).to_contain_text('Script setup saved')
    def no_picker():
     expect(panel.locator('select')).to_have_count(0);expect(panel.get_by_role('button',name='Change version',exact=True)).to_have_count(0)
    try:
     page.goto(origin+'/',wait_until='domcontentloaded')
     expect(page.get_by_role('navigation',name='Configuration groups',exact=True)).to_be_visible()
     if scenario=='new':
      expect(panel.get_by_text('Loading script setup…',exact=True)).to_be_visible();screen('loading');assert len(pending)==1
      fulfill(pending.pop(),'Synthetic setup unavailable. Reload script setup and retry.')
      expect(panel.get_by_role('alert')).to_contain_text('Synthetic setup unavailable');assert data()['selected'] is None;screen('load-error')
      reload.click();expect(summary).to_contain_text(current);expect(summary).to_contain_text('Current version for new scripts');expect(upgrade).to_have_count(0);no_picker()
      history=panel.locator('details.script-history');history.locator('summary').click()
      expect(history.locator('article')).to_have_count(len(data()['history']));expect(history.get_by_role('button')).to_have_count(0);expect(history.locator('select,input')).to_have_count(0)
      history.locator('summary').click();gam.check()
      screen('offered-current')
      assert data()['selected'] is None,'Opening or editing setup silently selected a runtime'
      faults['failPost']=True;save.click();expect(panel.get_by_role('alert')).to_contain_text('Synthetic save unavailable');expect(save).to_be_disabled()
      assert data()['selected'] is None;screen('save-error');reload.click();expect(prebid).to_be_checked();gam.check();saved()
      state=data();assert state['selected']==state['currentRuntime']['pin'] and state['enablePrebid'] is False
      page.reload();expect(summary).to_contain_text(current);expect(summary).to_contain_text('Current version');expect(upgrade).to_have_count(0);expect(gam).to_be_checked();expect(save).to_be_disabled();no_picker();screen('saved-current')
      pin=state['selected'];prebid.check();saved();assert data()['selected']==pin and data()['enablePrebid'] is True
      page.reload();expect(prebid).to_be_checked();expect(summary).to_contain_text(current)
      faults['invalidCurrent']=True;page.reload();expect(panel.get_by_role('alert')).to_contain_text('The current script version is unavailable');expect(save).to_be_disabled();screen('invalid-current')
      reload.click();expect(panel.get_by_role('alert')).to_have_count(0);expect(summary).to_contain_text(current)
     elif scenario=='legacy':
      old_pin=data()['selected'];assert old_pin['runtimeVersion']=='3.10.0-tessera.preview.1'
      expect(summary).to_contain_text('3.10.0');expect(summary).to_contain_text('Saved version');expect(upgrade).to_be_visible();no_picker()
      gam.check();saved();assert data()['selected']==old_pin and data()['enablePrebid'] is False
      page.reload();expect(summary).to_contain_text('3.10.0');posts=len([r for r in requests if r['method']=='POST'])
      screen('saved-legacy')
      upgrade.click();expect(summary).to_contain_text(current);expect(summary).to_contain_text('Unsaved version change')
      assert len([r for r in requests if r['method']=='POST'])==posts and data()['selected']==old_pin
      prebid.check();gam.check();expect(summary).to_contain_text(current);screen('explicit-upgrade')
      concurrent=data();data(body={'action':'setup','revision':concurrent['revision'],'runtime':old_pin,'allowPreview':True,'enablePrebid':True})
      save.click();expect(panel.get_by_role('alert')).to_contain_text('Site settings changed');expect(save).to_be_disabled();expect(upgrade).to_have_count(0)
      assert data()['selected']==old_pin and data()['enablePrebid'] is True;screen('stale-save')
      reload.click();expect(summary).to_contain_text('3.10.0');expect(prebid).to_be_checked();upgrade.click();gam.check();saved()
      page.reload();expect(summary).to_contain_text(current);expect(upgrade).to_have_count(0);assert data()['selected']==data()['currentRuntime']['pin'];expect(gam).to_be_checked();screen('upgraded-saved')
     else:
      old_pin=data()['selected'];expect(summary).to_contain_text('3.14.0');expect(panel.get_by_text('Waits for your CMP decision',exact=False)).to_be_visible()
      gam.check();expect(panel.get_by_text('No Prebid auction values are sent',exact=False)).to_be_visible();saved();page.reload()
      expect(summary).to_contain_text('3.14.0');expect(gam).to_be_checked();assert data()['selected']==old_pin
      prebid.check();expect(panel.get_by_text('Also includes current-auction bid counts and timeout.',exact=False)).to_be_visible();screen('cmp-reporting')
      panel.get_by_role('button',name='Open Prebid.js',exact=True).click();expect(page.get_by_role('heading',name='Prebid.js destination',exact=True)).to_be_visible()
     assert not errors,errors
     assert not any(r['path'].startswith('/test-api/') for r in requests)
     checks.append({'width':width,'scenario':scenario,'passed':True,'pageErrors':errors,'requests':requests,'externalRequests':0,'scope':'Actual MAIN ConfigPanel and authenticated Worker; local SQLite/fake R2'})
     print('PASS single current script and native setup recovery',scenario,width)
    except Exception:
     screen('failure');raise
    finally:
     page.close();process.stdin.close();process.wait(timeout=10)
 finally:browser.close()
(out/'result.json').write_text(json.dumps({'passed':True,'checks':checks},indent=2))
