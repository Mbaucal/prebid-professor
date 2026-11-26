import os
"""Bid cache settings on a site that is not Tanjug: real React panels and the compiled Worker
with local D1, all external traffic blocked. Desktop and 390 px, save, 409/422 and recovery.
Then Releases → Generate on the MAIN fixture (scripts/main-revenue-browser-fixture.mjs
--bid-cache-blocked, full D1 schema): 3.21.2 selected with bid caching saved blocks Generate with
the reason and both ways out, and turning caching off or selecting either named version unblocks it."""
import argparse,base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parent.parent)
root=parser.parse_args().root.resolve()
out=Path(os.environ.get('BID_CACHE_UI_OUT') or root/'.generated/bid-cache-settings-ui');out.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(['node','scripts/bid-cache-settings-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert json.loads(process.stdout.readline())['ready']
SITE='/api/publishers/example'
errors=[];requests=[];checks=[];held=[];hold={'GET':False,'PUT':False}
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
 requests.append({'method':payload['method'],'path':url.path,'status':result['status']})
 r.fulfill(status=result['status'],headers=result['headers'],body=body)
def route(r):
 if urlsplit(r.request.url).path==SITE+'/prebid-mode' and hold.get(r.request.method):
  hold[r.request.method]=False;held.append(r);return
 forward(r)
def release():forward(held.pop())
def no_scroll(page):return page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
def card(page,code):return page.locator('.ad-unit-card').filter(has=page.locator('code',has_text=code))
# The versions the panels and Generate name for bid caching, read from the release registry by the shared rule
# (worker/site-runtime/script-versions.mjs): the smallest step and the newest without a runtime notice, one or two.
def registry_labels(*capabilities):
 code="const {scriptVersionLabels}=await import('./worker/site-runtime/script-versions.mjs');console.log(JSON.stringify(scriptVersionLabels(JSON.parse(process.argv[1]))))"
 return json.loads(subprocess.run(['node','--input-type=module','-e',code,json.dumps(capabilities)],cwd=root,check=True,capture_output=True,text=True).stdout)
CACHE_SCRIPTS=registry_labels('bid-cache');assert len(CACHE_SCRIPTS)<=2,CACHE_SCRIPTS
CACHE_SCRIPT=' or '.join(CACHE_SCRIPTS)
# Whether a release with a runtime notice applies bid caching: never named, but still selectable in Script setup.
def registry_noticed(*capabilities):
 code="const {noticedScriptVersionApplies}=await import('./worker/site-runtime/script-versions.mjs');console.log(JSON.stringify(noticedScriptVersionApplies(JSON.parse(process.argv[1]))))"
 return json.loads(subprocess.run(['node','--input-type=module','-e',code,json.dumps(capabilities)],cwd=root,check=True,capture_output=True,text=True).stdout)
CACHE_NOTICED=registry_noticed('bid-cache')
NO_CACHE_VERSION=('No corrected script version is offered that applies bid caching. Versions with a runtime notice in Script setup still apply it.'
 if CACHE_NOTICED else 'No available script version applies bid caching.')
NO_CACHE_SCRIPT='No corrected compatible bid-cache script is available in this workspace. Your saved settings are kept.'
SELECT_TEXT=f'Select script {CACHE_SCRIPT} in Script setup to apply bid caching. Your setting is saved.' if CACHE_SCRIPTS else NO_CACHE_SCRIPT
# Saved settings would cache, but the form has unsaved changes: nothing claims it is saved.
SELECT_DIRTY_TEXT=f'Select script {CACHE_SCRIPT} in Script setup to apply bid caching.' if CACHE_SCRIPTS else NO_CACHE_SCRIPT
# Nothing saved would cache yet.
NEEDS_TEXT=f'Bid caching needs script {CACHE_SCRIPT}.' if CACHE_SCRIPTS else NO_CACHE_SCRIPT
POSITION_TEXT=f'Applies to the next package generated with script {CACHE_SCRIPT}. Select {"one of these versions" if len(CACHE_SCRIPTS)>1 else "that version"} in Script setup to use it.' if CACHE_SCRIPTS else NO_CACHE_SCRIPT
POSITION_SAVED='Saved. Select a compatible script in Script setup to apply it.' if CACHE_SCRIPTS else 'Saved. No corrected compatible bid-cache script is available in this workspace. Your setting is kept.'
GENERATOR_TEXT=(f'Bid caching needs a compatible script version. Select {CACHE_SCRIPT} in Script setup and save; your bid cache settings are kept. '
 + ('Both versions combine' if len(CACHE_SCRIPTS)>1 else 'This version combines')+' bid caching with bidder accounts, bidder rules and the current native activity and floor checks. '
 'To keep this script version instead, turn bid caching off in Config → Demand → Prebid, remove unused overrides there, and set positions that are On to Use site setting under Config → Ad units → Bid cache.') if CACHE_SCRIPTS else (f'Bid caching needs a compatible script version. {NO_CACHE_VERSION} Your bid cache settings are kept. '
 'To use this script version, turn bid caching off in Config → Demand → Prebid, remove unused overrides there, and set positions that are On to Use site setting under Config → Ad units → Bid cache.')
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'));page=browser.new_page(viewport={'width':1280,'height':1000})
  page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('https://tessera.fixture.invalid/');page.get_by_role('button',name='Demand → Prebid',exact=True).wait_for()
  # Loading state of Demand → Prebid.
  hold['GET']=True;page.get_by_role('button',name='Demand → Prebid',exact=True).click()
  page.get_by_text('Loading Prebid settings…',exact=True).wait_for()
  check('Demand shows its loading state',len(held)==1);release()
  cache=page.get_by_role('checkbox',name='Reuse valid, unused bids',exact=True);cache.wait_for()
  fieldset=page.locator('fieldset.prebid-cache-settings')
  check('The cache checkbox is available on a site that is not Tanjug',cache.is_enabled() and not cache.is_checked())
  check('3.21.2 is selected and nothing saved would cache: the panel names the version, not a saved setting',fieldset.get_by_text(NEEDS_TEXT,exact=True).is_visible())
  text=fieldset.inner_text()
  check('No Tanjug-only or generator-refusal sentence remains',all(s not in text for s in ['Tanjug','This generator does not apply','named script','Scripts and A/B tests']))
  cache.check();page.get_by_label('Maximum bid age (seconds)',exact=True).fill('45')
  check('An unsaved change is never called saved',fieldset.get_by_text(NEEDS_TEXT,exact=True).is_visible() and 'Your setting is saved' not in fieldset.inner_text())
  hold['PUT']=True;page.get_by_role('button',name='Save Prebid settings',exact=True).click()
  page.get_by_role('button',name='Saving…',exact=True).wait_for()
  check('Saving disables the cache controls',cache.is_disabled() and page.get_by_label('Maximum bid age (seconds)',exact=True).is_disabled() and page.get_by_role('button',name='Saving…',exact=True).is_disabled())
  release();page.get_by_text('Prebid settings saved. Select a compatible script in Script setup before you generate; your bid cache settings are kept.',exact=False).wait_for()
  status,saved=api('GET','/prebid-mode')
  check('The site default is saved in D1',status==200 and saved['prebidMode']['bidCache']=={'enabled':True,'maxBidAgeSeconds':45})
  check(f'Saved, on 3.21.2: the panel asks for {CACHE_SCRIPT} and says the setting is saved',fieldset.get_by_text(SELECT_TEXT,exact=True).is_visible())
  page.screenshot(path=str(out/'demand-saved-desktop.png'),full_page=True)
  # 409: another tab saves first; this form must reload before saving.
  status,_=api('PUT','/prebid-mode',{'enabled':True,'revision':saved['revision'],'bidCache':{'enabled':True,'maxBidAgeSeconds':90}})
  assert status==200
  page.get_by_label('Maximum bid age (seconds)',exact=True).fill('50')
  check(f'A saved setting with unsaved changes asks for {CACHE_SCRIPT} without calling the form saved',fieldset.get_by_text(SELECT_DIRTY_TEXT,exact=True).is_visible())
  page.get_by_role('button',name='Save Prebid settings',exact=True).click()
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
  check('The dialog names only an offered version, or explicitly reports that no corrected cache version is available',dialog.get_by_text(POSITION_TEXT,exact=True).is_visible())
  dialog.get_by_label('Bid cache for In_Article',exact=True).select_option('off')
  dialog.get_by_role('button',name='Save position setting').click();dialog.get_by_role('status').filter(has_text=POSITION_SAVED).wait_for()
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
  # The saved selection becomes the registered 3.23.0, the first runtime with the bid-cache capability. This
  # fixture's inventory is not a Script setup review state, so the pin is written to D1 from the registry record;
  # the Worker still has to match it against its runtime catalog.
  release=next(r for r in json.loads((root/'worker/runtime/runtime-releases.json').read_text()) if r['id']=='tessera-3.23.0')
  pin={'schemaVersion':1,'runtimeId':release['id'],'runtimeVersion':release['version'],'runtimeSha256':release['codeSha256'],'configSchemaVersion':release['configSchemaVersion'],'capabilities':sorted(release['capabilities'])}
  sql("UPDATE publisher_configs SET config_json=json_set(config_json,'$.builtinRuntimeSelection.runtime',json(?)) WHERE publisher_id='example'",json.dumps(pin))
  status,mode=api('GET','/prebid-mode')
  check('With 3.23.0 saved, the API reports that it applies bid caching','bid-cache' in pin['capabilities'] and status==200 and mode['runtimeSupportsBidCache'] is True and mode['selectedRuntime']=={'id':'tessera-3.23.0','version':'3.23.0'})
  page.get_by_role('button',name='Ad positions',exact=True).click();page.get_by_role('button',name='Demand → Prebid',exact=True).click()
  page.get_by_text('Applies to new packages generated with the selected script.' if CACHE_SCRIPTS else NO_CACHE_SCRIPT,exact=True).wait_for()
  check('A capable runtime stays supported without inventing an unoffered upgrade',page.get_by_text(SELECT_TEXT,exact=True).count()==(0 if CACHE_SCRIPTS else 1))
  page.screenshot(path=str(out/'demand-capable-desktop.png'),full_page=True)
  page.get_by_role('button',name='Ad positions',exact=True).click();card(page,'Footer').get_by_role('button',name='Bid cache: On',exact=True).click()
  dialog=page.get_by_role('dialog',name='Bid cache · Footer',exact=True)
  dialog.get_by_text('Applies to the next package generated with the selected script.' if CACHE_SCRIPTS else NO_CACHE_SCRIPT,exact=True).wait_for()
  dialog.get_by_label('Bid cache for Footer',exact=True).select_option('off');dialog.get_by_role('button',name='Save position setting').click()
  dialog.get_by_role('status').filter(has_text='Saved. Generate a new package to apply this setting.').wait_for()
  page.set_viewport_size({'width':390,'height':844})
  check('The capable dialog fits 390 px',dialog.bounding_box()['width']<=390 and no_scroll(page))
  page.screenshot(path=str(out/'position-capable-390.png'))
  check('No unhandled UI error',not errors)
  browser.close()
finally:
 process.stdin.close();process.wait(timeout=10)
# Generate on a site with 3.21.2 selected and bid caching saved on. This needs the full D1 schema of the
# MAIN fixture: Generate is blocked, the page says why and names both ways out, and each way out unblocks it.
fixture=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/main-revenue-browser-fixture.mjs','--bid-cache-blocked'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
MAIN='/api/publishers/main-site'
def send(path,method='GET',body=None):
 fixture.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');fixture.stdin.flush()
 result=json.loads(fixture.stdout.readline());assert 'error' not in result,result
 return result
def main_api(method,path,body=None):
 result=send(MAIN+path,method,json.dumps(body) if body is not None else None)
 return result['status'],json.loads(base64.b64decode(result['body']))
def main_route(r):
 url=urlsplit(r.request.url);assert url.netloc=='main-revenue.fixture.invalid'
 result=send(url.path+('?'+url.query if url.query else ''),r.request.method,r.request.post_data)
 requests.append({'method':r.request.method,'path':url.path,'status':result['status']})
 r.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
def open_generate(browser,width,height):
 page=browser.new_page(viewport={'width':width,'height':height});page.route('**/*',main_route);page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('https://main-revenue.fixture.invalid/');page.get_by_role('button',name='Generate and releases',exact=True).click()
 panel=page.locator('section[aria-label="Saved packages"]');panel.get_by_role('heading',name='2. Generate your script',exact=True).wait_for()
 return page,panel
try:
 ready=json.loads(fixture.stdout.readline());assert ready['ready'] and ready['bidCacheBlocked'] and ready['runtimeVersion']=='3.21.2'
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'))
  for width,height,name in [(1280,1000,'desktop'),(390,844,'390')]:
   page,panel=open_generate(browser,width,height)
   alert=panel.get_by_role('alert').filter(has_text='Bid caching needs a compatible script version');alert.wait_for()
   status,state=main_api('GET','/builtin-releases')
   check(f'Generate blocked by bid caching shows the reason and both ways out ({name})',alert.inner_text()==GENERATOR_TEXT and status==200
    and main_api('GET','/prebid-mode')[1]['bidCacheScriptVersions']==CACHE_SCRIPTS
    and state['ready'] is False and state['nextStep']=='demand' and state['error']==GENERATOR_TEXT
    and panel.get_by_role('button',name='Generate and save package',exact=True).is_disabled())
   check(f'Script setup stays available next to the reason ({name})',panel.get_by_text('Script setup',exact=False).count()>0)
   check(f'The blocked Generate page fits {name}',no_scroll(page))
   page.screenshot(path=str(out/f'generate-blocked-{name}.png'),full_page=True);page.close()
  # Way out 1: turn bid caching off in Demand → Prebid. The 3.21.2 selection is kept.
  status,mode=main_api('GET','/prebid-mode');assert status==200
  status,_=main_api('PUT','/prebid-mode',{'enabled':True,'revision':mode['revision'],'bidCache':{'enabled':False,'maxBidAgeSeconds':60}});assert status==200
  page,panel=open_generate(browser,1280,1000)
  status,state=main_api('GET','/builtin-releases')
  check('With bid caching off, 3.21.2 generates again',status==200 and state['ready'] is True and state['runtime']['runtimeVersion']=='3.21.2'
   and panel.get_by_text('Bid caching needs a compatible script version',exact=False).count()==0 and panel.get_by_role('button',name='Generate and save package',exact=True).is_enabled())
  page.close()
  # Way out 2: bid caching on again, and a version the message names selected in Script setup (each of them).
  status,mode=main_api('GET','/prebid-mode')
  status,_=main_api('PUT','/prebid-mode',{'enabled':True,'revision':mode['revision'],'bidCache':{'enabled':True,'maxBidAgeSeconds':60}});assert status==200
  assert main_api('GET','/builtin-releases')[1]['nextStep']=='demand'
  selected_versions=[label.replace(' (Preview)','') for label in CACHE_SCRIPTS] if CACHE_SCRIPTS else ['3.23.0','3.24.0']
  for version in selected_versions:
   label=version+' (explicit earlier cache choice)' if not CACHE_SCRIPTS else next(label for label in CACHE_SCRIPTS if label.replace(' (Preview)','')==version)
   status,selection=main_api('GET','/builtin-site-settings')
   pin=next(r['pin'] for r in selection['runtimes'] if r['version']==version)
   status,_=main_api('POST','/builtin-site-settings',{'action':'version','revision':selection['revision'],'runtime':pin,'allowPreview':True});assert status==200,_
   page,panel=open_generate(browser,1280,1000)
   status,state=main_api('GET','/builtin-releases')
   check(f'With {label} explicitly selected, Generate shows no bid cache block',status==200 and state['ready'] is True and state['runtime']['runtimeVersion']==version
    and panel.get_by_text('Bid caching needs a compatible script version',exact=False).count()==0 and panel.get_by_role('button',name='Generate and save package',exact=True).is_enabled())
   if not CACHE_SCRIPTS:
    panel.get_by_role('button',name='Change script setup',exact=True).click()
    panel.get_by_role('combobox',name='Script version',exact=True).wait_for()
    check(f'{version} remains selectable and carries the no-corrected-TEST-version warning',panel.get_by_role('note').filter(has_text='A corrected compatible bid-cache version is not available in this TEST workspace.').count()==1)
   page.screenshot(path=str(out/f'generate-capable-{version}-desktop.png'),full_page=True);page.close()
  check('No unhandled UI error on Generate',not errors)
  browser.close()
finally:
 fixture.stdin.close();fixture.wait(timeout=10)
(out/'report.json').write_text(json.dumps({'scope':'Compiled Worker, local D1, synthetic example.invalid site; 3.21.2 selected, then the registered 3.23.0 pin saved in D1','checks':checks,'passed':len(checks),'failed':0,'errors':errors,'requests':requests},indent=2))
print(json.dumps({'passed':len(checks),'failed':0}))
