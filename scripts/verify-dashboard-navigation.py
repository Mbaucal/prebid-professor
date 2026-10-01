"""Actual dashboard build, synthetic API only: URL identity, history and recovery."""
import copy,json,subprocess
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parent.parent
out=root/'.generated/navigation-evidence';out.mkdir(parents=True,exist_ok=True)
origin='http://127.0.0.1:4182'
def site(id,owner):
 return {'id':id,'publisherAccountId':owner,'name':id+'.example.com','domain':id+'.example.com','gamPath':'/123/test/','status':'draft','currentVersion':'draft','adsTxtUrl':'https://example.invalid/ads.txt','updatedAt':'2026-10-01T00:00:00Z','lastPublishedAt':None,'adUnitsCount':0,'biddersCount':0}
initial=[{'id':id,'name':name,'status':'active','sitesCount':len(ids),'sites':[site(s,id) for s in ids],'notes':''} for id,name,ids in [('publisher-a','North Publisher',['site-a1','site-a2']),('publisher-b','South Publisher',['site-b1']),('empty','Empty Publisher',[])]]
organization={'agencies':[{'id':id,'name':name,'logo':None,'revision':1,'createdAt':'2026-10-01','updatedAt':'2026-10-01'} for id,name in [('north','North agency'),('south','South agency')]],'memberships':[{'publisherId':'publisher-a','agencyId':'north','revision':1},{'publisherId':'publisher-b','agencyId':'south','revision':1}]}
pin={'runtimeVersion':'3.14.0','runtimeSha256':'a'*64}
setup={'revision':'synthetic','selected':pin,'enablePrebid':False,'validationIssue':None,'prebid':{'status':'off','message':'Synthetic fixture'},'runtimes':[{'version':'3.14.0','pin':pin}],'history':[]}
server=subprocess.Popen(['node','scripts/layout-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
results=[]
try:
 assert 'ready' in server.stdout.readline()
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  for width in [1440,390]:
   accounts=copy.deepcopy(initial);fault={'hierarchy':False,'agency':False,'defer':False};pending=[];pending_saves=[];pending_deletes=[]
   requests=[];external=[];errors=[];writes=[]
   context=browser.new_context(viewport={'width':width,'height':900})
   page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   def route(r):
    url=urlparse(r.request.url);path=url.path;method=r.request.method
    if not r.request.url.startswith(origin+'/'):
     external.append(r.request.url);r.abort();return
    if path.startswith('/api/'): requests.append({'method':method,'path':path})
    if path=='/api/publisher-accounts':
     if fault['defer']:pending.append(r);return
     r.fulfill(status=503 if fault['hierarchy'] else 200,json={'error':'Synthetic hierarchy unavailable'} if fault['hierarchy'] else {'publishers':accounts});return
    if path=='/api/organization':
     r.fulfill(status=503 if fault['agency'] else 200,json={'error':'Synthetic agency unavailable'} if fault['agency'] else organization);return
    if path.endswith('/builtin-site-settings'):
     if method=='POST':
      writes.append({'method':method,'path':path,'synthetic':True});pending_saves.append(r);return
     assert method=='GET'
     r.fulfill(json=setup);return
    if path.startswith('/api/sites/') and method=='DELETE':
     writes.append({'method':method,'path':path,'synthetic':True});pending_deletes.append(r);return
    if path.endswith('/releases'):
     id=path.split('/')[3]
     r.fulfill(json={'ok':True,'releases':[{'id':'release-'+id,'publisherId':id,'version':'synthetic','status':'draft','configHash':None,'notes':None,'createdBy':None,'createdAt':'2026-10-01T00:00:00Z','publishedAt':None,'manifest':None}]});return
    if path.startswith('/api/publisher-accounts/') and method in ['PATCH','DELETE']:
     id=path.rsplit('/',1)[1];account=next(a for a in accounts if a['id']==id);writes.append({'method':method,'path':path,'synthetic':True})
     if method=='PATCH':account.update(r.request.post_data_json);r.fulfill(json={'publisher':account})
     else:accounts.remove(account);r.fulfill(json={'ok':True,'deletedId':id})
     return
    if method!='GET':raise AssertionError('Unexpected write '+method+' '+path)
    r.continue_()
   page.route('**/*',route)
   def menu():
    button=page.get_by_role('button',name='Menu',exact=True)
    if button.is_visible():button.click()
   def choose(id):
    menu();page.locator('.site-link').filter(has_text=id+'.example.com').click()
    expect(page.locator('.workspace h1')).to_have_text(id+'.example.com')
   def current(id,tab='Overview'):
    expect(page.locator('.workspace h1')).to_have_text(id+'.example.com')
    expect(page.locator('.tabbar .active')).to_have_text(tab)
    assert parse_qs(urlparse(page.url).query)['site']==[id]
   def record(name,screenshot=False):
    assert not errors,errors
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),name
    if screenshot:page.screenshot(path=str(out/f'{name}-{width}.png'))
    results.append({'case':name,'width':width,'passed':True,'url':page.url})
   try:
    page.goto(origin+'/?campaign=keep#anchor');current('site-a1')
    assert 'campaign=keep' in page.url and page.url.endswith('#anchor')
    record('initial-canonical')
    choose('site-a2');page.locator('.tabbar').get_by_role('button',name='Config',exact=True).click();current('site-a2','Config')
    expect(page.get_by_role('heading',name='Script setup',exact=True)).to_be_visible()
    selected=page.url;page.reload();current('site-a2','Config');assert page.url==selected
    record('reload-config',True)
    page.go_back();current('site-a2');page.go_back();current('site-a1')
    page.go_forward();current('site-a2');page.go_forward();current('site-a2','Config')
    history=page.evaluate('history.length');page.locator('.tabbar').get_by_role('button',name='Config',exact=True).click();assert page.evaluate('history.length')==history
    record('back-forward-no-duplicate')
    menu();page.locator('.main-nav').get_by_role('button',name='Settings',exact=True).click()
    expect(page.locator('.workspace h1')).to_have_text('Settings');settings=page.url
    page.reload();expect(page.locator('.workspace h1')).to_have_text('Settings');assert page.url==settings
    page.go_back();current('site-a2','Config');record('global-section-history')
    page.goto(origin+'/?site=site-b1&tab=config&agency=south');current('site-b1','Config')
    assert parse_qs(urlparse(page.url).query)['publisher']==['publisher-b'];record('direct-link-resolved-owner')
    # Filtering out the active site leaves an explicit empty selection, not another site's editor.
    menu();page.locator('.sidebar .agency-filter select').select_option('north')
    expect(page.locator('.workspace h1')).to_have_text('Tessera')
    assert 'site=' not in page.url;expect(page.get_by_role('button',name='Edit site',exact=True)).to_be_disabled()
    choose('site-a2');current('site-a2');assert 'agency=north' in page.url
    page.reload();current('site-a2');record('agency-filter-reload',True)
    for query in ['site=missing&tab=config','site=site-a2&agency=south','site=site-a2&tab=missing','site=site-a1&site=site-a2']:
     before=len(requests);page.goto(origin+'/?'+query)
     expect(page.get_by_role('heading',name='Selection unavailable',exact=True)).to_be_visible()
     assert urlparse(page.url).query==query
     assert not page.locator('.site-link.active').count()
     assert not [r for r in requests[before:] if r['path'].startswith('/api/publishers/')]
    record('invalid-link-no-fallback',True)
    choose('site-a2');current('site-a2');record('invalid-link-recovery')
    # A once-valid bookmark becomes unavailable after the hierarchy changes.
    accounts[0]['sites']=[accounts[0]['sites'][0]];accounts[0]['sitesCount']=1
    before=len(requests);page.reload()
    expect(page.get_by_role('heading',name='Selection unavailable',exact=True)).to_be_visible()
    expect(page.locator('.workspace')).to_contain_text('site in this link is no longer available')
    assert not [r for r in requests[before:] if r['path'].startswith('/api/publishers/')]
    accounts[0]['sites']=copy.deepcopy(initial[0]['sites']);accounts[0]['sitesCount']=2
    page.get_by_role('button',name='Reload hierarchy',exact=True).click();current('site-a2');record('deleted-site-reload-recovery')
    fault['hierarchy']=True;page.goto(origin+'/?site=site-a2&tab=config')
    expect(page.locator('.workspace')).to_contain_text('Synthetic hierarchy unavailable');record('hierarchy-error',True)
    fault['hierarchy']=False;page.get_by_role('button',name='Reload hierarchy',exact=True).click();current('site-a2','Config');record('hierarchy-error-recovery')
    fault['agency']=True;page.goto(origin+'/?site=site-a2&tab=config&agency=north')
    expect(page.locator('.workspace')).to_contain_text('Synthetic agency unavailable')
    fault['agency']=False;page.get_by_role('button',name='Reload hierarchy',exact=True).click();current('site-a2','Config');record('agency-error-recovery')
    # Finishing an old panel's save must not undo a newer site selection or Back.
    for navigation in ['click','back']:
     page.goto(origin+'/?site=site-b1&tab=config');current('site-b1','Config');choose('site-a2')
     page.locator('.script-mode-options input').nth(1).check()
     page.get_by_role('button',name='Save script setup',exact=True).click()
     expect(page.get_by_role('button',name='Saving…',exact=True)).to_be_visible()
     if navigation=='click':choose('site-b1')
     else:page.go_back()
     current('site-b1','Config');destination=page.url
     with page.expect_response(lambda response:response.url==origin+'/api/publisher-accounts'):
      pending_saves.pop().fulfill(json=setup)
     expect(page.locator('.publisher-nav-message').filter(has_text='Loading publisher hierarchy…')).to_have_count(0)
     current('site-b1','Config');assert page.url==destination
     record('deferred-save-'+navigation)
    page.goto(origin+'/?site=site-a2&tab=config&agency=north');current('site-a2','Config')
    page.locator('.script-mode-options input').nth(1).check();page.get_by_role('button',name='Save script setup',exact=True).click()
    expect(page.get_by_role('button',name='Saving…',exact=True)).to_be_visible()
    with page.expect_response(lambda response:response.url==origin+'/api/publisher-accounts'):
     pending_saves.pop().fulfill(json=setup)
    expect(page.locator('.publisher-nav-message').filter(has_text='Loading publisher hierarchy…')).to_have_count(0)
    current('site-a2','Config');assert 'agency=north' in page.url;record('save-preserves-agency-filter')
    # The existing edit-publisher reload keeps the exact second-site URL and tab.
    menu();page.get_by_role('button',name='Edit publisher North Publisher',exact=True).click()
    dialog=page.get_by_role('dialog');dialog.get_by_label('Publisher name',exact=True).fill('North Publisher Updated')
    dialog.get_by_role('button',name='Save publisher',exact=True).click()
    current('site-a2','Config');expect(page.locator('.agency-selection-breadcrumb')).to_contain_text('North Publisher Updated')
    record('publisher-edit-preserves-context')
    page.goto(origin+'/?publisher=empty');expect(page.locator('.workspace h1')).to_have_text('Empty Publisher')
    menu();page.get_by_role('button',name='Edit publisher Empty Publisher',exact=True).click()
    dialog=page.get_by_role('dialog');dialog.get_by_role('button',name='Delete publisher',exact=True).click()
    dialog.get_by_label('Type the Publisher ID to confirm',exact=True).fill('empty')
    dialog.get_by_role('button',name='Delete permanently',exact=True).click()
    expect(page.get_by_role('heading',name='Selection unavailable',exact=True)).to_be_visible()
    assert parse_qs(urlparse(page.url).query)['publisher']==['empty']
    choose('site-a2');current('site-a2');record('publisher-delete-no-fallback')
    # Deletion finishing in the background cannot clear the newly selected site.
    page.goto(origin+'/?site=site-a2');current('site-a2')
    page.once('dialog',lambda dialog:dialog.accept());page.get_by_role('button',name='Delete site',exact=True).click()
    choose('site-b1');destination=page.url
    accounts[0]['sites']=[accounts[0]['sites'][0]];accounts[0]['sitesCount']=1
    with page.expect_response(lambda response:response.url==origin+'/api/publisher-accounts'):
     pending_deletes.pop().fulfill(json={'ok':True,'deletedId':'site-a2'})
    expect(page.locator('.publisher-nav-message').filter(has_text='Loading publisher hierarchy…')).to_have_count(0)
    current('site-b1');assert page.url==destination;record('deferred-delete-keeps-new-site')
    accounts[0]['sites']=copy.deepcopy(initial[0]['sites']);accounts[0]['sitesCount']=2
    page.goto(origin+'/?section=releases&site=site-a2&agency=north')
    expect(page.locator('.workspace h1')).to_have_text('Releases')
    row=page.locator('tr').filter(has_text='site-b1.example.com')
    row.get_by_role('button',name='Open site',exact=True).click();current('site-b1','Releases')
    assert 'agency=' not in page.url;page.reload();current('site-b1','Releases');record('global-open-site-callback')
    # A late initial hierarchy response cannot replace a newer global navigation.
    fault['defer']=True;page.goto(origin+'/',wait_until='domcontentloaded')
    expect(page.locator('.workspace h1')).to_have_text('Loading publisher hierarchy…')
    menu();page.locator('.main-nav').get_by_role('button',name='Settings',exact=True).click()
    fault['defer']=False
    for r in pending:r.fulfill(json={'publishers':accounts})
    expect(page.locator('.workspace h1')).to_have_text('Settings');assert 'section=settings' in page.url
    record('late-hierarchy-keeps-navigation')
    # Keyboard remains a complete way to recover from an invalid link.
    page.goto(origin+'/?site=missing');expect(page.get_by_role('heading',name='Selection unavailable',exact=True)).to_be_visible()
    menu();link=page.locator('.site-link').filter(has_text='site-a2.example.com');link.focus();page.keyboard.press('Enter');current('site-a2')
    record('keyboard-recovery',True)
    assert not external,external;assert not errors,errors
    assert len(writes)==6,writes
    results.append({'case':'traffic-boundary','width':width,'passed':True,'syntheticWrites':writes,'externalRequests':external,'pageErrors':errors})
   except Exception:
    page.screenshot(path=str(out/f'failure-{width}.png'));(out/f'failure-{width}.json').write_text(json.dumps({'url':page.url,'errors':errors,'requests':requests,'body':page.locator('body').inner_text()},indent=2));raise
   finally:context.close()
  browser.close()
 (out/'result.json').write_text(json.dumps({'scope':'actual production dashboard with intercepted synthetic APIs; no hosted data or ad traffic','checks':results},indent=2))
 print(f'PASS: {len(results)} navigation cases, desktop/390; synthetic publisher edit/delete, no external traffic')
finally:
 server.terminate();server.wait(timeout=10)
