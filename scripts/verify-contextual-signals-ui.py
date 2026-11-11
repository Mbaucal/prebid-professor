"""PPS category editor: native React + Worker, desktop/narrow, save/error/retry.

Every request is fulfilled locally. No live ads, publisher writes or SSP calls.
"""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/contextual-signals-ui-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://contextual.fixture.invalid';endpoint='/api/publishers/audit-site/contextual-signals'
checks=[]
with sync_playwright() as playwright:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=playwright.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/contextual-signals-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(process.stdout.readline());assert ready['ready']
   page=browser.new_page(viewport={'width':width,'height':900});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   pending=[];faults={'holdGet':True,'holdPost':False,'failPost':False}
   def send(path,body=None,headers=None):
    process.stdin.write(json.dumps({'path':path,'method':'POST' if body is not None else 'GET','body':json.dumps(body) if body is not None else None,'headers':headers or {}})+'\n');process.stdin.flush()
    value=json.loads(process.stdout.readline());assert 'error' not in value,value;return value
   def data(path=endpoint,body=None):
    value=send(path,body);payload=json.loads(base64.b64decode(value['body']));assert value['status']==200,payload;return payload
   def fulfill(route,failure=None):
    req=route.request
    if failure:result={'status':503,'headers':{'content-type':'application/json'},'body':base64.b64encode(json.dumps({'error':failure}).encode()).decode()}
    else:
     process.stdin.write(json.dumps({'path':urlsplit(req.url).path,'method':req.method,'body':req.post_data})+'\n');process.stdin.flush();result=json.loads(process.stdout.readline());assert 'error' not in result,result
    route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
   def route(request):
    req=request.request;url=urlsplit(req.url);assert url.netloc=='contextual.fixture.invalid','External request blocked'
    if url.path==endpoint and req.method=='GET' and faults['holdGet']:faults['holdGet']=False;pending.append(request)
    elif url.path==endpoint and req.method=='POST' and faults['holdPost']:faults['holdPost']=False;pending.append(request)
    elif url.path==endpoint and req.method=='POST' and faults['failPost']:faults['failPost']=False;fulfill(request,'Synthetic save unavailable. Retry your edits.')
    else:fulfill(request)
   page.route('**/*',route)
   def screen(name):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'),'Horizontal overflow'
    page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
   panel=page.get_by_role('region',name='Contextual signals',exact=True)
   save=panel.get_by_role('button',name='Save contextual signals',exact=True)
   try:
    page.goto(origin,wait_until='domcontentloaded');expect(panel.get_by_role('status')).to_contain_text('Loading');screen('loading')
    fulfill(pending.pop(),'Synthetic load unavailable.');expect(panel.get_by_role('alert')).to_contain_text('Synthetic load');screen('load-error')
    panel.get_by_role('button',name='Reload saved settings').click();expect(panel.get_by_role('checkbox',name='Enable contextual signals for this site')).not_to_be_checked();expect(save).to_be_disabled()
    expect(page.get_by_role('navigation',name='Demand settings')).to_be_visible();expect(panel).to_contain_text('GAM 360');screen('defaults')
    current=data();cat30=next(item for item in current['taxonomies'] if item['id']=='iab-content-3.0')['categories'][0]['id']
    panel.get_by_role('checkbox',name='Enable contextual signals for this site').check();panel.get_by_role('checkbox',name='Google Ad Manager PPS',exact=False).check()
    panel.get_by_role('combobox',name='Taxonomy for pubmatic').select_option('iab-content-2.2');panel.get_by_role('combobox',name='Taxonomy for openx').select_option('iab-content-3.0')
    panel.get_by_role('button',name='Add category mapping').click();panel.get_by_role('textbox',name='Page category 1',exact=True).fill('Books')
    ids22=panel.get_by_role('combobox',name='Content 2.2 IDs for mapping 1');ids30=panel.get_by_role('combobox',name='Content 3.0 IDs for mapping 1')
    ids22.fill('48, 127');ids30.fill(cat30);expect(save).to_be_enabled();screen('configured')
    faults['holdPost']=True;save.click();expect(panel.get_by_role('button',name='Saving…')).to_be_disabled();expect(ids22).to_be_disabled();expect(panel.get_by_role('button',name='Add category mapping')).to_be_disabled();screen('saving')
    fulfill(pending.pop(),'Synthetic save unavailable. Retry your edits.');expect(panel.get_by_role('alert')).to_contain_text('Synthetic save');expect(ids22).to_have_value('48, 127');expect(ids30).to_have_value(cat30);expect(save).to_be_enabled();screen('save-error')
    save.click();expect(panel.get_by_role('status')).to_contain_text('Saved.');expect(save).to_be_disabled()
    saved=data()['settings'];assert saved['enabled'] and saved['gam']['enabled'];assert saved['mappings'][0]['taxonomies']['iab-content-2.2']==['48','127'];assert saved['mappings'][0]['taxonomies']['iab-content-3.0']==[cat30]
    assert {item['bidder']:item['taxonomy'] for item in saved['bidders']}=={'pubmatic':'iab-content-2.2','openx':'iab-content-3.0'}
    page.reload();expect(ids22).to_have_value('48, 127');expect(ids30).to_have_value(cat30);expect(save).to_be_disabled();screen('reloaded')
    ids22.fill('IAB17');save.click();expect(panel.get_by_role('alert')).to_be_visible();expect(ids22).to_have_value('IAB17');assert data()['settings']==saved;screen('invalid-id')
    ids22.fill('48');data('/__fixture/stale',{});save.click();expect(panel.get_by_role('alert')).to_contain_text('Site settings changed');expect(ids22).to_have_value('48');screen('stale')
    panel.get_by_role('button',name='Reload saved settings').click();expect(ids22).to_have_value('48, 127');expect(save).to_be_disabled()
    panel.get_by_role('checkbox',name='Enable contextual signals for this site').uncheck();save.click();expect(panel.get_by_role('status')).to_contain_text('Saved.');assert data()['settings']['enabled'] is False;assert data()['settings']['mappings']==saved['mappings']
    panel.get_by_role('button',name='Add category mapping').click();panel.get_by_role('textbox',name='Page category 2',exact=True).fill('Unsaved');panel.get_by_role('button',name='Reset changes').click();expect(panel.get_by_role('textbox',name='Page category 2',exact=True)).to_have_count(0)
    screen('off-saved');assert not errors,errors
    # Real route auth and cross-origin protection; invalid writes never reach service.
    no_auth=send(endpoint,{'revision':data()['revision'],'settings':saved},{'cookie':''});assert no_auth['status']==401
    cross=send(endpoint,{'revision':data()['revision'],'settings':saved},{'origin':'https://other.invalid'});assert cross['status']==403
    checks.append({'width':width,'checks':['load/retry','default-off','version-specific-mapping','independent-routes','pending-lock','save-error-preserves','save/reload','invalid-ID','stale/reload','off-preserves','reset','auth/origin','no-overflow','zero-page-errors'],'pass':True})
   finally:
    page.close();process.stdin.close();process.wait(timeout=15)
 finally:browser.close()
(out/'results.json').write_text(json.dumps({'checks':checks},indent=2)+'\n');print(json.dumps({'checks':checks},indent=2))
