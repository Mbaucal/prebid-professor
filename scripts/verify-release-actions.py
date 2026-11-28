"""Actual built App: release shortcuts navigate/focus; intercepted synthetic API only."""
import json,subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/release-action-evidence';out.mkdir(parents=True,exist_ok=True)
origin='http://127.0.0.1:4182'
def site(id):return {'id':id,'publisherAccountId':'publisher-a','name':id+'.example.com','domain':id+'.example.com','gamPath':'/123/test/','status':'draft','currentVersion':'draft','updatedAt':'2026-10-01','adUnitsCount':0,'biddersCount':0}
accounts=[{'id':'publisher-a','name':'Synthetic Publisher','status':'active','sites':[site('site-a'),site('site-b')],'sitesCount':2}]
server=subprocess.Popen(['node','scripts/layout-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
results=[]
try:
 assert 'ready' in server.stdout.readline()
 with sync_playwright() as p:
  browser=p.chromium.launch()
  for width in (1440,390):
   for workflow in ('builtin','legacy'):
    context=browser.new_context(viewport={'width':width,'height':900},reduced_motion='reduce');page=context.new_page()
    state={'releases':[],'defer':False,'error':False,'packageError':False,'deferData':False,'testOnly':False,'blocked':False};pending=[];pending_data=[];writes=[];external=[];errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    def releases():return [{'id':'saved-1','publisherId':'site-a','notes':'Synthetic saved package','version':'v1','status':status,'createdAt':'2026-10-01','publishedAt':None,'urls':{},'manifest':None} for status in state['releases']]
    def package():return {'site':{'id':'site-a','name':'site-a.example.com'},'runtime':{'runtimeVersion':'3.14.0'},'enablePrebid':False,'revision':'r1','channelRevision':'c1','ready':not state['blocked'],'error':'Synthetic pinned runtime unavailable' if state['blocked'] else None,'nextStep':None,'testOnly':state['testOnly'],'releases':releases(),'earlierReleases':[]}
    def route(r):
     path=urlparse(r.request.url).path
     if not r.request.url.startswith(origin+'/'):external.append(r.request.url);r.abort();return
     if r.request.method!='GET':writes.append({'method':r.request.method,'path':path});r.fulfill(status=405,json={'error':'Unexpected write'});return
     if path=='/api/publisher-accounts':r.fulfill(json={'publishers':accounts});return
     if path=='/api/organization':r.fulfill(json={'agencies':[],'memberships':[]});return
     if path.endswith('/script-library') or path.endswith('/ab-experiments'):r.fulfill(json={'supported':False});return
     if path.endswith('/deployment-targets'):r.fulfill(json={'ok':True,'targets':[],'deployments':[],'orchestrator':{'githubConfigured':False,'callbackConfigured':False,'repository':'','workflow':''}});return
     if path.endswith('/builtin-site-settings'):
      if state['defer']:pending.append(r);return
      r.fulfill(status=503 if state['error'] else 200,json={'error':'Synthetic settings failure'} if state['error'] else {'releaseWorkflow':workflow});return
     if state['deferData'] and (path.endswith('/builtin-releases') or path.endswith('/releases/validate')):pending_data.append(r);return
     if path.endswith('/builtin-releases'):r.fulfill(status=503 if state['packageError'] else 200,json={'error':'Synthetic package failure'} if state['packageError'] else package());return
     if path.endswith('/releases/validate'):r.fulfill(json={'ok':not state['blocked'],'errors':[{'code':'test','message':'Synthetic validation blocker','area':'config'}] if state['blocked'] else [],'warnings':[],'summary':{}});return
     if path.endswith('/releases'):r.fulfill(status=503 if state['packageError'] else 200,json={'error':'Synthetic release failure'} if state['packageError'] else {'ok':True,'releases':releases(),'channels':{'current':{},'staging':{}}});return
     r.continue_()
    page.route('**/*',route)
    def top(name):return page.get_by_role('button',name=name,exact=True)
    def focus_target(name):expect(page.locator(f'[data-release-target="{name}"]:not(:disabled)').first).to_be_focused()
    def open_site():page.goto(origin+'/?section=publishers&publisher=publisher-a&site=site-a&tab=overview');expect(page.locator('.workspace h1')).to_have_text('site-a.example.com')
    open_site();top('Generate').click();focus_target('generate')
    note=page.get_by_label('What changed?') if workflow=='builtin' else page.locator('textarea').first
    note.fill('Keep this entered release note')
    for name,target in [('Publish ↗','generate'),('Generate','generate'),('Generate','generate'),('Publish ↗','generate')]:
     top(name).click();focus_target(target);expect(note).to_have_value('Keep this entered release note')
    expect(page.get_by_role('status').filter(has_text='No package is ready')).to_be_visible()
    target=page.locator('[data-release-target="generate"]');assert target.evaluate('(n)=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}')
    page.screenshot(path=str(out/f'{workflow}-empty-{width}.png'),full_page=True)
    # Reload mocked data through existing read control, never stage/generate automatically.
    state['releases']=['draft']
    if workflow=='builtin':top('Reload releases').click()
    else:
     page.locator('.tabbar button').filter(has_text='Overview').click();top('Publish ↗').click()
    top('Publish ↗').click();focus_target('stage');expect(page.get_by_role('status').filter(has_text='No package is staged')).to_be_visible()
    page.screenshot(path=str(out/f'{workflow}-stage-{width}.png'),full_page=True)
    state['releases']=['staging']
    if workflow=='builtin':top('Reload releases').click()
    else:
     page.locator('.tabbar button').filter(has_text='Overview').click();top('Publish ↗').click()
    top('Publish ↗').click();focus_target('publish');top('Publish ↗').click();focus_target('publish')
    page.screenshot(path=str(out/f'{workflow}-publish-{width}.png'),full_page=True)
    # Read-only reload/validation is busy: the intent waits without activating anything.
    state['deferData']=True
    top('Reload releases' if workflow=='builtin' else 'Validate now').click()
    top('Generate').click();expect(page.locator('[aria-label="Release workflow"]')).to_be_focused()
    state['deferData']=False
    for r in pending_data:r.fulfill(json=package() if workflow=='builtin' else {'ok':True,'errors':[],'warnings':[],'summary':{}})
    pending_data.clear();focus_target('generate')
    if workflow=='builtin':
     state['blocked']=True;state['releases']=[];top('Reload releases').click();expect(page.locator('[data-release-target="blocked"]')).to_be_visible()
     top('Generate').click();focus_target('blocked');expect(page.get_by_role('status').filter(has_text='Resolve the release error')).to_be_visible()
     top('Publish ↗').click();focus_target('blocked')
     state['blocked']=False;state['testOnly']=True;top('Reload releases').click();top('Publish ↗').click();focus_target('generate')
     expect(page.get_by_role('status').filter(has_text='TEST deployments')).to_be_visible()
     state['releases']=['draft'];top('Reload releases').click();expect(page.locator('[data-release-target="preview"]')).to_be_visible();top('Publish ↗').click();focus_target('preview')
     expect(page.get_by_role('status').filter(has_text='Use TEST deployments')).to_be_visible()
     state['testOnly']=False;state['releases']=['staging']
    else:
     state['blocked']=True;top('Validate now').click();expect(page.locator('[data-release-target="setup"]')).to_be_visible();top('Generate').click();focus_target('setup')
     state['blocked']=False;top('Validate now').click();expect(page.locator('[data-release-target="generate"]')).to_be_enabled()
    state['releases']=['production'];open_site();top('Publish ↗').click();focus_target('generate')
    expect(page.get_by_role('status').filter(has_text='No package is ready')).to_be_visible()
    state['releases']=['staging']
    # Delayed workflow: shortcut intent waits, then resolves the correct action.
    open_site();state['defer']=True;top('Generate').click();expect(page.get_by_text('Loading release workflow…',exact=True)).to_be_visible()
    top('Publish ↗').click();expect(page.locator('[aria-label="Release workflow"]')).to_be_focused()
    state['defer']=False
    for r in pending:r.fulfill(json={'releaseWorkflow':workflow})
    pending.clear();focus_target('publish')
    # Workflow error/retry preserves pending Publish intent.
    open_site();state['error']=True;top('Publish ↗').click();expect(top('Retry releases')).to_be_focused()
    page.screenshot(path=str(out/f'{workflow}-error-{width}.png'),full_page=True)
    state['error']=False;top('Retry releases').click();focus_target('publish')
    # Load error/retry in the chosen workflow likewise resolves the intent.
    open_site();state['packageError']=True;top('Generate').click();expect(top('Retry releases')).to_be_focused()
    state['packageError']=False;top('Retry releases').click();focus_target('generate')
    # Leaving the same site's Releases tab cancels pending focus as well.
    open_site();state['defer']=True;top('Generate').click();expect(page.get_by_text('Loading release workflow…',exact=True)).to_be_visible()
    page.locator('.tabbar button').filter(has_text='Overview').click();state['defer']=False
    for r in pending:r.fulfill(json={'releaseWorkflow':workflow})
    pending.clear();expect(page.locator('.tabbar .active')).to_have_text('Overview')
    assert not page.locator('[aria-label="Release workflow"]').count()
    page.locator('.tabbar button').filter(has_text='Releases').click();expect(page.locator('[data-release-target="generate"]')).to_be_visible()
    assert page.evaluate('!document.activeElement?.hasAttribute("data-release-target")')
    # Leaving an unresolved intent must prevent late focus stealing on another site.
    open_site();state['defer']=True;top('Publish ↗').click();expect(page.get_by_text('Loading release workflow…',exact=True)).to_be_visible()
    menu=top('Menu')
    if menu.is_visible():menu.click()
    page.locator('.site-link').filter(has_text='site-b.example.com').click();expect(page.locator('.workspace h1')).to_have_text('site-b.example.com')
    state['defer']=False
    for r in pending:r.fulfill(json={'releaseWorkflow':workflow})
    pending.clear()
    page.locator('.tabbar button').filter(has_text='Releases').click();expect(page.locator('[data-release-target="generate"]')).to_be_visible()
    assert page.evaluate('!document.activeElement?.hasAttribute("data-release-target")')
    assert not page.get_by_role('status').filter(has_text='Review the staged package').count()
    # Browser history also clears a completed focus request instead of replaying it.
    top('Generate').click();focus_target('generate');page.locator('.tabbar button').filter(has_text='Overview').click();page.go_back()
    expect(page.locator('[data-release-target="generate"]')).to_be_visible();assert page.evaluate('!document.activeElement?.hasAttribute("data-release-target")')
    assert not writes,writes;assert not external,external;assert not errors,errors
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    results.append({'workflow':workflow,'width':width,'passed':True,'writes':writes,'externalRequests':external})
    context.close()
  browser.close()
finally:server.terminate();server.wait(timeout=10)
(out/'result.json').write_text(json.dumps(results,indent=2));print('PASS release shortcuts: builtin/legacy,1440/390,repeat/loading/retry/history/site; zero writes/live network')
