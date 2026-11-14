"""Actual compiled TEST router + reused React UI, ephemeral D1/R2, no external traffic."""
import base64, hashlib, json, os, subprocess
from pathlib import Path
from urllib.parse import urlsplit, urlencode
from http.cookies import SimpleCookie
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent
out=root/'.generated/named-script-test-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://prebid-professor-test.mbaucal.workers.dev'
checks=[];errors=[];requests=[]
def check(name,value):
 assert value,name
 checks.append(name)
def run(browser,width,collision=False):
 env={**os.environ,'NAMED_TEST_SCENARIO':'collision' if collision else ''}
 process=subprocess.Popen(['node','scripts/named-script-test-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=env)
 assert json.loads(process.stdout.readline())['ready']
 context=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
 page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
 def dispatch(payload):
  process.stdin.write(json.dumps(payload)+'\n');process.stdin.flush()
  response=json.loads(process.stdout.readline());assert 'error' not in response,response
  return response
 def route(r):
  url=urlsplit(r.request.url)
  assert url.netloc=='prebid-professor-test.mbaucal.workers.dev','Unexpected external traffic'
  response=dispatch({'path':url.path+('?' +url.query if url.query else ''),'method':r.request.method,'body':r.request.post_data,'headers':r.request.all_headers()})
  requests.append({'path':url.path,'method':r.request.method,'status':response['status']})
  assert not 300<=response['status']<400,'Browser redirects must not bypass local interception'
  r.fulfill(status=response['status'],headers=response['headers'],body=base64.b64decode(response['body']))
 page.route('**/*',route)
 try:
  # Obtain the real signed session through the compiled login handler. Playwright
  # does not reroute every redirect hop; keeping login on this pipe prevents an
  # intercepted 303 from escaping to the hosted TEST URL. Existing auth UI tests
  # cover the form; this suite exercises the authenticated named-script surface.
  login=dispatch({'path':'/api/auth/login','method':'POST','headers':{'origin':origin,'content-type':'application/x-www-form-urlencoded'},'body':urlencode({'email':'tester@example.invalid','password':'Local-named-fixture-only-927!'})})
  assert login['status']==303,login
  cookies=SimpleCookie();cookies.load(login['headers']['set-cookie'])
  context.add_cookies([{'name':key,'value':item.value,'url':origin,'httpOnly':True,'secure':True,'sameSite':'Strict'} for key,item in cookies.items()])
  page.goto(origin+'/')
  page.get_by_role('link',name='Named script test',exact=True).click()
  page.get_by_role('heading',name='Tessera · TEST named scripts').wait_for()
  if collision:
   page.get_by_role('alert').filter(has_text='already used by another TEST draft').wait_for()
   check('Collision is explicit and offers no overwrite',page.get_by_role('button',name='Prepare test copy',exact=True).count()==0)
   page.get_by_role('button',name='Reload TEST copy').click()
   page.get_by_role('alert').filter(has_text='already used by another TEST draft').wait_for()
   check('Collision retry remains read-only',not any(r['path']=='/test-api/named-scripts/prepare' for r in requests))
   page.screenshot(path=str(out/'collision-390.png'),full_page=True);return
  prepare=page.get_by_role('button',name='Prepare test copy',exact=True);prepare.wait_for()
  check(str(width)+': opening named page does not prepare data',not any(r['path']=='/test-api/named-scripts/prepare' and r['method']=='POST' for r in requests))
  prepare.click();page.get_by_role('button',name='Save script version',exact=True).wait_for()
  page.get_by_role('button',name='Ad positions',exact=True).click()
  check(str(width)+': TEST paths match visible navigation','Config →' not in page.locator('body').inner_text() and 'Releases →' not in page.locator('body').inner_text())
  check(str(width)+': fixed positions have no unrelated CRUD',page.get_by_role('button',name='New ad unit',exact=True).count()==0)
  page.get_by_role('button',name='Sticky · Bid cache: Off',exact=True).click()
  dialog=page.get_by_role('dialog',name='Bid cache · Sticky',exact=True)
  dialog.get_by_label('Bid cache for Sticky').select_option('on');dialog.get_by_role('button',name='Save position setting').click();dialog.get_by_role('status').wait_for()
  check(str(width)+': explicit position On overrides site Off',dialog.get_by_text('Effective: On',exact=True).is_visible())
  page.screenshot(path=str(out/f'position-{width}.png'),full_page=True)
  page.keyboard.press('Escape');dialog.wait_for(state='detached')
  check(str(width)+': Escape returns focus to position',page.evaluate("document.activeElement.textContent==='Sticky · Bid cache: On'"))
  page.get_by_role('button',name='Prebid settings',exact=True).click()
  page.get_by_role('checkbox',name='Reuse valid, unused bids',exact=True).check()
  page.get_by_role('button',name='Save Prebid settings',exact=True).click();page.get_by_text('Prebid settings saved.',exact=False).wait_for()
  page.get_by_role('button',name='Scripts and A/B tests',exact=True).click()
  page.get_by_label('Script name',exact=True).fill('Position test copy')
  page.get_by_role('button',name='Save script version',exact=True).click();page.get_by_role('status').filter(has_text='Script saved').wait_for()
  card=page.get_by_role('article',name='Script: Position test copy',exact=True)
  check(str(width)+': library guidance matches TEST tabs','Config →' not in page.locator('body').inner_text() and 'Demand →' not in page.locator('body').inner_text())
  check(str(width)+': named snapshot explains position choice','Sticky: cache On' in card.inner_text())
  with page.expect_download() as downloaded:card.get_by_role('button',name='Download standalone ZIP').click()
  target=out/f'package-{width}.zip';downloaded.value.save_as(str(target))
  check(str(width)+': download copy does not direct live activation','test ZIP downloaded' in page.get_by_role('status').inner_text() and 'existing Tanjug Pages project' not in page.locator('body').inner_text())
  page.get_by_label('Test name',exact=True).fill('TEST A/A')
  script_id=page.get_by_label('Script A',exact=True).locator('option').nth(1).get_attribute('value')
  page.get_by_label('Script A',exact=True).select_option(script_id);page.get_by_label('Script B',exact=True).select_option(script_id)
  page.get_by_role('button',name='Save A/B test').click();page.get_by_role('status').filter(has_text='A/B test saved').wait_for()
  page.reload();card.wait_for();page.get_by_role('article',name='Test: TEST A/A',exact=True).wait_for()
  with page.expect_download() as downloaded:card.get_by_role('button',name='Download standalone ZIP').click()
  reopened=out/f'reopened-{width}.zip';downloaded.value.save_as(str(reopened))
  check(str(width)+': reopening preserves exact ZIP bytes',hashlib.sha256(target.read_bytes()).digest()==hashlib.sha256(reopened.read_bytes()).digest())
  check(str(width)+': layout fits viewport',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
  page.screenshot(path=str(out/f'library-{width}.png'),full_page=True)
 finally:
  context.close();process.stdin.close();process.wait(timeout=10)
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 try:
  for width in [1440,390]:
   requests.clear();run(browser,width)
  requests.clear();run(browser,390,True)
  check('No unhandled browser error',not errors)
 finally:browser.close()
(out/'ui.json').write_text(json.dumps({'checks':checks,'passed':len(checks),'failed':0,'errors':errors},indent=2))
print(json.dumps({'passed':len(checks),'failed':0}))
