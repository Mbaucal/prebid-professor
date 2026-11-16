"""Actual TEST entry + authenticated TEST routes, SQLite and synthetic demand only."""
import base64,json,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parent.parent
out=root/'.generated/test-unit-rules-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://prebid-professor-test.mbaucal.workers.dev'
base='/api/publishers/test-site';results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
 for width in [1440,390]:
  process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/site-workspace-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
  assert json.loads(process.stdout.readline())['ready']
  page=browser.new_page(viewport={'width':width,'height':1000});errors=[];requests=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  def send(path,method='GET',body=None):
   process.stdin.write(json.dumps({'path':path,'method':method,'body':None if body is None else json.dumps(body)})+'\n');process.stdin.flush()
   value=json.loads(process.stdout.readline());assert 'error' not in value,value;return value
  def data(path,method='GET',body=None):
   value=send(path,method,body);assert value['status'] in [200,201],value
   return json.loads(base64.b64decode(value['body']))
  settings=data('/test-api/site-runtime')
  data('/test-api/site-runtime','POST',{'action':'setup','revision':settings['revision'],'runtime':settings['currentRuntime']['pin'],'allowPreview':False,'enablePrebid':False})
  pin=data('/test-api/site-runtime')['selected']
  refuse_load=[True]
  def route(r):
   req=r.request;url=urlsplit(req.url);assert url.netloc==urlsplit(origin).netloc,req.url
   if url.path==base+'/unit-rules' and req.method=='GET' and refuse_load[0]:
    refuse_load[0]=False;r.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Temporary TEST rules failure.'}));return
   value=send(url.path+('?' +url.query if url.query else ''),req.method,json.loads(req.post_data) if req.post_data else None)
   requests.append({'path':url.path,'method':req.method,'status':value['status']})
   r.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
  page.route('**/*',route)
  def screen(name):
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal overflow'
   page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
  try:
   page.goto(origin+'/site-workspace#rules',wait_until='domcontentloaded')
   expect(page.get_by_role('heading',name='Unit rules',exact=True)).to_be_visible()
   expect(page.get_by_text('Temporary TEST rules failure.',exact=True)).to_be_visible()
   screen('load-failure')
   page.get_by_role('button',name='Reload rules',exact=True).click()
   expect(page.get_by_text('Temporary TEST rules failure.',exact=True)).to_have_count(0)
   page.get_by_role('button',name='＋ New rule',exact=True).click();dialog=page.get_by_role('dialog')
   dialog.get_by_label('Rule target',exact=False).select_option('Billboard')
   dialog.get_by_role('button',name='＋ Country mapping',exact=True).click()
   mapping=dialog.locator('.conditional-mapping-card').last
   mapping.get_by_label('Value',exact=True).fill('XX')
   mapping.get_by_label('Use size map',exact=False).select_option('display')
   dialog.get_by_role('button',name='Save rule',exact=True).click()
   expect(dialog.get_by_text('use a country code such as RS, DE or AT.',exact=False)).to_be_visible()
   expect(mapping.get_by_label('Value',exact=True)).to_have_value('XX');screen('invalid-country')
   mapping.get_by_label('Value',exact=True).fill('de')
   dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
   card=page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='Billboard',exact=True))
   card.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog')
   expect(dialog.get_by_label('Value',exact=True)).to_have_value('DE')
   dialog.get_by_label('Value',exact=True).fill('rs')
   dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
   page.get_by_role('button',name='＋ New rule',exact=True).click();dialog=page.get_by_role('dialog')
   dialog.get_by_label('Rule target',exact=False).select_option('__INTERSTITIAL__')
   dialog.get_by_role('button',name='Only Serbia preset',exact=True).click()
   expect(dialog.get_by_label('Use size map',exact=False)).to_have_count(0)
   expect(dialog.get_by_text('It does not activate a standalone Interstitial.',exact=False)).to_be_visible()
   dialog.locator('.conditional-section').scroll_into_view_if_needed();screen('fallback-preset')
   dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
   expect(page.get_by_role('heading',name='Interstitial fallback',exact=True)).to_be_visible();screen('saved')
   before=len(requests);page.reload()
   expect(page.get_by_role('heading',name='Interstitial fallback',exact=True)).to_be_visible()
   assert all(row['method']=='GET' for row in requests[before:])
   saved=data(base+'/unit-rules')['unitRules']
   banner=next(rule for rule in saved if rule['ruleKey']=='Billboard')
   fallback=next(rule for rule in saved if rule['ruleKey']=='__INTERSTITIAL__')
   assert banner['rule']['conditionalMappings'][0]['conditions'][0]['value']=='RS'
   assert [condition['operator'] for condition in fallback['rule']['conditionalMappings'][0]['conditions']]==['notEquals','notExists']
   assert data('/test-api/site-runtime')['selected']==pin
   assert any(row['method']=='PATCH' and row['status']==200 for row in requests)
   assert not errors,errors
   results.append({'width':width,'passed':True,'loadRecovery':True,'invalidCountryRecovery':True,'createEditAndBookmarkReload':True,'fallbackPresetSaved':True,'versionUnchanged':True,'requests':requests})
  except Exception:
   page.screenshot(path=str(out/f'failure-{width}.png'),full_page=True)
   print(page.locator('body').inner_text());raise
  finally:
   page.close();process.stdin.close();process.wait(timeout=10)
 browser.close()
(out/'results.json').write_text(json.dumps(results,indent=2))
print('2/2 desktop/mobile TEST Unit rules create/edit, load/error recovery and bookmark reload passed.')
