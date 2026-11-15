"""Bid cache settings on a site that is not Tanjug: real React panels and the compiled Worker
with local D1, all external traffic blocked. Desktop and 390 px, save, 409/422 and recovery."""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=Path(os.environ.get('BID_CACHE_UI_OUT') or root/'.generated/bid-cache-settings-ui');out.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(['node','scripts/script-library-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env={**os.environ,'FIXTURE_SITE':'example'})
assert json.loads(process.stdout.readline())['ready']
SITE='/api/publishers/example'
errors=[];requests=[];checks=[];held=[];hold={'GET':False,'PUT':False};mock={'capable':False}
def check(name,ok):
 assert ok,name
 checks.append(name)
def call(payload):
 process.stdin.write(json.dumps(payload)+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result
 return result
def api(method,path,body=None):
 """The same API from another tab: it changes saved state while the page is open."""
 result=call({'path':SITE+path,'method':method,'body':json.dumps(body) if body is not None else None})
 return result['status'],json.loads(base64.b64decode(result['body']))
def sql(statement,*args):call({'sql':statement,'args':list(args)})
def forward(r):
 url=urlsplit(r.request.url);assert url.netloc=='tessera.fixture.invalid'
 payload={'path':url.path+('?'+url.query if url.query else ''),'method':r.request.method,'body':r.request.post_data}
 result=call(payload);body=base64.b64decode(result['body'])
 if mock['capable'] and url.path==SITE+'/prebid-mode' and result['status']==200:
  # Stand-in until 3.23.0 is registered: the saved selection reports the bid-cache capability.
  data=json.loads(body);data['runtimeSupportsBidCache']=True;data['selectedRuntime']={'id':'tessera-3.23.0','version':'3.23.0'};body=json.dumps(data).encode()
 requests.append({'method':payload['method'],'path':url.path,'status':result['status']})
 r.fulfill(status=result['status'],headers=result['headers'],body=body)
def route(r):
 if urlsplit(r.request.url).path==SITE+'/prebid-mode' and hold.get(r.request.method):
  hold[r.request.method]=False;held.append(r);return
 forward(r)
def release():forward(held.pop())
def no_scroll(page):return page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
def card(page,code):return page.locator('.ad-unit-card').filter(has=page.locator('code',has_text=code))
SELECT_TEXT='Select script 3.23.0 in Script setup to apply bid caching. Your setting is saved.'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True);page=browser.new_page(viewport={'width':1280,'height':1000})
  page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('https://tessera.fixture.invalid/');page.get_by_role('button',name='Demand → Prebid',exact=True).wait_for()
  # Loading state of Demand → Prebid.
  hold['GET']=True;page.get_by_role('button',name='Demand → Prebid',exact=True).click()
  page.get_by_text('Loading Prebid settings…',exact=True).wait_for()
  check('Demand shows its loading state',len(held)==1);release()
  cache=page.get_by_role('checkbox',name='Reuse valid, unused bids',exact=True);cache.wait_for()
  fieldset=page.locator('fieldset.prebid-cache-settings')
  check('The cache checkbox is available on a site that is not Tanjug',cache.is_enabled() and not cache.is_checked())
  check('3.21.2 is selected, so the panel asks for 3.23.0 and keeps the setting',fieldset.get_by_text(SELECT_TEXT,exact=True).is_visible())
  text=fieldset.inner_text()
  check('No Tanjug-only or generator-refusal sentence remains',all(s not in text for s in ['Tanjug','This generator does not apply','named script','Scripts and A/B tests']))
  cache.check();page.get_by_label('Maximum bid age (seconds)',exact=True).fill('45')
  hold['PUT']=True;page.get_by_role('button',name='Save Prebid settings',exact=True).click()
  page.get_by_role('button',name='Saving…',exact=True).wait_for()
  check('Saving disables the cache controls',cache.is_disabled() and page.get_by_label('Maximum bid age (seconds)',exact=True).is_disabled() and page.get_by_role('button',name='Saving…',exact=True).is_disabled())
  release();page.get_by_text('Prebid settings saved. Select script 3.23.0 in Script setup before you generate; earlier script versions do not apply bid caching.',exact=False).wait_for()
  status,saved=api('GET','/prebid-mode')
  check('The site default is saved in D1',status==200 and saved['prebidMode']['bidCache']=={'enabled':True,'maxBidAgeSeconds':45})
  page.screenshot(path=str(out/'demand-saved-desktop.png'),full_page=True)
  # 409: another tab saves first; this form must reload before saving.
  status,_=api('PUT','/prebid-mode',{'enabled':True,'revision':saved['revision'],'bidCache':{'enabled':True,'maxBidAgeSeconds':90}})
  assert status==200
  page.get_by_label('Maximum bid age (seconds)',exact=True).fill('50');page.get_by_role('button',name='Save Prebid settings',exact=True).click()
  page.get_by_text('Prebid settings changed. Reload before saving.',exact=True).wait_for()
  check('A stale form is refused with 409 and keeps the entered value',any(r['status']==409 for r in requests) and page.get_by_label('Maximum bid age (seconds)',exact=True).input_value()=='50')
  page.screenshot(path=str(out/'demand-409-desktop.png'),full_page=True)
  page.get_by_role('button',name='Reload Prebid settings',exact=True).click()
  page.get_by_label('Maximum bid age (seconds)',exact=True).wait_for()
  check('Reload shows the newer saved value',page.get_by_label('Maximum bid age (seconds)',exact=True).input_value()=='90')
  page.get_by_label('Maximum bid age (seconds)',exact=True).fill('50');page.get_by_role('button',name='Save Prebid settings',exact=True).click()
  page.get_by_text('Prebid settings saved.',exact=False).wait_for()
  check('Saving after reload succeeds',api('GET','/prebid-mode')[1]['prebidMode']['bidCache']['maxBidAgeSeconds']==50)
  page.set_viewport_size({'width':390,'height':844})
  check('Demand cache settings fit 390 px',no_scroll(page))
  page.screenshot(path=str(out/'demand-saved-390.png'),full_page=True)
  page.set_viewport_size({'width':1280,'height':1000})
  # Ad units: one Bid cache button for each eligible position of this site.
  page.get_by_role('button',name='Ad positions',exact=True).click();card(page,'Home_Top').get_by_role('button',name='Bid cache: On',exact=True).wait_for()
  check('Every eligible position has a Bid cache button',all(card(page,c).get_by_role('button',name='Bid cache: On',exact=True).count()==1 for c in ['Home_Top','In_Article','Footer']))
  check('Video, disabled, Draft, TakeOver and Outstream positions have none',all(card(page,c).get_by_role('button',name='Bid cache',exact=False).count()==0 for c in ['Video_Slot','Off_Unit','Draft_Unit','Takeover_Unit','Outstream_Unit']))
  page.screenshot(path=str(out/'board-desktop.png'),full_page=True)
  page.set_viewport_size({'width':390,'height':844})
  check('The board with Bid cache buttons fits 390 px',no_scroll(page))
  page.screenshot(path=str(out/'board-390.png'),full_page=True)
  page.set_viewport_size({'width':1280,'height':1000})
  hold['GET']=True;card(page,'In_Article').get_by_role('button',name='Bid cache: On',exact=True).click()
  dialog=page.get_by_role('dialog',name='Bid cache · In_Article',exact=True);dialog.get_by_text('Loading bid cache settings…',exact=True).wait_for()
  check('The position dialog shows its loading state',len(held)==1);release()
  dialog.get_by_label('Bid cache for In_Article',exact=True).wait_for()
  check('The dialog says it applies to the next package generated with 3.23.0',dialog.get_by_text('Applies to the next package generated with script 3.23.0 or later. Select 3.23.0 in Script setup to use it.',exact=True).is_visible())
  dialog.get_by_label('Bid cache for In_Article',exact=True).select_option('off')
  dialog.get_by_role('button',name='Save position setting').click();dialog.get_by_role('status').filter(has_text='Saved. Select script 3.23.0 in Script setup to apply it.').wait_for()
  check('The position override is saved for this site',api('GET','/prebid-mode')[1]['prebidMode']['bidCache'].get('positionOverrides')=={'In_Article':False} and dialog.get_by_text('Effective: Off',exact=True).is_visible())
  page.screenshot(path=str(out/'position-saved-desktop.png'))
  page.get_by_role('button',name='Close bid cache settings').click();dialog.wait_for(state='detached')
  check('The board shows the saved override',card(page,'In_Article').get_by_role('button',name='Bid cache: Off',exact=True).is_visible())
  # 422: the position stops being eligible while its dialog is open.
  card(page,'Home_Top').get_by_role('button',name='Bid cache: On',exact=True).click()
  dialog=page.get_by_role('dialog',name='Bid cache · Home_Top',exact=True);dialog.get_by_label('Bid cache for Home_Top',exact=True).wait_for()
  sql("UPDATE ad_units SET enabled=0 WHERE publisher_id='example' AND code='Home_Top'")
  dialog.get_by_label('Bid cache for Home_Top',exact=True).select_option('off');dialog.get_by_role('button',name='Save position setting').click()
  alert=dialog.get_by_role('alert');alert.wait_for()
  check('A position that is no longer eligible is refused with 422',alert.inner_text()=='Choose bid caching on or off for a supported ad position. Home_Top is not an enabled ATF or BTF banner position on this site. Reload to see the current positions.' and any(r['status']==422 for r in requests))
  page.set_viewport_size({'width':390,'height':844})
  check('The position dialog with its error fits 390 px',dialog.bounding_box()['width']<=390 and no_scroll(page))
  page.screenshot(path=str(out/'position-422-390.png'))
  dialog.get_by_role('button',name='Reload bid cache settings',exact=True).click()
  dialog.get_by_text('Home_Top cannot reuse bids. Only enabled ATF and BTF banner positions can; TakeOver and Outstream positions always use the current auction.',exact=True).wait_for()
  check('Reload explains why the position cannot reuse bids',dialog.get_by_role('alert').count()==0)
  page.keyboard.press('Escape');dialog.wait_for(state='detached')
  card(page,'Home_Top').get_by_role('button',name='Bid cache',exact=False).wait_for(state='detached')
  check('Closing the dialog refreshes the board: Home_Top has no Bid cache button',card(page,'In_Article').get_by_role('button',name='Bid cache: Off',exact=True).is_visible())
  page.set_viewport_size({'width':1280,'height':1000})
  # An override kept for a unit that later became ineligible is shown as not applied and can be removed.
  sql("UPDATE ad_units SET enabled=0 WHERE publisher_id='example' AND code='In_Article'")
  page.get_by_role('button',name='Demand → Prebid',exact=True).click()
  page.get_by_text('Not applied: In_Article: Off. No ad unit with this code can reuse bids now.',exact=True).wait_for()
  page.screenshot(path=str(out/'demand-unused-desktop.png'),full_page=True)
  page.set_viewport_size({'width':390,'height':844})
  check('The unused override fits 390 px',no_scroll(page))
  page.screenshot(path=str(out/'demand-unused-390.png'),full_page=True)
  page.set_viewport_size({'width':1280,'height':1000})
  page.get_by_role('button',name='Remove unused overrides',exact=True).click()
  page.get_by_text('The unused override is removed when you save.',exact=True).wait_for()
  page.get_by_role('button',name='Save Prebid settings',exact=True).click();page.get_by_text('Prebid settings saved.',exact=False).wait_for()
  check('Removing the unused override saves only that change',api('GET','/prebid-mode')[1]['prebidMode']['bidCache']=={'enabled':True,'maxBidAgeSeconds':50} and page.get_by_text('Not applied',exact=False).count()==0)
  # Prebid off keeps the settings; the position dialog shows them as inactive.
  page.get_by_role('radio').nth(1).check()
  check('AdX-only hides the cache controls',cache.count()==0 and page.get_by_text('Bid caching is inactive while Prebid is off. Its saved settings are kept.',exact=True).is_visible())
  page.get_by_role('radio').first.check()
  check('Switching back restores the unsaved form',cache.is_checked())
  # With a runtime that has the bid-cache capability (response stand-in until 3.23.0 is registered).
  mock['capable']=True
  page.get_by_role('button',name='Ad positions',exact=True).click();page.get_by_role('button',name='Demand → Prebid',exact=True).click()
  page.get_by_text('Applies to new packages generated with script 3.23.0 or later.',exact=True).wait_for()
  check('A capable runtime shows the apply line, not the select line',page.get_by_text(SELECT_TEXT,exact=True).count()==0)
  page.screenshot(path=str(out/'demand-capable-desktop.png'),full_page=True)
  page.get_by_role('button',name='Ad positions',exact=True).click();card(page,'Footer').get_by_role('button',name='Bid cache: On',exact=True).click()
  dialog=page.get_by_role('dialog',name='Bid cache · Footer',exact=True)
  dialog.get_by_text('Applies to the next package generated with script 3.23.0 or later.',exact=True).wait_for()
  dialog.get_by_label('Bid cache for Footer',exact=True).select_option('off');dialog.get_by_role('button',name='Save position setting').click()
  dialog.get_by_role('status').filter(has_text='Saved. Generate a new package to apply this setting.').wait_for()
  page.set_viewport_size({'width':390,'height':844})
  check('The capable dialog fits 390 px',dialog.bounding_box()['width']<=390 and no_scroll(page))
  page.screenshot(path=str(out/'position-capable-390.png'))
  check('No unhandled UI error',not errors)
  browser.close()
finally:
 process.stdin.close();process.wait(timeout=10)
(out/'report.json').write_text(json.dumps({'scope':'Compiled Worker, local D1, synthetic example.invalid site; 3.23.0 capability is a response stand-in','checks':checks,'passed':len(checks),'failed':0,'errors':errors,'requests':requests},indent=2))
print(json.dumps({'passed':len(checks),'failed':0}))
