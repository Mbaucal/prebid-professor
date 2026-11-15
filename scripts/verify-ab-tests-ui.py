"""A/B tests panel (src/components/AbTestsPanel.tsx) in the site workspace, on desktop (1280x900) and narrow (390x844)
screens, against a local fixture: the real TEST Worker, SQLite and memory R2, with every browser request routed into the
fixture and every other host refused. The fixture seeds three saved versions on 3.23.0: GAM only with a 160-character
version name, Version A (Prebid, bid cache off) and Version B (bid cache on).

Flow: the #ab-tests link opens Generate and releases with the panel in view; the no-production note and the proposed
TestId; GAM only vs A refused; A vs B compatible with bidCache.enabled in the summary; save, save again (already saved),
the same TestId with another name (409, entered values kept); an A/A test with one r/ file; ZIP and record downloads
checked against their sha256; Mark live and Mark stopped; Delete and Restore; Delete all generated packages, after which
the tests stay listed and downloadable. After every state the page has no horizontal scroll at either width.

--fixture is the fixture command (a node script printing {"ready":true,"origin":...} and answering one JSON request per
line), --page the workspace path with #ab-tests, and --endpoint the A/B tests API path. The defaults are the TEST line."""
import argparse,base64,hashlib,io,json,os,shlex,subprocess,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--fixture',default='node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs '
 'scripts/site-workspace-browser-fixture.mjs --http --ab-tests --cleanup')
