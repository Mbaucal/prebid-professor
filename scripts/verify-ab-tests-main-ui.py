"""MAIN A/B panel + authenticated router, SQLite/fake R2. All requests intercepted; no ads."""
import base64,hashlib,io,json,os,re,subprocess,time,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.generated/ab-tests-main-ui';OUT.mkdir(parents=True,exist_ok=True)
(OUT/'result.json').unlink(missing_ok=True)
(OUT/'failure.json').unlink(missing_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/ab-tests-main-browser-fixture.mjs'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
fixture=json.loads(process.stdout.readline());assert fixture['ready'];origin=fixture['origin']
ALPHA='/api/publishers/alpha-site/ab-tests';BETA='/api/publishers/beta-site/ab-tests'
errors=[];external=[];requests=[];checks=[];dialogs=[];downloads=[];held=[]
mode={'holdList':None,'holdDetail':None,'failSave':False,'corruptZip':False,'holdAction':None,'failDetail':None,'commitFault':False}
def send(path,method='GET',body=None):
 process.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result;return result
def api(path,method='GET',body=None):
 result=send(path,method,None if body is None else json.dumps(body));return result['status'],json.loads(base64.b64decode(result['body']))
def fulfill(route,result):route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
def route(route):
 request=route.request;url=urlsplit(request.url)
 if url.netloc!=urlsplit(origin).netloc:external.append(request.url);route.abort();return
 path=url.path+('?'+url.query if url.query else '')
 if mode['holdAction']==(request.method,path):
  mode['holdAction']=None;held.append((route,send(path,request.method,request.post_data)));return
 if request.method=='GET' and path==mode['failDetail']:
  mode['failDetail']=None;route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic detail unavailable'}));return
 if request.method=='GET' and path in [mode['holdList'],mode['holdDetail']]:
  if path==mode['holdList']:mode['holdList']=None
  else:mode['holdDetail']=None
  held.append((route,send(path)));return
 if mode['commitFault'] and path==ALPHA and request.method=='POST':
  mode['commitFault']=False;committed=send(path,request.method,request.post_data);assert committed['status']==201,committed
  route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic response lost after commit. Retry the same values.'}));return
 if mode['failSave'] and path==ALPHA and request.method=='POST':
  mode['failSave']=False;route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic save unavailable. Retry.'}));return
 result=send(path,request.method,request.post_data)
 requests.append({'path':path,'method':request.method,'status':result['status']})
 if mode['corruptZip'] and path.endswith('/download'):
  mode['corruptZip']=False;result={**result,'body':base64.b64encode(b'changed zip bytes').decode()}
 fulfill(route,result)
def check(name,condition):
 assert condition,name
 checks.append(name)
try:
 with sync_playwright() as p:
  launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
  if os.environ.get('CHROMIUM_PATH'):launch['executable_path']=os.environ['CHROMIUM_PATH']
  browser=p.chromium.launch(**launch)
  try:
   for width in [1440,390]:
    page=browser.new_page(viewport={'width':width,'height':900},accept_downloads=True)
    page.route('**/*',route);page.on('pageerror',lambda error:errors.append(str(error)))
    page.on('dialog',lambda dialog:(dialogs.append(dialog.message),dialog.accept()))
    page.on('download',lambda download:downloads.append(download.suggested_filename))
    panel=page.locator('#ab-tests')
    def field(label):return panel.get_by_label(label,exact=True)
    def button(label,scope=None):return (scope or panel).get_by_role('button',name=label,exact=True)
    def article(name):return panel.get_by_role('article',name='A/B test: '+name,exact=True)
    def take_held():
     deadline=time.monotonic()+5
     while not held and time.monotonic()<deadline:page.wait_for_timeout(10)
     assert len(held)==1,{'expectedHeldRoutes':1,'actual':len(held)}
     return held.pop()
    def shot(name):
     check(f'{width} {name}: no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
     if name in ['saved','detail-error','audit-stopped']:
      article(f'MAIN comparison {width}').scroll_into_view_if_needed()
     elif name=='load-error':
      panel.get_by_role('alert').scroll_into_view_if_needed()
     elif name=='loading':
      panel.get_by_text('Loading A/B tests…',exact=True).scroll_into_view_if_needed()
     else:
      field('Version A').scroll_into_view_if_needed()
     page.screenshot(path=str(OUT/f'{name}-{width}.png'))
    def create(name,test_id):
     field('Test name').fill(name);field('TestId').fill(test_id)
     field('Version B').select_option(fixture['versions']['alpha-site'][1])
     button('Check compatibility').click();expect(panel.get_by_role('status').filter(has_text='Compatible. These versions can be compared.')).to_be_visible()
     button('Save A/B test').click();expect(article(name)).to_be_visible()
     expect(article(name).get_by_text('Not marked live yet.',exact=True)).to_be_visible()
    # The real MAIN panel reports loading and a recoverable GET error.
    mode['holdList']=ALPHA;page.goto(origin+'/')
    expect(panel.get_by_text('Loading A/B tests…',exact=True)).to_be_visible()
    shot('loading')
    pending,_=take_held();pending.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic list unavailable'}))
    expect(panel.get_by_role('alert')).to_contain_text('Synthetic list unavailable');shot('load-error')
    button('Reload A/B tests').click();expect(field('Version A')).to_have_value(fixture['versions']['alpha-site'][0])
    expect(panel).to_contain_text('Current Tessera production version');check(f'{width}: production control selected',field('Version A').input_value()==fixture['versions']['alpha-site'][0])
    shot('production-control')
    # Preserve an untouched proposed TestId when the backend commits but its reply is lost.
    expect(field('TestId')).to_have_value(re.compile(r'^[a-z0-9_]+$'))
    proposed=field('TestId').input_value();uncertain_name=f'Uncertain comparison {width}'
    _,before_uncertain=api(ALPHA);before_count=len(before_uncertain['tests'])
    field('Test name').fill(uncertain_name);field('Version B').select_option(fixture['versions']['alpha-site'][1]);field('Traffic to B (%)').fill('37')
    button('Check compatibility').click();expect(panel.get_by_role('status').filter(has_text='Compatible. These versions can be compared.')).to_be_visible()
    mode['commitFault']=True;button('Save A/B test').click();expect(panel.get_by_role('alert')).to_contain_text('Synthetic response lost after commit')
    shot('uncertain-save-error')
    expect(field('TestId')).to_have_value(proposed);expect(field('Test name')).to_have_value(uncertain_name)
    expect(field('Version A')).to_have_value(fixture['versions']['alpha-site'][0]);expect(field('Version B')).to_have_value(fixture['versions']['alpha-site'][1]);expect(field('Traffic to B (%)')).to_have_value('37')
    _,after_commit=api(ALPHA);assert len(after_commit['tests'])==before_count+1
    committed=next(row for row in after_commit['tests'] if row['testId']==proposed)
    button('Save A/B test').click();expect(panel.get_by_role('status').filter(has_text='already saved. Nothing new was stored.')).to_be_visible()
    _,after_retry=api(ALPHA);assert len(after_retry['tests'])==before_count+1
    assert next(row for row in after_retry['tests'] if row['testId']==proposed)['id']==committed['id']
    check(f'{width}: uncertain committed save retries untouched TestId without duplicate experiment',True)
    name=f'MAIN comparison {width}';test_id=f'main_{width}'
    field('Test name').fill(name);field('TestId').fill(test_id);field('Version B').select_option(fixture['versions']['alpha-site'][1])
    mode['holdAction']=('POST',ALPHA+'/check');button('Check compatibility').click()
    expect(panel.get_by_text('Checking compatibility…',exact=True)).to_be_visible();expect(button('Check compatibility')).to_be_disabled()
    pending,snapshot=take_held();fulfill(pending,snapshot)
    expect(panel.get_by_role('status').filter(has_text='Compatible. These versions can be compared.')).to_be_visible();check(f'{width}: check progress blocks duplicate action',True)
    mode['failSave']=True;button('Save A/B test').click();expect(panel.get_by_role('alert')).to_contain_text('Synthetic save unavailable')
    expect(field('Test name')).to_have_value(name);expect(field('TestId')).to_have_value(test_id);shot('save-error')
    mode['holdAction']=('POST',ALPHA);button('Save A/B test').click()
    expect(panel.get_by_text('Saving A/B test…',exact=True)).to_be_visible();expect(button('Save A/B test')).to_be_disabled()
    pending,snapshot=take_held();created=json.loads(base64.b64decode(snapshot['body']));mode['failDetail']=ALPHA+'/'+created['record']['id'];fulfill(pending,snapshot)
    expect(article(name)).to_be_visible();expect(article(name).get_by_role('alert')).to_contain_text('Synthetic detail unavailable');shot('detail-error')
    button('Retry',article(name)).click();expect(article(name).get_by_text('Not marked live yet.',exact=True)).to_be_visible();shot('saved')
    check(f'{width}: save progress and per-record Retry recover',True)
    _,listing=api(ALPHA);saved=next(item for item in listing['tests'] if item['testId']==test_id);item=article(name)
    # Corrupted browser downloads are refused before a local file is offered.
    mode['corruptZip']=True;before=len(downloads);button('Download A/B ZIP',item).click()
    expect(item.get_by_role('alert')).to_contain_text('differs from the saved A/B test');check(f'{width}: corrupted ZIP not downloaded',len(downloads)==before)
    with page.expect_download() as event:button('Download A/B ZIP',item).click()
    raw=Path(event.value.path()).read_bytes();check(f'{width}: actual ZIP SHA matches',hashlib.sha256(raw).hexdigest()==saved['zipSha256'])
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:check(f'{width}: ZIP contains loader and exact arm paths',set(archive.namelist())>={'ads.js',f"r/{saved['arms']['A']['release']}/ads.js",f"r/{saved['arms']['B']['release']}/ads.js"})
    with page.expect_download() as event:button('Download test record',item).click()
    record=json.loads(Path(event.value.path()).read_text());check(f'{width}: downloaded record identifies saved test',record['id']==saved['id'])
    button('Mark live',item).click();expect(button('Mark stopped',item)).to_be_enabled();check(f'{width}: live mark is explicitly audit-only','does not publish or change any file' in dialogs[-1])
    button('Delete test',item).click();expect(item).to_have_count(0);check(f'{width}: deleting live test warns delivery continues','does not stop it on your site' in dialogs[-1])
    panel.get_by_text('Deleted A/B tests',exact=True).first.click()
    deleted=panel.get_by_role('article',name='Deleted A/B test: '+name,exact=True);button('Restore',deleted).click();expect(item).to_be_visible()
    expect(button('Mark stopped',item)).to_be_enabled();button('Mark stopped',item).click();expect(button('Mark live',item)).to_be_enabled();shot('audit-stopped')
    check(f'{width}: stop dialog explains actual rollback','same script URL' in dialogs[-1] and 'does not change any file' in dialogs[-1])
    # An older held detail must not replace a newer detail loaded after another save.
    mode['holdDetail']=ALPHA+'/'+saved['id'];page.reload();expect(field('Version A')).to_have_value(fixture['versions']['alpha-site'][0])
    expect(page.get_by_role('main')).to_have_attribute('data-site','alpha-site');page.wait_for_function('document.querySelectorAll("#ab-tests article").length>0')
    # The corresponding held response is awaited below.
    old_route,old_snapshot=take_held()
    code,_=api(ALPHA+'/'+saved['id']+'/events','POST',{'type':'marked-live'});assert code==201
    create(f'Race comparison {width}',f'race_{width}')
    expect(button('Mark stopped',article(name))).to_be_enabled()
    fulfill(old_route,old_snapshot);page.wait_for_timeout(100)
    expect(button('Mark stopped',article(name))).to_be_enabled();expect(article(name).get_by_role('alert')).to_have_count(0)
    check(f'{width}: older detail cannot overwrite newer live mark',True)
    # A late list/error from Alpha cannot populate Beta or preserve Alpha's form.
    field('Test name').fill('Old alpha draft');mode['holdList']=ALPHA;page.reload();expect(panel.get_by_text('Loading A/B tests…',exact=True)).to_be_visible()
    old_route,_=take_held();page.get_by_role('button',name='Beta site',exact=True).click()
    expect(panel.get_by_text('No saved built-in production version is available',exact=False)).to_be_visible()
    expect(field('Version A')).to_have_value('');expect(field('Test name')).to_have_value('');expect(article('Beta existing test')).to_be_visible()
    old_route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Stale Alpha response'}));page.wait_for_timeout(100)
    expect(panel).not_to_contain_text('Stale Alpha response');expect(panel).not_to_contain_text(name);expect(field('Version A')).to_have_value('');shot('beta-site-reset')
    check(f'{width}: cross-site stale response ignored',True)
    _,inspection=api('/__qa/inspect');check(f'{width}: all A/B actions preserve application D1/channel/config',inspection['unchanged'])
    page.close()
  finally:browser.close()
 assert not errors,errors
 assert not external,external
 (OUT/'result.json').write_text(json.dumps({'passed':True,'checks':checks,'count':len(checks),'pageErrors':errors,'externalRequests':external,'dialogs':dialogs,'requests':requests,'scope':fixture['scope']},indent=2)+'\n')
 print(json.dumps({'passed':len(checks),'pageErrors':len(errors),'externalRequests':len(external),'output':str(OUT)}),flush=True)
except Exception as error:
 (OUT/'failure.json').write_text(json.dumps({'passed':False,'error':str(error),'checksPassed':checks,'pageErrors':errors,'externalRequests':external},indent=2)+'\n')
 raise
finally:
 process.stdin.close();process.wait(timeout=20)
