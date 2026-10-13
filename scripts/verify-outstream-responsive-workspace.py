"""Actual TEST Formats + map editor against the isolated Worker, SQLite and fake R2.
The browser routes every request through a local stdin fixture; no hosted traffic.
"""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/outstream-responsive-workspace-evidence';out.mkdir(parents=True,exist_ok=True)
checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox'])
 try:
  for width in [1440,390]:
   process=subprocess.Popen(['node','--experimental-strip-types','scripts/site-workspace-browser-fixture.mjs','--revenue'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   assert json.loads(process.stdout.readline())['ready']
   page=browser.new_page(viewport={'width':width,'height':900});errors=[];requests=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   def send(path,body=None):
    process.stdin.write(json.dumps({'path':path,'method':'GET' if body is None else 'POST','body':None if body is None else json.dumps(body)})+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    return result
   def data(path,body=None):
    result=send(path,body);value=json.loads(base64.b64decode(result['body']));assert result['status']==200,value;return value
   def route(r):
    url=urlsplit(r.request.url);assert url.netloc=='tessera.fixture.invalid','External request blocked'
    process.stdin.write(json.dumps({'path':url.path,'method':r.request.method,'body':r.request.post_data})+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    requests.append({'path':url.path,'method':r.request.method,'status':result['status']})
    r.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
   page.route('**/*',route)
   try:
    selection=data('/test-api/runtime-selection')
    runtime=next(r for r in selection['runtimes'] if r['version']=='3.16.0-revenue.preview.3')
    data('/test-api/runtime-selection',{'expectedRevision':selection['revision'],'selection':{
     'runtime':runtime['pin'],'allowPreview':True,'enablePrebid':selection['enablePrebid'],'prebidBuildId':selection['prebidBuildId']}})
    inventory=data('/test-api/site-settings');position=next(u for u in inventory['draft']['units'] if u['code']=='Billboard');map_name=position['sizeMap']
    assigned=next(m for m in inventory['draft']['maps'] if m['name']==map_name)
    assigned['breakpoints']=[{'minWidth':0,'sizes':[[300,250]]},{'minWidth':1024,'sizes':[[640,360]]},{'minWidth':1600,'sizes':[]}]
    data('/test-api/site-settings',{'expectedRevision':inventory['revision'],'acknowledge':True,'draft':inventory['draft']})
    assert data('/test-api/outstream-settings')['responsiveSizing'] is True
    def formats():
     page.goto('https://tessera.fixture.invalid/site-workspace#formats')
     page.get_by_role('button',name='Configure formats for Billboard',exact=True).click()
     expect(page.get_by_label('Ad format',exact=True)).to_be_visible()
    def save_formats():
     page.get_by_role('button',name='Save format settings',exact=True).click()
     expect(page.get_by_text('Saved for the next revenue preview release. Existing scripts are unchanged.',exact=True)).to_be_visible()
    def screen(name):
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Horizontal page overflow'
     page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
    def map_sizes(value):
     page.goto('https://tessera.fixture.invalid/site-settings#maps')
     expect(page.locator('#editor-message')).not_to_contain_text('Loading saved')
     box=page.locator('#maps > details').filter(has=page.get_by_text(map_name,exact=True))
     if not box.evaluate('(element)=>element.open'):box.locator('summary').click()
     box.get_by_label('Allowed sizes',exact=True).nth(1).fill(value)
     page.locator('#confirm-draft').check();page.locator('#save-site').click()
     expect(page.locator('#editor-message')).to_contain_text('Site settings saved.')
    formats();page.get_by_label('Ad format',exact=True).select_option('banner-outstream')
    expect(page.get_by_label('Player width (px)',exact=True)).to_have_count(0)
    expect(page.get_by_text('300 × 250 px · Automatic',exact=False)).to_be_visible()
    expect(page.get_by_text('640 × 360 px · Automatic',exact=False)).to_be_visible()
    expect(page.get_by_text('Ads disabled at this breakpoint.',exact=False)).to_be_visible()
    page.get_by_label('PubMatic outstream renderer ID',exact=True).fill('responsive_fixture')
    page.get_by_label('PubMatic confirmed this placement is activated for outstream.',exact=True).check()
    save_formats();saved=data('/test-api/outstream-settings')['outstream']['units']['Billboard']
    assert saved['playerSizing']=='size-map' and saved['playerSizes']=={} and 'playerSize' not in saved
    formats();expect(page.get_by_label('Ad format',exact=True)).to_have_value('banner-outstream')
    expect(page.get_by_label('PubMatic outstream renderer ID',exact=True)).to_have_value('responsive_fixture')
    page.get_by_text('640 × 360 px · Automatic',exact=False).scroll_into_view_if_needed();screen('test-responsive-saved')
    first=data('/test-api/generate',{'acknowledge':True})
    assert first['descriptor']['runtime']['runtimeVersion']=='3.16.0-revenue.preview.3'
    stored=data('/test-api/save',{'receipt':first['receipt'],'acknowledge':True,'note':'Synthetic responsive before map edit'})
    old_id=stored['draft']['id'];old_index=data('/test-api/releases/'+old_id+'/index')
    # Actual operator map edit must be saved as a draft, then visibly require a choice.
    # It must never force the user to disable Outstream first.
    map_sizes('640x360, 970x250')
    expect(page.locator('#outstream-sizing-notice')).to_be_visible()
    expect(page.locator('#outstream-sizing-notice')).to_contain_text('Review Outstream sizes before Generate')
    page.locator('#outstream-sizing-notice').scroll_into_view_if_needed();screen('test-map-review-needed')
    state=data('/test-api/site-settings');assert state['formatReviewRequired']
    assert data('/test-api/outstream-settings')['outstream']['units']['Billboard']==saved,'Map edit silently rewrote saved video settings'
    blocked=send('/test-api/generate',{'acknowledge':True});assert blocked['status'] in [409,422],blocked
    page.get_by_role('link',name='Review format settings',exact=True).click()
    page.get_by_role('button',name='Configure formats for Billboard',exact=True).click()
    selector=page.get_by_label('Video size · '+map_name+' · from 1024px wide',exact=True)
    expect(selector).to_have_value('');expect(page.get_by_role('button',name='Save format settings',exact=True)).to_be_disabled()
    selector.select_option('970x250');save_formats()
    fixed=data('/test-api/outstream-settings')['outstream']['units']['Billboard']
    assert fixed['playerSizes']=={map_name+'@1024x0':[970,250]} and fixed['partner']==saved['partner']
    assert not data('/test-api/site-settings')['formatReviewRequired']
    corrected=data('/test-api/generate',{'acknowledge':True});assert corrected['descriptor']['runtime']==first['descriptor']['runtime']
    # Removing the selected size follows the same review path; the remaining sole size is automatic.
    map_sizes('640x360')
    expect(page.locator('#outstream-sizing-notice')).to_be_visible()
    assert send('/test-api/generate',{'acknowledge':True})['status'] in [409,422]
    page.get_by_role('link',name='Review format settings',exact=True).click()
    page.get_by_role('button',name='Configure formats for Billboard',exact=True).click()
    expect(page.get_by_text('640 × 360 px · Automatic',exact=False)).to_be_visible();save_formats()
    assert data('/test-api/outstream-settings')['outstream']['units']['Billboard']['playerSizes']=={}
    page.goto('https://tessera.fixture.invalid/site-settings#maps')
    expect(page.locator('#editor-message')).not_to_contain_text('Loading saved');expect(page.locator('#outstream-sizing-notice')).to_be_hidden()
    page.goto('https://tessera.fixture.invalid/')
    page.locator('#generate').click();expect(page.locator('#review-summary')).to_contain_text('3.16.0-revenue.preview.3',timeout=90000)
    screen('test-responsive-generated')
    assert data('/test-api/releases/'+old_id)['verified'] is True
    assert data('/test-api/releases/'+old_id+'/index')==old_index,'Map edits changed original saved release'
    assert not errors,errors
    assert not any(r['path'].startswith('/api/publishers/') for r in requests)
    checks.append({'width':width,'actualSharedPanelAndSQLite':True,'selectedRuntime':'3.16.0-revenue.preview.3',
     'separateMobileDesktopSizes':True,'newAmbiguityAndRemovedChoiceDraftRecovery':True,'generateBlockedUntilReviewed':True,
     'rendererAndSavedReleasePreserved':True,'requests':requests})
    print('PASS actual TEST responsive map/Formats recovery',width)
   except Exception:
    page.screenshot(path=str(out/f'failure-{width}.png'),full_page=True);raise
   finally:
    page.close();process.stdin.close();process.wait(timeout=10)
 finally:browser.close()
(out/'results.json').write_text(json.dumps(checks,indent=2))
