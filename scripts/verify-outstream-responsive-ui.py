"""Built shared Formats UI with synthetic API: responsive sizing and explicit migration.
All browser requests are intercepted; no partner, publisher or hosted traffic.
"""
import copy,json,mimetypes,os,time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/outstream-responsive-ui-evidence';out.mkdir(parents=True,exist_ok=True)
checks=[]
base_maps=[{'name':'display','rows':[
 {'key':'display@0x0','viewport':[0,0],'disabled':False,'sizes':[[300,250]]},
 {'key':'display@1024x0','viewport':[1024,0],'disabled':False,'sizes':[[640,360],[970,250]]},
 {'key':'display@1600x0','viewport':[1600,0],'disabled':True,'sizes':[]}]}]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox'])
 try:
  for width in [1440,390]:
   page=browser.new_page(viewport={'width':width,'height':900});writes=[];errors=[];pending=[];reads=[]
   page.on('pageerror',lambda error:errors.append(str(error)))
   state={'revision':'revision1','outstream':{'schemaVersion':1,'units':{}},'prebidVersion':'11.34.0','modules':['pubmaticBidAdapter'],
    'bidders':[{'bidder':'pubmatic','enabled':True}],'enablePrebid':True,'runtimeEligible':True,'responsiveSizing':True,
    'sizeMaps':{'P1':{'maps':copy.deepcopy(base_maps)}}}
   mode={'hold':True,'fail':False}
   site={'id':'site-1','publisherAccountId':'publisher-1','name':'example.invalid','domain':'example.invalid','gamPath':'/123/example/',
    'status':'draft','currentVersion':'draft','updatedAt':'2026-10-14T00:00:00Z','lastPublishedAt':None,'adUnitsCount':1,'biddersCount':1}
   units=[{'id':'unit1','publisherId':'site-1','code':'P1','type':'BTF','mediaType':'banner','sizeMapKey':'display','enabled':True,'sortOrder':1,'notes':'Synthetic position'}]
   def route(r):
    path=urlparse(r.request.url).path
    assert urlparse(r.request.url).netloc=='outstream-ui.test','External request blocked'
    def reply(value,status=200):r.fulfill(status=status,content_type='application/json',body=json.dumps(value))
    if r.request.method=='GET':reads.append(path)
    if path=='/api/auth/me':reply({'ok':True,'user':{'email':'fixture@example.invalid'}})
    elif path=='/api/organization':reply({'agencies':[],'memberships':[]})
    elif path=='/api/publisher-accounts':reply({'publishers':[{'id':'publisher-1','name':'Synthetic publisher','status':'active','sitesCount':1,'sites':[site]}]})
    elif path.endswith('/ad-units'):reply({'adUnits':units})
    elif path.endswith('/size-maps'):reply({'sizeMaps':[]})
    elif path.endswith('/prebid-mode'):reply({'revision':'cache1','bidCacheAvailable':False,'bidCachePositions':[],'prebidMode':{'enabled':True,'bidCache':{'enabled':False,'maxBidAgeSeconds':60}}})
    elif path.endswith('/outstream-settings'):
     if r.request.method=='POST':
      writes.append(r.request.post_data_json)
      if mode['fail']:reply({'error':'Settings changed in another tab. Reload before saving.'},409)
      else:state['outstream']=r.request.post_data_json['outstream'];state['revision']='revision'+str(len(writes)+1);reply(state)
     elif mode['hold']:pending.append(r)
     else:reply(state)
    elif path.startswith('/api/'):reply({'error':'Outside scoped fixture'},404)
    else:
     file=root/'dist/client'/('index.html' if path=='/' else path.lstrip('/'))
     r.fulfill(status=200,content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes())
   page.route('**/*',route)
   try:
    page.goto('https://outstream-ui.test/?section=publishers&publisher=publisher-1&site=site-1&tab=config')
    nav=page.get_by_role('navigation',name='Configuration sections',exact=True)
    nav.get_by_role('button',name='Ad units',exact=True).click()
    def open_formats():page.get_by_role('button',name='Formats',exact=True).click();expect(page.get_by_label('Ad format',exact=True)).to_be_visible()
    def close_formats():page.get_by_role('button',name='Close format settings',exact=True).click()
    def save_success():
     page.get_by_role('button',name='Save format settings',exact=True).click()
     expect(page.get_by_text('Saved for the next revenue preview release. Existing scripts are unchanged.',exact=True)).to_be_visible()
    def screen(name):
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Horizontal page overflow'
     assert page.get_by_role('dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth'),'Horizontal modal overflow'
     page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
    page.get_by_role('button',name='Formats',exact=True).click()
    expect(page.get_by_text('Loading format settings…',exact=True)).to_be_visible()
    assert page.get_by_role('dialog').evaluate('(e)=>e===document.activeElement')
    deadline=time.monotonic()+5
    while not pending and time.monotonic()<deadline:page.wait_for_timeout(10)
    assert pending;mode['hold']=False
    for r in pending:r.fulfill(status=200,content_type='application/json',body=json.dumps(state))
    pending.clear()
    page.get_by_label('Ad format',exact=True).select_option('banner-outstream')
    expect(page.get_by_label('Player width (px)',exact=True)).to_have_count(0)
    expect(page.get_by_label('Player height (px)',exact=True)).to_have_count(0)
    expect(page.get_by_text('300 × 250 px · Automatic',exact=False)).to_be_visible()
    expect(page.get_by_text('Ads disabled at this breakpoint.',exact=False)).to_be_visible()
    selector=page.get_by_label('Video size · display · from 1024px wide',exact=True)
    expect(selector).to_have_value('')
    page.get_by_label('PubMatic outstream renderer ID',exact=True).fill('fixture_renderer')
    page.get_by_label('PubMatic confirmed this placement is activated for outstream.',exact=True).check()
    expect(page.get_by_role('button',name='Save format settings',exact=True)).to_be_disabled()
    selector.select_option('640x360')
    expect(page.get_by_role('button',name='Save format settings',exact=True)).to_be_enabled()
    selector.scroll_into_view_if_needed();screen('responsive-choices')
    save_success();settings=writes[-1]['outstream']['units']['P1']
    assert settings['playerSizing']=='size-map' and settings['playerSizes']=={'display@1024x0':[640,360]} and 'playerSize' not in settings
    close_formats();open_formats();expect(selector).to_have_value('640x360')
    mode['fail']=True;selector.select_option('970x250');page.get_by_label('PubMatic outstream renderer ID',exact=True).fill('preserve_on_error')
    page.get_by_role('button',name='Save format settings',exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('Reload');expect(page.get_by_role('alert')).to_be_focused();expect(page.get_by_role('alert')).to_be_in_viewport()
    expect(selector).to_have_value('970x250');expect(page.get_by_label('PubMatic outstream renderer ID',exact=True)).to_have_value('preserve_on_error')
    screen('responsive-error')
    mode['fail']=False;page.get_by_role('button',name='Reload format settings',exact=True).click();expect(selector).to_have_value('640x360')
    expect(page.get_by_label('PubMatic outstream renderer ID',exact=True)).to_have_value('fixture_renderer')
    # A map edit can invalidate a saved ambiguous choice; never silently pick a different size.
    close_formats();state['sizeMaps']['P1']['maps'][0]['rows'][1]['sizes']=[[970,250],[970,300]];open_formats()
    expect(selector).to_have_value('');expect(page.get_by_role('button',name='Save format settings',exact=True)).to_be_disabled()
    selector.select_option('970x300');save_success()
    # Single candidates auto-resolve and are not copied into saved overrides.
    close_formats();state['sizeMaps']['P1']['maps'][0]['rows'][1]['sizes']=[[640,360]];open_formats()
    expect(selector).to_have_count(0);save_success();assert writes[-1]['outstream']['units']['P1']['playerSizes']=={}
    # No eligible video size and fully disabled maps block saving with an actionable destination.
    close_formats();state['sizeMaps']['P1']['maps'][0]['rows'][1]['sizes']=[];open_formats()
    expect(page.get_by_role('alert')).to_contain_text('144 and 1920px');expect(page.get_by_role('button',name='Save format settings',exact=True)).to_be_disabled()
    page.get_by_role('alert').scroll_into_view_if_needed();screen('responsive-no-size')
    page.get_by_role('button',name='Open size maps',exact=True).click()
    expect(page.get_by_role('dialog')).to_have_count(0);expect(page.get_by_role('heading',name='Size maps',exact=True)).to_be_visible()
    assert '/api/publishers/site-1/size-maps' in reads and not any('/publishers/publisher-1/size-maps' in path for path in reads),'Size maps navigation lost site context'
    nav.get_by_role('button',name='Ad units',exact=True).click()
    state['sizeMaps']['P1']['maps'][0]['rows']=[{'key':'display@0x0','viewport':[0,0],'disabled':True,'sizes':[]}]
    open_formats();expect(page.get_by_role('alert')).to_contain_text('Enable at least one breakpoint');expect(page.get_by_role('button',name='Save format settings',exact=True)).to_be_disabled();close_formats()
    # Existing fixed settings remain fixed until the explicit migration action.
    state['sizeMaps']['P1']['maps']=copy.deepcopy(base_maps)
    state['sizeMaps']['P1']['maps'][0]['rows'][1]['sizes']=[[300,250],[640,360]]
    fixed={**copy.deepcopy(settings),'playerSize':[300,250]};fixed.pop('playerSizing');fixed.pop('playerSizes')
    state['outstream']['units']['P1']=fixed;before=len(writes);open_formats()
    expect(page.get_by_label('Player width (px)',exact=True)).to_have_value('300');assert len(writes)==before
    expect(page.get_by_role('button',name='Use size map',exact=True)).to_be_enabled();screen('responsive-explicit-migration')
    save_success();assert writes[-1]['outstream']['units']['P1']==fixed,'Opening/saving migrated fixed settings automatically'
    page.get_by_role('button',name='Use size map',exact=True).click();expect(selector).to_have_value('300x250');assert len(writes)==before+1
    save_success();assert writes[-1]['outstream']['units']['P1']['playerSizes']=={'display@1024x0':[300,250]}
    close_formats();state['responsiveSizing']=False;state['outstream']['units']['P1']=copy.deepcopy(fixed);open_formats()
    expect(page.get_by_label('Player width (px)',exact=True)).to_have_value('300');expect(page.get_by_role('button',name='Use size map',exact=True)).to_have_count(0)
    expect(page.get_by_text('To use different video sizes per breakpoint',exact=False)).to_contain_text('3.16.0-revenue.preview.3')
    save_success();assert writes[-1]['outstream']['units']['P1']==fixed
    assert not errors,errors
    checks.append({'width':width,'automaticSingleSize':True,'explicitAmbiguousChoice':True,'disabledRows':True,
     'sizeMapChangesRevalidated':True,'sameSiteMapNavigation':True,'fixedVersionCompatibility':True,
     'explicitMigrationOnly':True,'loadingErrorRecoveryAndInputsPreserved':True,'writes':len(writes)})
    print('PASS responsive Outstream UI',width)
   except Exception:
    page.screenshot(path=str(out/f'failure-{width}.png'),full_page=True);raise
   finally:page.close()
 finally:browser.close()
(out/'results.json').write_text(json.dumps(checks,indent=2))
