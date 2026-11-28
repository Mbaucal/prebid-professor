"""Actual React UI and authenticated Worker over a local SQLite/R2 fixture."""
import base64,json,subprocess,zipfile,io
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/conditional-maps-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://admin-audit.fixture.invalid';results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
 for width in [1440,390]:
  proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/admin-audit-browser-fixture.mjs','--runtime=3.16.2','--conditional'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
  ready=json.loads(proc.stdout.readline());assert ready['ready']
  page=browser.new_page(viewport={'width':width,'height':1000});errors=[];failed_requests=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  def send(path,method='GET',body=None):
   proc.stdin.write(json.dumps({'path':path,'method':method,'body':None if body is None else json.dumps(body)})+'\n');proc.stdin.flush()
   value=json.loads(proc.stdout.readline());assert 'error' not in value,value;return value
  def data(path):
   response=send(path);assert response['status']==200,response;return json.loads(base64.b64decode(response['body']))
  def route(r):
   request=r.request;url=urlsplit(request.url);assert url.netloc=='admin-audit.fixture.invalid',request.url
   value=send(url.path+('?' +url.query if url.query else ''),request.method,json.loads(request.post_data) if request.post_data else None)
   if value['status']>=400:failed_requests.append({'path':url.path,'status':value['status'],'body':base64.b64decode(value['body']).decode()})
   r.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
  page.route('**/*',route)
  def screen(name):
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal overflow'
   page.screenshot(path=str(out/f'ui-{name}-{width}.png'),full_page=True)
  try:
   page.goto(origin+'/',wait_until='domcontentloaded')
   expect(page.get_by_text('Saved key-value mappings require script 3.17.0.',exact=False)).to_be_visible()
   before=data('/__fixture/snapshot');screen('old-version-message')
   page.get_by_role('button',name='Unit rules',exact=True).click()
   card=page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True))
   card.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog')
   expect(dialog.get_by_label('Key',exact=True)).to_have_value('category')
   expect(dialog.get_by_label('Value',exact=True)).to_have_value('Naslovna')
   dialog.get_by_label('Name',exact=True).fill('Category home')
   dialog.locator('.conditional-section').scroll_into_view_if_needed();screen('rule')
   dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
   saved=data('/__fixture/snapshot');rule=json.loads(next(r['rule_json'] for r in saved['rules'] if r['rule_key']=='P1'))
   assert rule['conditionalMappings'][0]['name']=='Category home',rule
   assert rule['conditionalMappings'][0]['conditions'][0]['key']=='category'
   assert saved['config']['builtinRuntimeSelection']==before['config']['builtinRuntimeSelection'],'Saving a rule must not switch versions'
   page.get_by_role('button',name='Script setup',exact=True).first.click()
   select=page.get_by_label('Script version',exact=True)
   expect(select).to_be_visible()
   option=select.locator('option').filter(has_text='3.17.0');assert option.count()==1
   select.select_option(option.get_attribute('value'))
   page.get_by_role('button',name='Save script setup',exact=True).click()
   expect(page.get_by_role('status').filter(has_text='Script setup saved')).to_be_visible()
   expect(page.get_by_text('Saved key-value mappings require script 3.17.0.',exact=False)).to_have_count(0)
   state=data('/__fixture/snapshot');assert state['config']['builtinRuntimeSelection']['runtime']['runtimeVersion']=='3.17.0'
   assert state['rules']==saved['rules'],'Saving the new version must retain the category rule';screen('recovered')
   page.get_by_role('button',name='Generate and releases',exact=True).first.click()
   generate=page.get_by_role('button',name='Generate and save package',exact=True);expect(generate).to_be_enabled();generate.click()
   download=page.get_by_role('button',name='Download saved ZIP',exact=True);expect(download).to_be_visible(timeout=30000)
   with page.expect_download() as event:download.click()
   archive=zipfile.ZipFile(event.value.path());config=json.loads(archive.read('config.json'))
   assert config['runtime']['runtimeVersion']=='3.17.0'
   assert config['conditionalUnits']['P1']['rules'][0]['conditions'][0]['key']=='category'
   assert config['conditionalUnits']['P1']['rules'][0]['sizeMapKey']=='naslovna_P2'
   assert b'adConditionalConfig' in archive.read('ads.js')
   assert not errors,errors;screen('generated')
   results.append({'width':width,'passed':True,'savedCategoryRule':True,'explicitVersionSelection':True,'downloadedPackageVerified':True})
  except Exception:
   screen('failure')
   print(json.dumps({'failedRequests':failed_requests,'body':page.locator('body').inner_text()},indent=2))
   raise
  finally:
   page.close();proc.stdin.close();proc.wait(timeout=10)
 browser.close()
(out/'ui-results.json').write_text(json.dumps(results,indent=2))
print('2/2 desktop/mobile admin save, version recovery and downloaded-package checks passed.')
