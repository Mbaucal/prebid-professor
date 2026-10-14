"""Actual React dialogs; all writes are held synthetic API responses, never live."""
import json, subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/app-dialog-evidence';out.mkdir(parents=True,exist_ok=True)
origin='http://127.0.0.1:4182'
def site(id):
 return dict(id=id,publisherAccountId='publisher-a',name=id+'.example.com',domain=id+'.example.com',gamPath='/123/test/',status='draft',currentVersion='draft',adsTxtUrl='',updatedAt='2026-10-01',lastPublishedAt=None,adUnitsCount=0,biddersCount=0)
accounts=[dict(id='publisher-a',name='Fixture Publisher',status='active',sitesCount=2,sites=[site('site-a'),site('site-b')],notes='')]
server=subprocess.Popen(['node','scripts/layout-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
results=[]
try:
 assert 'ready' in server.stdout.readline()
 with sync_playwright() as p:
  browser=p.chromium.launch()
  for width in [1440,390]:
   page=browser.new_page(viewport={'width':width,'height':900});pending=[];errors=[];external=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   def route(r):
    path=urlparse(r.request.url).path
    if not r.request.url.startswith(origin+'/'):external.append(r.request.url);r.abort();return
    if r.request.method!='GET':pending.append(r);return
    if path=='/api/publisher-accounts':r.fulfill(json={'publishers':accounts});return
    if path=='/api/organization':r.fulfill(json={'agencies':[],'memberships':[]});return
    r.continue_()
   page.route('**/*',route)
   def record(name):
    assert not errors,errors
    assert not external,external
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    results.append(dict(case=name,width=width,passed=True))
   def start():
    page.goto(origin+'/?section=publishers&publisher=publisher-a&site=site-a&tab=overview')
    expect(page.locator('.workspace h1')).to_have_text('site-a.example.com')
   def open_mode(mode):
    if mode=='publisher':
     menu=page.get_by_role('button',name='Menu',exact=True)
     if menu.is_visible():menu.click()
     opener=page.get_by_role('button',name='＋ New publisher',exact=True)
    else:opener=page.locator('.top-actions').get_by_role('button',name={'create':'＋ Site','edit':'Edit site','duplicate':'Duplicate site'}[mode],exact=True)
    opener.click();dialog=page.get_by_role('dialog');expect(dialog).to_be_visible()
    expect(dialog).to_have_attribute('aria-modal','true')
    expect(dialog).to_have_accessible_name({'publisher':'Create publisher','create':'Create site','edit':'Edit site-a.example.com','duplicate':'Duplicate site-a.example.com'}[mode])
    expect(dialog.get_by_label('Publisher name' if mode=='publisher' else 'Site name',exact=True)).to_be_focused()
    return opener,dialog
   for mode in ['publisher','create','edit','duplicate']:
    start();opener,d=open_mode(mode)
    d.get_by_role('button',name='Close dialog').focus();page.keyboard.press('Shift+Tab');expect(d.locator('button[type=submit]')).to_be_focused()
    page.keyboard.press('Tab');expect(d.get_by_role('button',name='Close dialog')).to_be_focused()
    field=d.get_by_label('Publisher name' if mode=='publisher' else 'Site name',exact=True);field.fill('Unsaved name');field.click();expect(d).to_be_visible();expect(field).to_have_value('Unsaved name')
    page.screenshot(path=str(out/f'{mode}-{width}.png'))
    page.keyboard.press('Escape');expect(d).to_have_count(0);expect(opener).to_be_focused();record(mode+'-keyboard-escape-return')
    for method in ['Cancel','Close dialog','backdrop']:
     opener,d=open_mode(mode)
     if method=='backdrop':d.click(position={'x':2,'y':2})
     else:d.get_by_role('button',name=method,exact=True).click()
     expect(d).to_have_count(0);expect(opener).to_be_focused()
    record(mode+'-dismiss-parity')
   for mode in ['publisher','create']:
    start();opener,d=open_mode(mode)
    d.get_by_label('Publisher name' if mode=='publisher' else 'Site name',exact=True).fill('New fixture')
    if mode=='create':
     d.get_by_label('Domain',exact=True).fill('fixture.invalid');d.get_by_label('GAM path',exact=True).fill('/123/fixture/')
    d.locator('button[type=submit]').click();expect(d.get_by_role('button',name='Saving…')).to_be_disabled()
    page.keyboard.press('Escape');expect(d).to_be_visible()
    pending.pop().fulfill(status=503,json={'error':'Synthetic create unavailable'})
    expect(d.get_by_role('alert')).to_contain_text('Synthetic create unavailable')
    expect(d.get_by_label('Publisher name' if mode=='publisher' else 'Site name',exact=True)).to_have_value('New fixture')
    d.get_by_role('button',name='Cancel',exact=True).click();expect(opener).to_be_focused();record(mode+'-held-error')
   start();opener,d=open_mode('edit');d.get_by_label('Site name',exact=True).fill('Retained value')
   d.get_by_role('button',name='Save site').click();expect(d.get_by_role('button',name='Saving…')).to_be_disabled()
   assert len(pending)==1
   page.keyboard.press('Escape');expect(d).to_be_visible()
   expect(d.get_by_role('button',name='Close dialog')).to_be_disabled();expect(d.get_by_role('button',name='Cancel')).to_be_disabled()
   d.click(position={'x':2,'y':2});expect(d).to_be_visible();record('held-save-lock')
   pending.pop().fulfill(status=503,json={'error':'Synthetic save unavailable'})
   expect(d.get_by_role('alert')).to_contain_text('Synthetic save unavailable');expect(d.get_by_label('Site name',exact=True)).to_have_value('Retained value')
   expect(d.get_by_role('button',name='Save site')).to_be_enabled();page.screenshot(path=str(out/f'error-{width}.png'));record('error-retains-values')
   d.get_by_role('button',name='Save site').click();expect(d.get_by_role('button',name='Saving…')).to_be_visible()
   pending.pop().fulfill(json={'site':site('site-a')});expect(d).to_have_count(0);expect(opener).to_be_focused();record('success-return')
   # Real popstate route change while an old request is held; a new dialog owns all state.
   for outcome in ['error','success']:
    start();page.evaluate("history.pushState(null,'','?section=publishers&publisher=publisher-a&site=site-b&tab=overview'); dispatchEvent(new PopStateEvent('popstate'))")
    expect(page.locator('.workspace h1')).to_have_text('site-b.example.com')
    page.go_back();expect(page.locator('.workspace h1')).to_have_text('site-a.example.com')
    opener,d=open_mode('edit');d.get_by_role('button',name='Save site').click();expect(d.get_by_role('button',name='Saving…')).to_be_visible();old=pending.pop()
    opener.evaluate("element => { window.staleOpenerFocus=0; element.addEventListener('focus', () => window.staleOpenerFocus++); }")
    page.go_forward();expect(page.locator('.workspace h1')).to_have_text('site-b.example.com');expect(page.get_by_role('dialog')).to_have_count(0)
    assert page.evaluate('window.staleOpenerFocus')==0
    b=page.locator('.top-actions').get_by_role('button',name='Edit site',exact=True);b.click();d=page.get_by_role('dialog');field=d.get_by_label('Site name',exact=True);field.fill('New session')
    with page.expect_response(lambda response: response.request.method=='PATCH' and response.url.endswith('/api/sites/site-a')) as completed:
     if outcome=='error':old.fulfill(status=503,json={'error':'Stale error'})
     else:old.fulfill(json={'site':site('site-a')})
    completed.value.body()
    page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    expect(d).to_be_visible();expect(field).to_have_value('New session');expect(field).to_be_focused();expect(d.get_by_role('alert')).to_have_count(0)
    expect(page.locator('.workspace h1')).to_have_text('site-b.example.com');record('late-'+outcome+'-session-ownership')
   page.close()
  browser.close()
 (out/'results.json').write_text(json.dumps(results,indent=2));print(f'{len(results)} dialog checks passed')
finally:server.terminate();server.wait(timeout=10)
