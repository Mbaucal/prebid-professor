"""TEST site workspace → Bid caching with the real TEST Worker and SQLite, all external traffic blocked.
Prebid is on through the TEST Prebid editor and 3.21.2 is selected. Check the named-script and bidder
rules wording, open Bid caching from the TEST home page, save bid caching and a position override, see
Generate blocked with the reason above Script setup and on the home page Generate, select 3.23.0 and
download the generated package with the saved settings. Desktop and 390 px."""
import base64,json,os,subprocess,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=Path(os.environ.get('TEST_BID_CACHE_UI_OUT') or root/'.generated/test-bid-cache-ui');out.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/site-workspace-browser-fixture.mjs','--http','--bid-cache'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
fixture=json.loads(process.stdout.readline());assert fixture['ready']
origin=fixture['origin'];assert urlsplit(origin).hostname=='127.0.0.1'
errors=[];requests=[];checks=[]
LOCK='Turn Prebid on or off in Prebid and bidders. Here you can change bid caching only.'
RULES_NOTE='You can save rules now. Select and save script version {} before generating a package that uses them.'
NEEDS='Bid caching needs script 3.23.0 or later.'
BLOCKED=('Bid caching needs a compatible script version. Select 3.24.0 (Preview) in Script setup and save; your bid cache settings are kept. '
 'This version combines bid caching with bidder accounts, bidder rules and the current native activity and floor checks. '
 'To keep this script version instead, open Bid caching, turn off Reuse valid, unused bids, remove unused overrides there, and set positions that are On to Use site setting under Bid cache by position.')
def check(name,ok):
 assert ok,name
 checks.append(name)
