"""Actual built App, synthetic API, desktop/narrow format loading/save/reopen/recovery."""
import os,json,mimetypes,time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/outstream-evidence';out.mkdir(parents=True,exist_ok=True)
checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox'])
 try:
  for width in [1440,390]:
   page=browser.new_page(viewport={'width':width,'height':900});writes=[];errors=[];pending=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   state={'revision':'revision1','outstream':{'schemaVersion':1,'units':{}},'prebidVersion':'11.34.0','modules':['pubmaticBidAdapter'],'bidders':[{'bidder':'pubmatic','enabled':True}],'enablePrebid':True,'runtimeEligible':True}
   mode={'hold':True,'fail':False}
   site={'id':'site-1','publisherAccountId':'publisher-1','name':'example.invalid','domain':'example.invalid','gamPath':'/123/example/','status':'draft','currentVersion':'draft','updatedAt':'2026-10-11T00:00:00Z','lastPublishedAt':None,'adUnitsCount':1,'biddersCount':1}
   def route(r):
    path=urlparse(r.request.url).path
    def reply(value,status=200):r.fulfill(status=status,content_type='application/json',body=json.dumps(value))
    if urlparse(r.request.url).netloc!='outstream-ui.test':raise AssertionError('External network attempted')
    if path=='/api/auth/me':reply({'ok':True,'user':{'email':'fixture@example.invalid'}})
    elif path=='/api/organization':reply({'agencies':[],'memberships':[]})
    elif path=='/api/publisher-accounts':reply({'publishers':[{'id':'publisher-1','name':'Synthetic publisher','status':'active','sitesCount':1,'sites':[site]}]})
    elif path.endswith('/ad-units'):reply({'adUnits':[{'id':'unit1','publisherId':'site-1','code':'P1','type':'BTF','mediaType':'banner','sizeMapKey':'display','enabled':True,'sortOrder':1,'notes':'Banner configuration preserved'}]})
    elif path.endswith('/prebid-mode'):reply({'revision':'cache1','bidCacheAvailable':False,'bidCachePositions':[],'prebidMode':{'enabled':True,'bidCache':{'enabled':False,'maxBidAgeSeconds':60}}})
    elif path.endswith('/outstream-settings'):
     if r.request.method=='POST':
      writes.append(r.request.post_data_json)
      if mode['fail']:reply({'error':'Settings changed in another tab. Reload before saving.'},409)
      else:state['outstream']=r.request.post_data_json['outstream'];state['revision']='revision2';reply(state)
     elif mode['hold']:pending.append(r)
     else:reply(state)
    elif path.startswith('/api/'):reply({'error':'Outside scoped fixture'},404)
    else:
     file=root/'dist/client'/('index.html' if path=='/' else path.lstrip('/'))
     r.fulfill(status=200,content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes())
   page.route('**/*',route)
   page.goto('https://outstream-ui.test/?section=publishers&publisher=publisher-1&site=site-1&tab=config')
   page.get_by_role('button',name='Inventory',exact=True).click();page.get_by_role('button',name='Formats',exact=True).click()
   expect(page.get_by_text('Loading format settings…',exact=True)).to_be_visible();assert page.locator('[role=dialog]').evaluate('(e)=>e===document.activeElement')
   deadline=time.monotonic()+5
   while not pending and time.monotonic()<deadline:page.wait_for_timeout(10)
   assert pending,'Expected held loading request'
   mode['hold']=False
   for r in pending:r.fulfill(status=200,content_type='application/json',body=json.dumps(state))
   pending.clear()
   page.get_by_label('Ad format',exact=True).select_option('banner-outstream')
   expect(page.get_by_role('button',name='Save format settings',exact=True)).to_be_disabled()
   page.get_by_label('PubMatic outstream renderer ID',exact=True).fill('fixture_renderer')
   page.get_by_label('PubMatic confirmed this placement is activated for outstream.',exact=True).check()
   page.get_by_label('Player width (px)',exact=True).fill('300');page.get_by_label('Player height (px)',exact=True).fill('250')
   page.screenshot(path=str(out/f'formats-{width}.png'),full_page=True)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Horizontal overflow'
   page.get_by_role('button',name='Save format settings',exact=True).scroll_into_view_if_needed()
   page.screenshot(path=str(out/f'formats-footer-{width}.png'),full_page=True)
   page.get_by_role('button',name='Save format settings',exact=True).click();expect(page.get_by_text('Saved for the next revenue preview release. Existing scripts are unchanged.',exact=True)).to_be_visible()
   assert writes[-1]['outstream']['units']['P1']['partner']['outstreamAU']=='fixture_renderer'
   page.get_by_role('button',name='Close format settings',exact=True).click();expect(page.get_by_role('button',name='Formats',exact=True)).to_be_focused()
   page.get_by_role('button',name='Formats',exact=True).click();expect(page.get_by_label('Ad format',exact=True)).to_have_value('banner-outstream');expect(page.get_by_label('Player width (px)',exact=True)).to_have_value('300')
   mode['fail']=True;page.get_by_label('Ad format',exact=True).select_option('outstream');page.get_by_role('button',name='Save format settings',exact=True).click()
   expect(page.get_by_role('alert')).to_contain_text('Settings changed');expect(page.get_by_label('Ad format',exact=True)).to_have_value('outstream')
   page.screenshot(path=str(out/f'formats-error-{width}.png'),full_page=True)
   mode['fail']=False;page.get_by_role('button',name='Reload format settings',exact=True).click();expect(page.get_by_label('Ad format',exact=True)).to_have_value('banner-outstream')
   page.get_by_label('Ad format',exact=True).select_option('banner');page.get_by_role('button',name='Save format settings',exact=True).click();expect(page.get_by_text('Saved for the next revenue preview release. Existing scripts are unchanged.',exact=True)).to_be_visible()
   assert writes[-1]['outstream']['units']['P1']=={'format':'banner'}
   assert not errors,errors
   checks.append({'width':width,'loadingFocusSaveReopenErrorRecoveryBannerRestore':True,'writesOnlyOutstreamSettings':len(writes)});page.close();print('PASS UI',width)
 finally:browser.close()
(out/'ui-results.json').write_text(json.dumps(checks,indent=2))