parser.add_argument('--page',default='/site-workspace#ab-tests')
parser.add_argument('--endpoint',default='/test-api/ab-tests')
args=parser.parse_args()
out=Path(os.environ.get('AB_TESTS_UI_OUT') or root/'.generated/ab-tests-ui');out.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(shlex.split(args.fixture),cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
fixture=json.loads(process.stdout.readline());assert fixture['ready']
origin=fixture['origin'];assert urlsplit(origin).hostname=='127.0.0.1'
errors=[];requests=[];external=[];dialogs=[];checks=[];shots_taken=[]
# hold: the next list request waits in pending, so the loading line and a failed load can be checked.
mode={'hold':False,'fail':None};pending=[]
NO_PRODUCTION='This site has no production version on TEST. Choose A yourself: use the version your test page runs now.'
PUBLIC='The test name, the TestId and both version names are published inside /ads.js. Do not use private notes.'
UPLOAD='Download the ZIP and upload all of its files, unchanged, as one Pages deployment.'
KEPT='(no longer in Saved versions; this test keeps its own copy)'
COMPATIBLE='Compatible. These versions can be compared.'
LIST_HELP='For lists, each side shows only what it has and the other version does not.'
sha=lambda data:hashlib.sha256(data).hexdigest()

def check(name,ok):
 assert ok,name
 checks.append(name)
def send(payload):
 process.stdin.write(json.dumps(payload)+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result
 return result
def api(path,body=None,method=None):
 result=send({'path':path,'method':method or ('GET' if body is None else 'POST'),'body':None if body is None else json.dumps(body)})
 return result['status'],json.loads(base64.b64decode(result['body']))
def route(r):
 url=urlsplit(r.request.url)
 if url.netloc!=urlsplit(origin).netloc:
  external.append(r.request.url);r.abort();return
 if mode['hold'] and url.path==args.endpoint and r.request.method=='GET':
  mode['hold']=False;pending.append(r);return
 # fail: the next request with this method and path gets a synthetic 503 and never reaches the fixture.
 if mode['fail'] and mode['fail']==(r.request.method,url.path):
  mode['fail']=None;requests.append({'path':url.path,'method':r.request.method,'status':503})
  r.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic save failure. Retry with the same values.'}));return
 result=send({'path':url.path+('?'+url.query if url.query else ''),'method':r.request.method,'body':r.request.post_data})
 requests.append({'path':url.path,'method':r.request.method,'status':result['status']})
 r.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
def on_dialog(dialog):
 dialogs.append(dialog.message)
 dialog.dismiss() if dialog.message.startswith(tuple(dismiss)) else dialog.accept()
dismiss=[]
def no_scroll(page):return page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')

try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  page=browser.new_page(viewport={'width':1280,'height':900},accept_downloads=True)
  page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',on_dialog)
  panel=page.locator('#ab-tests')
  def shots(name,full=False):
   """Both widths: no horizontal scroll, then a screenshot of the panel (and of the page when full)."""
   for width,height in [(1280,900),(390,844)]:
    page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(50)
    check(f'{name}: no horizontal scroll at {width} px',no_scroll(page))
    check(f'{name}: the panel fits {width} px',panel.bounding_box()['width']<=width)
    panel.screenshot(path=str(out/f'{name}-{width}.png'));shots_taken.append(f'{name}-{width}.png')
    if full:page.screenshot(path=str(out/f'{name}-page-{width}.png'),full_page=True);shots_taken.append(f'{name}-page-{width}.png')
   page.set_viewport_size({'width':1280,'height':900})
  def field(label):return panel.get_by_label(label,exact=True)
  def button(name,scope=None):return (scope or panel).get_by_role('button',name=name,exact=True)
  def status(text):return panel.locator('.ab-tests-status[role="status"]').filter(has_text=text)
  def article(name):return panel.get_by_role('article',name=f'A/B test: {name}',exact=True)
  def listing():
   status_code,data=api(args.endpoint);assert status_code==200,data
   return data
  ids={v['name'] if not v['name'].startswith('GAM_only_') else 'gam':v['id'] for v in listing()['versions']}
  check('The fixture seeded three saved versions',sorted(ids)==['Version A','Version B','gam'])
  long_name=next(v['name'] for v in listing()['versions'] if v['name'].startswith('GAM_only_'))
  check('The GAM-only version name has 160 characters and no spaces',len(long_name)==160 and ' ' not in long_name)

  # 1. The home page link and #ab-tests open Generate and releases with the panel in view, below Saved versions.
  page.goto(origin+'/')
  link=page.get_by_role('link',name='A/B tests',exact=True);link.wait_for()
  check('The TEST home page links the A/B tests panel',link.get_attribute('href')=='/site-workspace#ab-tests')
  # Loading, a failed load and Reload: the loading line is the panel's own status class, never .runtime-message.
  mode['hold']=True
  page.goto(origin+args.page)
  panel.get_by_role('heading',name='A/B tests',exact=True).wait_for()
  loading=panel.locator('.ab-tests-status[role="status"]').filter(has_text='Loading A/B tests…')
  for _ in range(500):
   if pending:break
   page.wait_for_timeout(10)
  check('The list request is held while loading',len(pending)==1)
  loading.wait_for()
  check('While loading, no .runtime-message or .runtime-error has role=status',page.locator('.runtime-message[role="status"], .runtime-error[role="status"]').count()==0)
  shots('loading')
  pending.pop().fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic A/B tests failure. Retry.'}))
  failed=panel.get_by_role('alert').filter(has_text='Synthetic A/B tests failure. Retry.');failed.wait_for()
  check('A failed load says why, offers Reload and has no status line',loading.count()==0 and button('Reload A/B tests').is_visible()
   and page.locator('.runtime-message[role="status"], .runtime-error[role="status"]').count()==0)
  shots('load-error')
  button('Reload A/B tests').click()
  expect(field('TestId')).to_have_value('test_site_1')
  saved=page.get_by_role('heading',name='Saved versions',exact=True);saved.wait_for()
  page.get_by_text(long_name,exact=True).wait_for()
  page.wait_for_timeout(400)
  check('The page is Generate and releases',page.get_by_role('heading',name='Generate and releases',exact=True).is_visible())
  check('The panel is below Saved versions',saved.bounding_box()['y']<panel.bounding_box()['y'])
  top=page.evaluate("document.getElementById('ab-tests').getBoundingClientRect().top")
  check('#ab-tests scrolls the panel to the top of the view',-2<=top<=40)
  check('No idle runtime-message or runtime-error status after loading',page.locator('.runtime-message[role="status"], .runtime-error[role="status"]').count()==0)
  check('No idle status in the panel after loading',panel.get_by_role('status').count()==0)
  text=page.locator('main').inner_text()
  check('No production-menu wording',all(s not in text for s in ['Config →','Releases →']))
  check('The no-production note, the public-names note and the upload note are shown',
   all(panel.get_by_text(s,exact=True).is_visible() for s in [NO_PRODUCTION,PUBLIC,UPLOAD]))
  check('Option text never equals a bare version name',panel.locator('option').filter(has_text='Version A').first.inner_text()!='Version A')
  check('Save is disabled before a check',button('Save A/B test').is_disabled())
  shots('opened',full=True)

  # 3. GAM only vs Prebid is refused, and Save stays disabled.
  field('Version A').select_option(ids['gam']);field('Version B').select_option(ids['Version A'])
  page.set_viewport_size({'width':390,'height':844})
  check('A 160-character version name in a select does not widen the page',no_scroll(page) and field('Version A').bounding_box()['width']<=390)
  page.set_viewport_size({'width':1280,'height':900})
  field('Test name').fill('Bid cache')
  button('Check compatibility').click()
  refused=status('Not compatible:');refused.wait_for()
  check('GAM only vs A is refused in plain words',refused.inner_text().startswith('Not compatible: Version B loads Prebid.js and version A is GAM only.'))
  check('Save stays disabled after a refusal',button('Save A/B test').is_disabled())
  shots('refused')

  # 4. A vs B is compatible, with bidCache.enabled in the summary of differences.
  field('Version A').select_option(ids['Version A']);field('Version B').select_option(ids['Version B'])
  check('Changing a version clears the earlier result',status('Not compatible:').count()==0 and button('Save A/B test').is_disabled())
  # A passing check never promises a save: it says the versions can be compared and names the field that blocks Save.
  field('Test name').fill('')
  button('Check compatibility').click()
  status(COMPATIBLE).wait_for()
  check('A passing check does not promise a save',status('You can save').count()==0)
  blocked=panel.locator('.ab-tests-result .ab-tests-help').filter(has_text=' to save.')
  check('With no test name, the check names the missing name and Save is disabled',
   blocked.inner_text()=='Enter a test name to save.' and button('Save A/B test').is_disabled())
  field('Test name').fill('Bid cache');field('TestId').fill('Test_site_1')
  check('With an invalid TestId, the check names the TestId rule',blocked.inner_text()=='Use 1 to 24 lowercase letters, digits or _ in the TestId to save.')
  field('TestId').fill('test_site_1');field('Traffic to B (%)').fill('50.5')
  check('With a fractional traffic share, the check names the traffic rule',blocked.inner_text()=='Use a whole number from 0 to 100 for traffic to save.')
  field('Traffic to B (%)').fill('50')
  check('With every field valid, no blocking line is shown',blocked.count()==0)
  table=panel.locator('.ab-tests-diff table')
  check('The summary of differences lists bidCache.enabled',table.get_by_text('bidCache.enabled',exact=True).is_visible())
  row=table.locator('tr').filter(has_text='bidCache.enabled')
  check('Bid caching is Off in A and On in B',row.locator('td').nth(0).inner_text()=='Off' and row.locator('td').nth(1).inner_text()=='On')
  # List fields show only what each side has and the other lacks: an empty side is "Nothing extra", never "None".
  positions=table.locator('tr').filter(has_text='bidCache.positions')
  check('An empty list difference reads Nothing extra',positions.locator('td').nth(0).inner_text()=='Nothing extra'
   and 'Billboard' in positions.locator('td').nth(1).inner_text() and 'None' not in table.inner_text())
  check('The list help says what each side shows',panel.get_by_text(LIST_HELP,exact=True).is_visible())
  check('Save is enabled after a passing check',button('Save A/B test').is_enabled())
  shots('compatible')

  # 5. A failed save reloads the list, so the proposed TestId is current, and keeps every entered value.
  mode['fail']=('POST',args.endpoint);before=len(requests)
  button('Save A/B test').click()
  panel.get_by_role('alert').filter(has_text='Synthetic save failure. Retry with the same values.').wait_for()
  page.wait_for_timeout(200)
  after=[(r['method'],r['path']) for r in requests[before:]]
  check('A failed save reloads the A/B tests list',after[:2]==[('POST',args.endpoint),('GET',args.endpoint)])
  check('A failed save keeps the entered values',field('Test name').input_value()=='Bid cache' and field('TestId').input_value()=='test_site_1'
   and button('Save A/B test').is_enabled())
  # Save; saving the same test again stores nothing new.
  button('Save A/B test').click()
  status('A/B test "Bid cache" saved.').wait_for()
  article('Bid cache').wait_for()
  check('After saving, the name, the check and the TestId start over',field('Test name').input_value()=='' and field('TestId').input_value()=='test_site_2'
   and status('Compatible.').count()==0 and button('Save A/B test').is_disabled())
  field('Test name').fill('Bid cache');field('TestId').fill('test_site_1')
  button('Check compatibility').click();status(COMPATIBLE).wait_for()
  button('Save A/B test').click()
  status('This A/B test is already saved. Nothing new was stored.').wait_for()
  data=listing()
  check('Saving again made no duplicate',len(data['tests'])==1 and article('Bid cache').count()==1)
  first=data['tests'][0]
  check('The saved test has TestId test_site_1 and B 50%',first['testId']=='test_site_1' and first['trafficBPercent']==50)
  check('The article names both versions',article('Bid cache').locator('dd .ab-tests-name').all_inner_texts()==['Version A','Version B'])
  shots('saved')

  # 6. The same TestId with another name is refused, and the entered values are kept.
  field('Test name').fill('Bid cache 2')
  button('Save A/B test').click()
  alert=panel.get_by_role('alert').filter(has_text='TestId test_site_1 is already used by another A/B test on this site.');alert.wait_for()
  check('The TestId refusal keeps every entered value',field('Test name').input_value()=='Bid cache 2' and field('TestId').input_value()=='test_site_1'
   and field('Version A').input_value()==ids['Version A'] and field('Version B').input_value()==ids['Version B'] and field('Traffic to B (%)').input_value()=='50')
  check('The refusal stored nothing',len(listing()['tests'])==1)
  check('Errors use role=alert, not role=status',alert.get_attribute('class')=='runtime-error')
  shots('testid-taken')

  # 7 and 12. A/A with the 160-character version: one r/ file, and the cut name wraps in the list.
  field('Version A').select_option(ids['gam']);field('Version B').select_option(ids['gam'])
  panel.get_by_text('A/A check: both groups get the same version.',exact=True).wait_for()
  field('Test name').fill('A/A check');field('TestId').fill('test_site_2');field('Traffic to B (%)').fill('30')
  check('The traffic line follows the entered share',panel.get_by_text('A: 70% · B: 30%',exact=True).is_visible())
  button('Check compatibility').click()
  status(COMPATIBLE).wait_for()
  check('A/A has no differences',panel.get_by_text('No differences in the compared settings.',exact=True).is_visible())
  button('Save A/B test').click()
  status('A/B test "A/A check" saved.').wait_for()
  aa=next(t for t in listing()['tests'] if t['name']=='A/A check')
  status_code,aa_detail=api(f"{args.endpoint}/{aa['id']}")
  arms=[f['path'] for f in aa_detail['record']['bundle']['files'] if f['path'].startswith('r/')]
  check('A saved test clears the check, and the notice stays under the form',status('Compatible.').count()==0
   and panel.locator('.ab-tests-form').get_by_role('status').filter(has_text='A/B test "A/A check" saved.').count()==1)
  check('A/A saves one r/ file',status_code==200 and arms==[f"r/{ids['gam']}/ads.js"] and aa['trafficBPercent']==30)
  check('The list shows the cut version name with an ellipsis',article('A/A check').locator('.ab-tests-name').filter(has_text='GAM_only_').first.inner_text().endswith('…'))
  article('A/A check').get_by_text('Test details',exact=True).click()
  check('Test details show the full version name',article('A/A check').locator('.ab-tests-details').get_by_text(long_name,exact=True).count()==2)
  shots('aa-saved')

  # 8. The ZIP and the record download and match their sha256.
  bid=article('Bid cache')
  with page.expect_download() as download:button('Download A/B ZIP',bid).click()
  raw=Path(download.value.path()).read_bytes()
  check('The A/B ZIP matches its saved sha256',sha(raw)==first['zipSha256'] and download.value.suggested_filename==f"ab-test_site_1-{first['id'][-8:]}.zip")
  with zipfile.ZipFile(io.BytesIO(raw)) as archive:
   names=sorted(archive.namelist())
  check('The ZIP holds the loader, both arms, Prebid.js and _headers',names==sorted(['_headers','ads.js','prebid.js',f"r/{ids['Version A']}/ads.js",f"r/{ids['Version B']}/ads.js"]))
  status('Bid cache: A/B ZIP downloaded and checked.').wait_for()
  check('An action notice shows in the test it belongs to',bid.get_by_role('status').filter(has_text='A/B ZIP downloaded and checked.').count()==1)
  status_code,detail=api(f"{args.endpoint}/{first['id']}")
  with page.expect_download() as download:button('Download test record',bid).click()
  raw=Path(download.value.path()).read_bytes()
  check('The test record matches its sha256',sha(raw)==detail['recordSha256'] and json.loads(raw)['id']==first['id'])
  status('Bid cache: test record downloaded and checked.').wait_for()
  shots('downloaded')

  # 9. Mark live, then Mark stopped.
  check('Mark stopped is disabled before Mark live',button('Mark stopped',bid).is_disabled())
  button('Mark live',bid).click()
  status('Bid cache: marked live.').wait_for()
  bid.locator('.ab-tests-events li').filter(has_text='Marked live').wait_for()
  check('After Mark live, only Mark stopped is enabled',button('Mark live',bid).is_disabled() and button('Mark stopped',bid).is_enabled())
  button('Mark stopped',bid).click()
  status('Bid cache: marked stopped.').wait_for()
  bid.locator('.ab-tests-events li').filter(has_text='Marked stopped').wait_for()
  status_code,detail=api(f"{args.endpoint}/{first['id']}")
  check('Both events are stored in order',[e['type'] for e in detail['events']]==['marked-live','marked-stopped'])
  check('Each mark asks first and says it changes no file',any('Mark "Bid cache" live?' in m and 'does not publish' in m for m in dialogs)
   and any('Mark "Bid cache" stopped?' in m for m in dialogs))
  shots('marked')

  # 10. Delete (a dismissed confirmation changes nothing), then Restore.
  dismiss.append('Delete A/B test "A/A check"?')
  button('Delete test',article('A/A check')).click()
  page.wait_for_timeout(200)
  check('A dismissed delete changes nothing',not listing()['deleted'] and article('A/A check').count()==1)
  dismiss.clear()
  button('Delete test',article('A/A check')).click()
  status('A/A check: moved to Deleted A/B tests.').wait_for()
  deleted=panel.locator('details.ab-tests-deleted');deleted.get_by_text('Deleted A/B tests',exact=True).click()
  restore=deleted.get_by_role('article',name='Deleted A/B test: A/A check',exact=True);restore.wait_for()
  check('The deleted test is listed only under Deleted A/B tests',article('A/A check').count()==0 and [t['name'] for t in listing()['deleted']]==['A/A check'])
  shots('deleted')
  button('Restore',restore).click()
  status('A/A check: restored.').wait_for()
  check('Restore brings the test back',article('A/A check').count()==1 and not listing()['deleted'] and panel.locator('details.ab-tests-deleted').count()==0)

  # 11. Delete all generated packages: the tests stay listed and downloadable, with their own copies.
  page.get_by_role('button',name='Delete all generated packages',exact=True).click()
  page.get_by_role('status').filter(has_text='3 generated packages deleted.').wait_for()
  bid.get_by_text(KEPT,exact=True).first.wait_for()
  check('Every arm of every test is marked as kept in its own copy',panel.get_by_text(KEPT,exact=True).count()==4)
  check('No saved version is offered any more',panel.locator('#ab-version-b option').count()==2)
  button('Check compatibility').click()
  status('Not compatible:').wait_for()
  check('Checking a removed version names it in plain words',status('Not compatible:').inner_text()
   =='Not compatible: Version A is no longer in Saved versions. Choose another saved version. Saved A/B tests keep their own copies.')
  with page.expect_download() as download:button('Download A/B ZIP',bid).click()
  check('The ZIP still downloads after cleanup with the same sha256',sha(Path(download.value.path()).read_bytes())==first['zipSha256'])
  shots('after-cleanup',full=True)

  text=page.locator('main').inner_text()
  check('No production-menu wording at the end',all(s not in text for s in ['Config →','Releases →']))
  check('No browser request left the fixture',not external)
  check('No unhandled UI error',not errors)
  browser.close()
finally:
 process.stdin.close();process.wait(timeout=10)
(out/'report.json').write_text(json.dumps({'scope':'Site workspace from source, real TEST Worker, local SQLite and memory R2; every other host refused',
 'fixture':args.fixture,'page':args.page,'endpoint':args.endpoint,'checks':checks,'passed':len(checks),'failed':0,'screenshots':shots_taken,
 'dialogs':dialogs,'errors':errors,'external':external,'requests':requests},indent=2))
print(json.dumps({'passed':len(checks),'failed':0}))
