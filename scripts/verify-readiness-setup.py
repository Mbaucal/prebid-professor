"""Explicit supported script versions in TEST native React/Worker with SQLite/fake R2.

Includes the older 3.14 CMP/reporting regression. No hosted or paid traffic.
"""
import base64,json,os,subprocess,re,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/readiness-setup-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://main-revenue.fixture.invalid';endpoint='/api/publishers/main-site/builtin-site-settings'
current='3.16.1';checks=[]
with sync_playwright() as playwright:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=playwright.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   for scenario in ['new','legacy','readiness','preview']:
    process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/main-revenue-browser-fixture.mjs','--script-setup='+scenario],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    ready=json.loads(process.stdout.readline());assert ready['ready'] and ready['setupScenario']==scenario
    errors,requests,pending=[],[],[]
    faults={'holdGet':scenario=='new','failPost':False,'invalidCurrent':False,'futureStable':False}
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
      if url.path==endpoint and request.method=='GET' and faults['futureStable']:
       payload=json.loads(base64.b64decode(value['body']));fixed=json.loads(json.dumps(payload['currentRuntime']));fixed.update(version='3.16.2',channel='stable');fixed['pin'].update(runtimeVersion='3.16.2',runtimeSha256='f'*64);payload['runtimes'].append(fixed)
       value['body']=base64.b64encode(json.dumps(payload).encode()).decode()
     body=json.loads(request.post_data) if request.post_data else None
     if url.path==endpoint and request.method=='POST':
      version=body['runtime']['runtimeVersion']
      expected=False if version=='3.16.2' else next(item['channel']!='stable' for item in data()['runtimes'] if item['pin']['runtimeVersion']==version)
      assert body['allowPreview'] is expected,'Wrong explicit preview opt-in contract'
     requests.append({'path':url.path,'method':request.method,'status':value['status'],'body':body})
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
    selector=panel.get_by_role('combobox',name='Script version',exact=True)
    reload=panel.get_by_role('button',name='Reload script setup',exact=True)
    gam=panel.get_by_role('radio',name='GAM / AdX only',exact=False);prebid=panel.get_by_role('radio',name='GAM + Prebid',exact=False)
    def screen(name):
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal overflow'
     page.screenshot(path=str(out/f'{scenario}-{name}-{width}.png'),full_page=True)
    def saved():
     save.click();expect(panel.get_by_role('status')).to_contain_text('Script setup saved')
    def picker():
     expect(panel.locator('select')).to_have_count(1);expect(selector).to_be_visible()
     labels=selector.locator('option').all_text_contents()
     fresh=[label.split(' · ')[0] for label in labels if 'Saved earlier build' not in label]
     assert fresh==['3.16.1','3.16.0','3.15.0','3.14.0','3.13.0'],labels
     expect(panel).not_to_contain_text('revenue.preview');expect(panel).not_to_contain_text('tessera-revenue-preview')
    def choose(version):
     expect(selector).to_be_visible()
     options=selector.locator('option').evaluate_all('(items)=>items.map(item=>({label:item.textContent,value:item.value}))')
     option=next(item for item in options if item['label'].split(' · ')[0]==version and 'Saved earlier build' not in item['label'])
     selector.select_option(option['value'])
    try:
     page.goto(origin+'/',wait_until='domcontentloaded')
     expect(page.get_by_role('navigation',name='Configuration sections',exact=True)).to_be_visible()
     if scenario=='new':
      expect(panel.get_by_text('Loading script setup…',exact=True)).to_be_visible();screen('loading');assert len(pending)==1
      fulfill(pending.pop(),'Synthetic setup unavailable. Reload script setup and retry.')
      expect(panel.get_by_role('alert')).to_contain_text('Synthetic setup unavailable');assert data()['selected'] is None;screen('load-error')
      reload.click();expect(summary).to_contain_text(current);expect(summary).to_contain_text('Current version for new scripts');expect(upgrade).to_have_count(0);picker()
      history=panel.locator('details.script-history');history.locator('summary').click()
      expect(history.locator('article')).to_have_count(len({re.sub(r'-(?:tessera|revenue)\.preview\.\d+$','',row['version']) for row in data()['history']}));expect(history.locator('article').filter(has=page.locator('strong').filter(has_text=re.compile(r'^3\.16\.0 ·')))).to_have_count(1);expect(history).not_to_contain_text('revenue.preview');expect(history.get_by_role('button')).to_have_count(0);expect(history.locator('select,input')).to_have_count(0)
      screen('public-history')
      history.screenshot(path=str(out/f'new-public-history-details-{width}.png'))
      history.locator('summary').click();gam.check()
      expect(panel.get_by_text('Waits for your CMP decision',exact=False)).to_be_visible();expect(panel.get_by_text('No Prebid auction values are sent',exact=False)).to_be_visible()
      screen('offered-current')
      assert data()['selected'] is None,'Opening or editing setup silently selected a runtime'
      faults['failPost']=True;save.click();expect(panel.get_by_role('alert')).to_contain_text('Synthetic save unavailable');expect(save).to_be_disabled();expect(selector).to_be_disabled()
      assert data()['selected'] is None;screen('save-error');reload.click();expect(prebid).to_be_checked();gam.check();saved()
      state=data();assert state['selected']==state['currentRuntime']['pin'] and state['enablePrebid'] is False
      page.reload();expect(summary).to_contain_text(current);expect(summary).to_contain_text('Current version');expect(upgrade).to_have_count(0);expect(gam).to_be_checked();expect(save).to_be_disabled();picker();screen('saved-current')
      pin=state['selected'];prebid.check();saved();assert data()['selected']==pin and data()['enablePrebid'] is True
      page.reload();expect(prebid).to_be_checked();expect(summary).to_contain_text(current)
      faults['invalidCurrent']=True;page.reload();expect(panel.get_by_role('alert')).to_contain_text('The current script version is unavailable');expect(save).to_be_disabled();expect(selector).to_be_disabled();screen('invalid-current')
      reload.click();expect(panel.get_by_role('alert')).to_have_count(0);expect(summary).to_contain_text(current)
      # A synthetic metadata-only next stable release proves the UI sends allowPreview:false without a version literal.
      saved_pin=data()['selected'];faults['futureStable']=True;page.reload();choose('3.16.2');expect(summary).to_contain_text('3.16.2');faults['failPost']=True
      save.click();expect(panel.get_by_role('alert')).to_contain_text('Synthetic save unavailable');assert requests[-1]['body']['allowPreview'] is False;assert data()['selected']==saved_pin
      screen('future-stable-metadata');faults['futureStable']=False;reload.click();expect(summary).to_contain_text(current)
     elif scenario in ['legacy','preview']:
      old_pin=data()['selected'];old_version='3.10.0-tessera.preview.1' if scenario=='legacy' else '3.16.0-revenue.preview.3';old_label='3.10.0' if scenario=='legacy' else '3.16.0';assert old_pin['runtimeVersion']==old_version
      expect(summary).to_contain_text(old_label);expect(summary).to_contain_text('Saved version');expect(upgrade).to_be_visible();picker()
      gam.check();saved();assert data()['selected']==old_pin and data()['enablePrebid'] is False
      page.reload();expect(summary).to_contain_text(old_label);posts=len([r for r in requests if r['method']=='POST'])
      screen('saved-legacy')
      upgrade.click();expect(summary).to_contain_text(current);expect(summary).to_contain_text('Unsaved version change')
      assert len([r for r in requests if r['method']=='POST'])==posts and data()['selected']==old_pin
      prebid.check();gam.check();expect(summary).to_contain_text(current);screen('explicit-upgrade')
      concurrent=data();data(body={'action':'setup','revision':concurrent['revision'],'runtime':old_pin,'allowPreview':True,'enablePrebid':True})
      save.click();expect(panel.get_by_role('alert')).to_contain_text('Site settings changed');expect(save).to_be_disabled();expect(selector).to_be_disabled();expect(upgrade).to_have_count(0)
      assert data()['selected']==old_pin and data()['enablePrebid'] is True;screen('stale-save')
      reload.click();expect(summary).to_contain_text(old_label);expect(prebid).to_be_checked();upgrade.click();gam.check();saved()
      page.reload();expect(summary).to_contain_text(current);expect(upgrade).to_have_count(0);assert data()['selected']==data()['currentRuntime']['pin'];expect(gam).to_be_checked();screen('upgraded-saved')
     else:
      old_pin=data()['selected'];expect(summary).to_contain_text('3.14.0');expect(panel.get_by_text('Waits for your CMP decision',exact=False)).to_be_visible()
      gam.check();expect(panel.get_by_text('No Prebid auction values are sent',exact=False)).to_be_visible();saved();page.reload()
      expect(summary).to_contain_text('3.14.0');expect(gam).to_be_checked();assert data()['selected']==old_pin
      prebid.check();expect(panel.get_by_text('Also includes current-auction bid counts and timeout.',exact=False)).to_be_visible();screen('cmp-reporting')
      saved();original=data();choose('3.13.0');expect(summary).to_contain_text('Unsaved version change');assert data()['selected']==old_pin;screen('selected-supported-older')
      saved();page.reload();expect(summary).to_contain_text('3.13.0');assert data()['selected']['runtimeVersion']=='3.13.0'
      choose('3.16.0');saved();page.reload();expect(summary).to_contain_text('3.16.0');assert data()['selected']['runtimeVersion']=='3.16.0'
      choose(current);saved();page.reload();expect(summary).to_contain_text(current);updated=data();assert updated['enablePrebid']==original['enablePrebid'] and updated['positions']==original['positions'];assert updated['prebid']==original['prebid'];screen('selected-current-saved')
      # Continue through the real complete MAIN package writer and browser ZIP downloader.
      page.get_by_role('button',name='Generate and releases',exact=True).click()
      page.get_by_label('What changed?',exact=True).fill('Existing setup, selected fixed script')
      page.get_by_role('button',name='Generate and save package',exact=True).click();expect(page.get_by_role('status').filter(has_text='Package saved')).to_be_visible()
      with page.expect_download() as downloaded:
       page.get_by_role('button',name='Download saved ZIP',exact=True).click()
      with zipfile.ZipFile(downloaded.value.path()) as archive:
       manifest=json.loads(archive.read('manifest.json'));config=json.loads(archive.read('config.json'))
       assert manifest['runtime']['runtimeVersion']==current and config['runtime']==manifest['runtime']
       assert archive.read('prebid.js')==(root/'vendor/prebid/tanjug-11.34.0/prebid.js').read_bytes()
      screen('generated-new-version');page.get_by_role('button',name='Configuration',exact=True).click();prebid.check()
      panel.get_by_role('button',name='Open Prebid.js',exact=True).click();expect(page.get_by_role('heading',name='Prebid.js destination',exact=True)).to_be_visible()
     assert not errors,errors
     assert not any(r['path'].startswith('/test-api/') for r in requests)
     checks.append({'width':width,'scenario':scenario,'passed':True,'pageErrors':errors,'requests':requests,'externalRequests':0,'scope':'Actual TEST-branch ConfigPanel and authenticated native Worker; local SQLite/fake R2'})
     print('PASS explicit script version choice and native setup recovery',scenario,width)
    except Exception:
     screen('failure');raise
    finally:
     page.close();process.stdin.close();process.wait(timeout=10)
 finally:browser.close()
(out/'result.json').write_text(json.dumps({'passed':True,'checks':checks},indent=2))