def send(payload):
 process.stdin.write(json.dumps(payload)+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result
 return result
def api(path,body=None):
 result=send({'path':path,'method':'GET' if body is None else 'POST','body':None if body is None else json.dumps(body)})
 return result['status'],json.loads(base64.b64decode(result['body']))
def route(r):
 url=urlsplit(r.request.url);assert url.netloc==urlsplit(origin).netloc,'Unexpected external request'
 result=send({'path':url.path+('?'+url.query if url.query else ''),'method':r.request.method,'body':r.request.post_data})
 requests.append({'path':url.path,'method':r.request.method,'status':result['status']})
 r.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
def no_scroll(page):return page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
def shots(page,name):
 for width,height in [(1280,900),(390,844)]:
  page.set_viewport_size({'width':width,'height':height})
  check(f'{name} fits {width} px',no_scroll(page))
  page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
 page.set_viewport_size({'width':1280,'height':900})
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'));page=browser.new_page(viewport={'width':1280,'height':900})
  page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
  # The named-script page does not present the Tanjug copy as the place for bid caching.
  page.goto(origin+'/named-scripts')
  page.get_by_text('A separate Tanjug test copy for named scripts. Bid caching for your TEST site is in Site workspace → Bid caching. Your existing TEST site stays unchanged. No ads run here.',exact=True).wait_for()
  check('Named script test does not tie bid caching to the Tanjug copy','bid-cache settings' not in page.locator('body').inner_text())
  # Bidder rules name the versions the server derives for them with the saved options: 3.23.0 is later but has none.
  page.goto(origin+'/site-workspace#bidder-rules')
  note=page.get_by_text(RULES_NOTE.format('3.22.2 (Preview) or 3.24.0 (Preview)'),exact=True);note.wait_for()
  check('Bidder rules name 3.22.2 (Preview) or 3.24.0 (Preview), not a fixed version or "or later"','or later' not in page.locator('main').inner_text())
  # The TEST home page opens the TEST site's own Bid caching view.
  page.goto(origin+'/')
  link=page.get_by_role('link',name='Bid caching',exact=True);link.wait_for()
  check('The TEST home page links Bid caching next to Prebid and bidders',link.get_attribute('href')=='/site-workspace#bid-cache')
  link.click()
  cache=page.get_by_role('checkbox',name='Reuse valid, unused bids',exact=True);cache.wait_for()
  page.get_by_role('button',name='Billboard · Bid cache: Off',exact=True).wait_for()
  check('Prebid on/off is read-only here and the page says where to change it',page.get_by_text(LOCK,exact=True).is_visible()
   and all(radio.is_disabled() for radio in page.get_by_role('radio').all()) and page.get_by_role('radio').count()==2)
  check('3.21.2 is selected and nothing is saved: the panel names the version',page.get_by_text(NEEDS,exact=True).is_visible())
  text=page.locator('main').inner_text() if page.locator('main').count() else page.locator('body').inner_text()
  check('No Tanjug-only or production-menu wording',all(s not in text for s in ['Tanjug','This generator does not apply','Config →','Releases →','Ad units → Bid cache']))
  check('Each eligible TEST position has a Bid cache control',page.get_by_role('button',name='Sticky · Bid cache: Off',exact=True).is_visible())
  shots(page,'bid-cache-initial')
  cache.check();page.get_by_label('Maximum bid age (seconds)',exact=True).fill('45')
  page.get_by_role('button',name='Save Prebid settings',exact=True).click()
  page.get_by_text('Prebid settings saved.',exact=False).wait_for()
  page.get_by_role('button',name='Billboard · Bid cache: On',exact=True).wait_for()
  status,mode=api('/api/publishers/test-site/prebid-mode')
  check('The site default is saved for the TEST site',status==200 and mode['prebidMode']['bidCache']=={'enabled':True,'maxBidAgeSeconds':45} and mode['prebidMode']['enabled'] is True)
  page.get_by_role('button',name='Sticky · Bid cache: On',exact=True).click()
  dialog=page.get_by_role('dialog',name='Bid cache · Sticky',exact=True);dialog.get_by_label('Bid cache for Sticky',exact=True).wait_for()
  check('The position dialog asks for a compatible script without production menus',dialog.get_by_text('Applies to the next package generated with script 3.23.0 or later. Select a compatible script in Script setup to use it.',exact=True).is_visible())
  dialog.get_by_label('Bid cache for Sticky',exact=True).select_option('off')
  dialog.get_by_role('button',name='Save position setting').click()
  dialog.get_by_role('status').filter(has_text='Saved. Select a compatible script in Script setup to apply it.').wait_for()
  page.set_viewport_size({'width':390,'height':844})
  check('The position dialog fits 390 px',dialog.bounding_box()['width']<=390 and no_scroll(page))
  page.screenshot(path=str(out/'bid-cache-position-390.png'))
  page.set_viewport_size({'width':1280,'height':900})
  page.screenshot(path=str(out/'bid-cache-position-1280.png'))
  page.get_by_role('button',name='Close bid cache settings').click();dialog.wait_for(state='detached')
  page.get_by_role('button',name='Sticky · Bid cache: Off',exact=True).wait_for()
  page.get_by_text('Change these under Bid cache by position below.',exact=False).wait_for()
  check('The override is saved and listed with this page as the place to change it',api('/api/publishers/test-site/prebid-mode')[1]['prebidMode']['bidCache'].get('positionOverrides')=={'Sticky':False})
  shots(page,'bid-cache-saved')
  # With bid caching saved, Bidder rules name only the script that applies both.
  page.goto(origin+'/site-workspace#bidder-rules')
  page.get_by_text(RULES_NOTE.format('3.24.0 (Preview)'),exact=True).wait_for()
  check('With bid caching saved, Bidder rules name only 3.24.0 (Preview)','3.22.2' not in page.locator('main').inner_text())
  shots(page,'bidder-rules-bid-cache-saved')
  # Generate with 3.21.2: blocked, with the reason shown above Script setup.
  page.get_by_role('button',name='Generate and releases',exact=True).click()
  alert=page.get_by_role('alert').filter(has_text='Bid caching needs a compatible script version.');alert.wait_for()
  setup=page.get_by_role('heading',name='Script setup',exact=True).first
  check('Generate is blocked with the TEST reason above Script setup',alert.inner_text()==BLOCKED
   and page.get_by_role('button',name='Generate and save package',exact=True).count() in (0,1)
   and (page.get_by_role('button',name='Generate and save package',exact=True).count()==0 or page.get_by_role('button',name='Generate and save package',exact=True).is_disabled())
   and alert.bounding_box()['y']<setup.bounding_box()['y'])
  shots(page,'generate-blocked')
  # The older Generate on the TEST home page shows the same reason up front and is disabled; its API refuses
  # with that reason (409), not with a storage error.
  page.goto(origin+'/')
  page.locator('#message.error').filter(has_text=BLOCKED).wait_for()
  status,refused=api('/test-api/generate',{'acknowledge':True})
  check('The TEST home page Generate gives the bid cache reason, not a storage error',page.locator('#message').inner_text()==BLOCKED
   and page.get_by_role('button',name='Generate test package',exact=True).is_disabled() and page.locator('#review').is_hidden()
   and status==409 and refused=={'error':BLOCKED})
  shots(page,'home-generate-blocked')
  page.goto(origin+'/site-workspace#packages')
  page.get_by_role('alert').filter(has_text='Bid caching needs a compatible script version.').wait_for()
  # Select 3.23.0 the way Script setup saves it, then generate and download.
  status,state=api('/test-api/runtime-selection')
  pin=next(r['pin'] for r in state['runtimes'] if r['version']=='3.23.0')
  status,_=api('/test-api/runtime-selection',{'expectedRevision':state['revision'],'selection':{'runtime':pin,'allowPreview':True,'enablePrebid':True,'prebidBuildId':state['prebidBuildId']}});assert status==200,_
  page.reload();page.get_by_label('What changed?',exact=True).fill('Bid cache TEST package')
  check('With 3.23.0 selected the reason is gone',page.get_by_text('Bid caching needs a compatible script version',exact=False).count()==0)
  page.get_by_role('button',name='Generate and save package',exact=True).click()
  page.get_by_role('status').filter(has_text='Package saved in Releases').wait_for()
  shots(page,'generate-saved')
  with page.expect_download() as download:
   page.get_by_role('button',name='Download saved ZIP',exact=True).first.click()
  with zipfile.ZipFile(download.value.path()) as archive:
   config=json.loads(archive.read('config.json'));manifest=json.loads(archive.read('manifest.json'))
   check('The downloaded 3.23.0 package carries the saved bid caching',manifest['runtime']['runtimeVersion']=='3.23.0'
    and config['bidCache']=={'defaultEnabled':True,'maxAgeSeconds':45,'positions':{'Billboard':True,'Sticky':False}}
    and b'createTesseraBidCache' in archive.read('ads.min.js'))
  check('No unhandled UI error',not errors)
  browser.close()
finally:
 process.stdin.close();process.wait(timeout=10)
(out/'report.json').write_text(json.dumps({'scope':'TEST Worker from source, local SQLite and memory R2, TEST site with Prebid on through the TEST editor','checks':checks,'passed':len(checks),'failed':0,'errors':errors,'requests':requests},indent=2))
print(json.dumps({'passed':len(checks),'failed':0}))
