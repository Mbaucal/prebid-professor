"""Actual Ads.txt version portal, synthetic API; no publisher endpoint calls."""
import json,subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent;out=root/'.generated/adstxt-version-evidence';out.mkdir(parents=True,exist_ok=True)
origin='http://127.0.0.1:4182'
def site(id):return dict(id=id,publisherAccountId='owner',name=id+'.invalid',domain=id+'.invalid',gamPath='/123/',status='draft',currentVersion='draft',adsTxtUrl='',updatedAt='2026-10-01',adUnitsCount=0,biddersCount=0)
accounts=[dict(id='owner',name='Owner',status='active',sitesCount=2,sites=[site('site-a'),site('site-b')],notes='')]
def version(id):return dict(id=id,siteId='site-a',versionNumber=1,status='saved',checksum='a'*64,rowCount=1,canonicalCount=1,repeatedRowCount=0,headingCount=0,lineCount=1,byteSize=24,note='Earlier snapshot',createdBy='fixture',generatedAt='2026-10-01',createdAt='2026-10-01')
server=subprocess.Popen(['node','scripts/layout-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True);results=[]
try:
 assert 'ready' in server.stdout.readline()
 with sync_playwright() as p:
  browser=p.chromium.launch()
  for width in [1440,390]:
   page=browser.new_page(viewport={'width':width,'height':900});state={'fault':False,'checksum':'a'*64,'saved':False};pending=[];details=[];lists=[];downloads=[];writes=[];errors=[];external=[]
   page.on('download',lambda download:downloads.append(download.suggested_filename))
   page.on('pageerror',lambda e:errors.append(str(e)))
   def route(r):
    path=urlparse(r.request.url).path
    if not r.request.url.startswith(origin+'/'):external.append(r.request.url);r.abort();return
    if path=='/api/publisher-accounts':r.fulfill(json={'publishers':accounts});return
    if path=='/api/organization':r.fulfill(json={'agencies':[],'memberships':[]});return
    if '/ads-txt/versions' in path:
     if r.request.method=='POST':writes.append(r.request.post_data_json);pending.append(r);return
     if path.endswith('/versions'):
      if state.get('holdList'):state['holdList']=False;lists.append(r);return
      if state['fault']:r.fulfill(status=503,json={'error':'History temporarily unavailable'});return
      meta=version('v1');r.fulfill(json=dict(ok=True,siteId=path.split('/')[3],versions=[meta] if state['saved'] else [],totalVersions=55 if state['saved'] else 0,currentVersion=meta if state['saved'] else None,currentFile={'checksum':state['checksum'],'rowCount':1,'byteSize':24}));return
     if state.get('holdDetail'):state['holdDetail']=False;details.append(r);return
     r.fulfill(json={'ok':True,'version':{**version('v1'),'content':'example.com, 1, DIRECT\n','fileName':'ads-v1.txt'}});return
    if r.request.method!='GET':raise AssertionError('Unexpected write '+path)
    if path.endswith('/ads-txt/managed-file'):r.fulfill(json={'ok':True,'file':{'siteId':'site-a','content':'example.com, 1, DIRECT\n','checksum':state['checksum'],'rowCount':1,'byteSize':24}});return
    if '/ads-txt' in path:r.fulfill(json={'ok':True,'requirements':[],'checks':[],'siteId':'site-a','adsTxtUrl':'','connection':None});return
    r.continue_()
   page.route('**/*',route)
   def choose(id):
    menu=page.get_by_role('button',name='Menu',exact=True)
    if menu.is_visible():menu.click()
    page.locator('.site-link').filter(has_text=id+'.invalid').click()
    expect(page.locator('.workspace h1')).to_have_text(id+'.invalid')
   def record(name):
    assert not errors,errors;assert not external,external
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    results.append({'case':name,'width':width,'passed':True})
   page.goto(origin+'/?section=publishers&publisher=owner&site=site-a&tab=ads-txt')
   card=page.locator('.ads-txt-versions-card');expect(card.get_by_role('button',name='Save current version')).to_be_enabled()
   note=card.get_by_label('Version note (optional)');note.fill('Keep reviewed note')
   card.get_by_role('button',name='Save current version').click();expect(card.get_by_role('button',name='Saving version…')).to_be_disabled();assert writes[-1]['expectedChecksum']=='a'*64
   pending.pop().fulfill(status=409,json={'error':'The managed ads.txt file changed after you reviewed it. Click Refresh status and save again.'})
   expect(card.locator('.form-error')).to_contain_text('changed after you reviewed');expect(note).to_have_value('Keep reviewed note');record('stale-review-note-retained')
   state['fault']=True;card.get_by_role('button',name='Refresh status').click();expect(card.locator('.form-error')).to_contain_text('temporarily unavailable');expect(note).to_have_value('Keep reviewed note')
   state['fault']=False;state['checksum']='b'*64;card.get_by_role('button',name='Refresh status').click();expect(card.get_by_role('button',name='Save current version')).to_be_enabled();record('list-error-retry')
   card.get_by_role('button',name='Save current version').click();expect(card.get_by_role('button',name='Saving version…')).to_be_visible();old=pending.pop();assert writes[-1]['expectedChecksum']=='b'*64
   choose('site-b');expect(card.locator('.ads-txt-versions-site')).to_contain_text('site-b.invalid');choose('site-a');expect(card.get_by_role('button',name='Save current version')).to_be_enabled();note.fill('New visit note')
   with page.expect_response(lambda response: response.request.method=='POST' and '/ads-txt/versions' in response.url) as complete:old.fulfill(json={'ok':True,'created':True,'message':'STALE SAVED','version':version('v1')})
   complete.value.body();page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
   expect(note).to_have_value('New visit note');expect(card).not_to_contain_text('STALE SAVED');record('a-b-a-late-save')
   state['saved']=True;state['checksum']='a'*64;card.get_by_role('button',name='Refresh status').click();expect(card.get_by_role('button',name='Already saved as v1')).to_be_disabled();expect(card).to_contain_text('CURRENT DRAFT = V1')
   card.get_by_role('button',name='Show version history',exact=False).click();card.get_by_role('button',name='Preview',exact=True).click();expect(card.locator('pre')).to_contain_text('example.com, 1, DIRECT')
   card.scroll_into_view_if_needed();page.screenshot(path=str(out/f'history-{width}.png'));record('full-history-match-preview')
   # Cached actions in the same task as a changed site marker, before the 50ms detector.
   page.evaluate("""() => {
    window.fixtureCopies=0;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{window.fixtureCopies++}}});
    const heading=document.querySelector('.workspace > .topbar h1'),old=heading.textContent;
    heading.textContent='site-b.invalid';
    for(const name of ['Download','Copy']) [...document.querySelectorAll('.ads-txt-versions-card button')].find(b=>b.textContent.trim()===name).click();
    heading.textContent=old;
   }""")
   page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
   assert not downloads;assert page.evaluate('window.fixtureCopies')==0;record('cached-action-marker-race')
   # A detail request initiated for export cannot export into a later site visit.
   page.reload();expect(card.get_by_role('button',name='Already saved as v1')).to_be_disabled()
   card.get_by_role('button',name='Show version history',exact=False).click();state['holdDetail']=True
   card.get_by_role('button',name='Download',exact=True).click();expect(card.get_by_role('button',name='Loading…')).to_be_visible();old=details.pop()
   choose('site-b');expect(card.locator('.ads-txt-versions-site')).to_contain_text('site-b.invalid');choose('site-a');expect(card.get_by_role('button',name='Already saved as v1')).to_be_disabled();note.fill('Latest input')
   with page.expect_response(lambda response: response.url.endswith('/versions/v1')) as complete:old.fulfill(json={'ok':True,'version':{**version('v1'),'content':'STALE EXPORT','fileName':'stale.txt'}})
   complete.value.body();page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
   assert not downloads;expect(note).to_have_value('Latest input');record('late-export-cancelled')
   state['holdList']=True;card.get_by_role('button',name='Refresh status').click();expect(card).to_contain_text('Loading ads.txt versions');old=lists.pop()
   choose('site-b');expect(card.locator('.ads-txt-versions-site')).to_contain_text('site-b.invalid');expect(card.get_by_role('button',name='Already saved as v1')).to_be_disabled();note.fill('Site B input')
   with page.expect_response(lambda response: '/site-a/ads-txt/versions?' in response.url) as complete:old.fulfill(status=503,json={'error':'STALE HISTORY ERROR'})
   complete.value.body();page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
   expect(card).not_to_contain_text('STALE HISTORY ERROR');expect(note).to_have_value('Site B input');record('late-list-error-ignored')
   page.close()
  browser.close()
 (out/'results.json').write_text(json.dumps(results,indent=2));print(f'{len(results)} ads.txt UI checks passed')
finally:server.terminate();server.wait(timeout=10)
