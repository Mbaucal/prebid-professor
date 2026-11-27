"""Original A/B save, retry and test creation through the real App and MAIN router; no live ads."""
import base64,json,subprocess,time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.generated/original-sources-ui';OUT.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/original-sources-browser-fixture.mjs'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
fixture=json.loads(process.stdout.readline());assert fixture['ready'];origin=fixture['origin']
checks=[]
def send(path,method='GET',body=None):
 process.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result;return result
def inspect():return json.loads(base64.b64decode(send('/__qa/inspect')['body']))
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  for width in [1440,390]:
   context=browser.new_context(viewport={'width':width,'height':1000},accept_downloads=True);page=context.new_page();held=[];mode={'hold':True};unexpected=[]
   def route(r):
    u=urlsplit(r.request.url)
    if u.netloc!=urlsplit(origin).netloc:unexpected.append(r.request.url);r.abort();return
    path=u.path+('?' + u.query if u.query else '')
    if path.endswith('/original-sources') and mode['hold']:held.append(r);mode['hold']=False;return
    result=send(path,r.request.method,r.request.post_data)
    r.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
   page.route('**/*',route)
   def shot(name,target):
    target.scroll_into_view_if_needed();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');page.screenshot(path=str(OUT/f'{name}-{width}.png'))
   page.goto(origin+'/?section=publishers&publisher=politika&site=politika&tab=measurement')
   expect(page.get_by_role('heading',name='New A/B test',exact=True)).to_be_visible()
   sources=page.locator('#ab-source-versions')
   if sources.get_attribute('open') is None:sources.locator('summary').first.click()
   panel=page.get_by_role('region',name='Original Politika scripts');save=panel.get_by_role('button',name='Save original A and B',exact=True)
   expect(save).to_be_visible();shot('originals',panel)
   save.click();expect(panel.get_by_role('button',name='Saving original scripts…')).to_be_disabled();shot('saving',panel)
   deadline=time.monotonic()+5
   while not held and time.monotonic()<deadline:page.wait_for_timeout(10)
   assert len(held)==1;held.pop().fulfill(status=503,content_type='application/json',body=json.dumps({'error':'The original scripts could not be saved completely. Retry to finish the same save.'}))
   expect(panel.get_by_role('alert')).to_contain_text('Retry to finish');expect(save).to_be_enabled();shot('error',panel)
   save.click();expect(panel.get_by_role('status')).to_contain_text('Both original scripts are saved and selected',timeout=20000)
   a=page.get_by_label('Version A',exact=True);b=page.get_by_label('Version B',exact=True)
   expect(a).to_have_value('original-source-4cd44c2fb51e614be765b55dc2735b4eacd91aa18edf55d00ea1c516c279eb3b')
   expect(b).to_have_value('original-source-d45ed2bc5009fd04b8fccd43f76089e26f8bb081b9704f8b867092a8fcf42b26')
   expect(page.locator('.ab-tests-selected-source').first).to_contain_text('Original saved file')
   form=page.locator('.ab-tests-form');page.get_by_label('Test name',exact=True).fill('Original scripts '+str(width));page.get_by_role('button',name='Check compatibility',exact=True).click()
   expect(form.get_by_text('Compatible. These versions can be compared.',exact=True)).to_be_visible()
   expect(form.get_by_text('These are exact original scripts.',exact=False)).to_be_visible();shot('selected-pair',form)
   with page.expect_response(lambda r:r.request.method=='POST' and urlsplit(r.url).path=='/api/publishers/politika/ab-tests') as event:page.get_by_role('button',name='Save A/B test',exact=True).click()
   assert event.value.status==201
   article=page.get_by_role('article',name='A/B test: Original scripts '+str(width),exact=True);expect(article).to_be_visible();shot('saved-test',article)
   state=inspect();assert state['sqlUnchanged'];assert len(state['sourceObjects'])==4;assert state['sourceReads']==2;assert unexpected==[]
   checks.append({'width':width,'savedOriginals':2,'newTestCreated':True,'sourceBytesVerifiedByBackend':True,'sqlUnchanged':True,'externalBrowserRequests':0,'overflow':False})
   context.close()
  browser.close()
 (OUT/'result.json').write_text(json.dumps({'ok':True,'checks':checks},indent=2));print(json.dumps({'ok':True,'checks':checks}))
finally:
 process.stdin.close();process.wait(timeout=10)
