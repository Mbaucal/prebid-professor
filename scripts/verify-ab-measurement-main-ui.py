"""Actual MAIN measurement UI/router, SQLite and fake R2. All browser traffic is intercepted."""
import base64,hashlib,json,os,subprocess,time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.generated/ab-measurement-main-ui';OUT.mkdir(parents=True,exist_ok=True)
(OUT/'result.json').unlink(missing_ok=True);(OUT/'failure.json').unlink(missing_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/ab-measurement-main-browser-fixture.mjs'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
fixture=json.loads(process.stdout.readline());assert fixture['ready'];origin=fixture['origin']
alpha=fixture['experiments']['alpha-site'];beta=fixture['experiments']['beta-site']
BASE='/api/publishers/alpha-site/ab-tests/'+alpha['id']+'/measurement/plans'
BETA='/api/publishers/beta-site/ab-tests/'+beta['id']+'/measurement/plans'
HEADERS='date,TestId,Variant,impressions,revenue,adRequests,responsesServed,measurableImpressions,viewableImpressions'
errors=[];external=[];requests=[];checks=[];held=[]
mode={'hold':None,'failDetail':None}

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
 if mode['hold']==(request.method,path):
  mode['hold']=None;held.append((route,send(path,request.method,request.post_data)));return
 if request.method=='GET' and path==mode['failDetail']:
  mode['failDetail']=None;route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic reporting plan unavailable'}));return
 result=send(path,request.method,request.post_data)
 requests.append({'path':path,'method':request.method,'status':result['status']});fulfill(route,result)
def check(name,condition):assert condition,name;checks.append(name)
def csv(start,end,test_id):
 return HEADERS+'\n'+f'{start},{test_id},A,1000,9876.543219,2000,1500,900,600\n'+f'{start},{test_id},B,900,11.25,1800,1200,850,425\n'+f'{end},{test_id},A,100,0.5,100,90,90,45\n'+f'{end},{test_id},B,100,0.1,200,100,90,45\n'

try:
 with sync_playwright() as p:
  launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
  if os.environ.get('CHROMIUM_PATH'):launch['executable_path']=os.environ['CHROMIUM_PATH']
  browser=p.chromium.launch(**launch)
  try:
   for width in [1440,390]:
    page=browser.new_page(viewport={'width':width,'height':960},accept_downloads=True)
    page.route('**/*',route);page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(origin+'/')
    article=page.get_by_role('article',name='A/B test: '+alpha['name'],exact=True)
    expect(article).to_be_visible()
    def measurement():return article.get_by_role('region',name='Measurement and GAM report',exact=True)
    def field(label):return measurement().get_by_label(label,exact=True)
    def button(label):return measurement().get_by_role('button',name=label,exact=True)
    def take_held():
     deadline=time.monotonic()+5
     while not held and time.monotonic()<deadline:page.wait_for_timeout(10)
     assert len(held)==1,{'expectedHeldRoutes':1,'actual':len(held)}
     return held.pop()
    def shot(name,target=None):
     (target or measurement()).scroll_into_view_if_needed()
     check(f'{width} {name}: no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
     page.screenshot(path=str(OUT/f'{name}-{width}.png'))
    def open_form():
     if not field('Report start date').is_visible():measurement().get_by_text('New reporting plan',exact=True).click()
    def review_input(text):
     field('GAM CSV').fill(text);expect(measurement().get_by_role('region',name='GAM CSV review')).to_have_count(0)
     button('Review GAM CSV').click()
    # Lazy list load, a visible failure and recovery all use the actual MAIN endpoint.
    mode['hold']=('GET',BASE);article.get_by_text('Measurement and GAM report',exact=True).click()
    article.get_by_role('button',name='Daily summary',exact=True).click()
    expect(measurement().get_by_text('Loading reporting plans…',exact=True)).to_be_visible();shot('loading')
    pending,_=take_held();pending.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic plan list unavailable'}))
    expect(measurement().get_by_role('alert')).to_contain_text('Synthetic plan list unavailable');shot('list-error')
    button('Reload reporting plans').click();expect(field('Saved reporting plan')).to_be_visible();open_form()
    expect(field('GAM network code')).to_have_value('999');expect(field('Inventory path')).to_have_value('/999/alpha-site/')
    check(f'{width}: no currency is inferred from the saved script',field('Report currency').input_value()=='')
    check(f'{width}: counting disabled and page RPM unavailable are visible','External page counting is disabled' in measurement().inner_text() and 'Page RPM, uplift and a winner remain unavailable' in measurement().inner_text())
    start,end=('2026-11-01','2026-11-02') if width==1440 else ('2026-11-03','2026-11-04')
    field('Report start date').fill(start);field('Report end date').fill(end);field('Report currency').fill('EUR')
    field('GAM report time zone').fill('UTC');field('Revenue basis').select_option('net');field('Revenue metric').select_option('cpm-cpc')
    _,before=api(BASE);mode['hold']=('POST',BASE);button('Save reporting plan').click()
    expect(measurement().get_by_text('Saving reporting plan…',exact=True)).to_be_visible();expect(button('Save reporting plan')).to_be_disabled();shot('saving')
    pending,saved_response=take_held();assert saved_response['status']==201,saved_response
    saved=json.loads(base64.b64decode(saved_response['body']));plan_id=saved['plan']['id']
    pending.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic response lost after plan commit. Retry the same fields.'}))
    expect(measurement().get_by_role('alert')).to_contain_text('Synthetic response lost after plan commit');shot('uncertain-save')
    expect(field('Report currency')).to_have_value('EUR');expect(field('Report start date')).to_have_value(start)
    mode['failDetail']=BASE+'/'+plan_id;button('Save reporting plan').click()
    expect(measurement().get_by_role('alert').filter(has_text='Synthetic reporting plan unavailable')).to_be_visible();shot('plan-error')
    button('Retry reporting plan').click();expect(measurement().get_by_text('Selected report context',exact=True)).to_be_visible()
    expect(field('Saved reporting plan')).to_have_value(plan_id)
    _,after=api(BASE);check(f'{width}: uncertain plan save retries without duplication',len(after['plans'])==len(before['plans'])+1)
    open_form();button('Save reporting plan').click();expect(measurement().get_by_text('Selected report context',exact=True)).to_be_visible()
    expect(measurement().get_by_role('status').filter(has_text='already saved')).to_be_visible()
    _,repeated=api(BASE);check(f'{width}: saving the selected plan again preserves readable context without duplicates',len(repeated['plans'])==len(after['plans']) and field('Saved reporting plan').input_value()==plan_id)
    shot('context',measurement().get_by_text('Selected report context',exact=True))
    # Exact template downloaded from the verified immutable plan.
    with page.expect_download() as event:button('Download GAM CSV template').click()
    template=Path(event.value.path()).read_text();check(f'{width}: canonical GAM template has exact TestId and Variant headers',template.splitlines()[0]==HEADERS and alpha['testId'] in template)
    raw=csv(start,end,alpha['testId']);_,storage_before=api('/__qa/inspect');puts_before=len(storage_before['puts'])
    field('GAM CSV').fill(raw);mode['hold']=('POST',BASE+'/'+plan_id+'/preview');button('Review GAM CSV').click()
    expect(measurement().get_by_text('Reviewing GAM CSV…',exact=True)).to_be_visible();expect(button('Review GAM CSV')).to_be_disabled()
    pending,result=take_held();assert result['status']==200,result;fulfill(pending,result)
    result_region=measurement().get_by_role('region',name='GAM CSV review');expect(result_region).to_be_visible()
    expect(result_region).to_contain_text('9877.043219');expect(result_region).to_contain_text('Revenue comparison unavailable.')
    expect(result_region.get_by_role('row').filter(has_text='Assigned page views').locator('td')).to_have_text(['Unavailable','Unavailable'])
    expect(result_region.get_by_role('row').filter(has_text='Page RPM').locator('td')).to_have_text(['Unavailable','Unavailable'])
    shot('review',result_region)
    with page.expect_download() as event:button('Download review JSON').click()
    exported=json.loads(Path(event.value.path()).read_text())
    check(f'{width}: export identifies exact plan and imported CSV',exported['planId']==plan_id and exported['source']['csvSha256']==hashlib.sha256(raw.encode()).hexdigest())
    check(f'{width}: export never invents a winner or page denominator',exported['winner'] is None and exported['upliftPercent'] is None and not exported['revenueReady'] and exported['totals']['A']['pageRpm'] is None and exported['totals']['B']['receivedAssignments'] is None)
    # Missing data remains unknown; malformed or changed input removes the prior result.
    partial='\n'.join(raw.rstrip('\n').split('\n')[:-1])+'\n';review_input(partial)
    expect(result_region).to_be_visible();expect(result_region).to_contain_text('1 missing daily A/B rows. These values are unknown, not zero.')
    expect(result_region).to_contain_text(end+' · Variant B');shot('missing-data',result_region)
    duplicate=raw+raw.splitlines()[1]+'\n';review_input(duplicate)
    expect(measurement().get_by_role('alert').filter(has_text='Duplicate')).to_be_visible();expect(result_region).to_have_count(0);shot('csv-error')
    review_input(raw.replace(alpha['testId'],'foreign_test'))
    expect(measurement().get_by_role('alert')).to_contain_text('TestId');expect(result_region).to_have_count(0)
    field('Upload GAM CSV').set_input_files({'name':'invalid.csv','mimeType':'text/csv','buffer':b'\xff\xfeinvalid'})
    expect(measurement().get_by_role('alert')).to_contain_text('UTF-8');expect(field('GAM CSV')).to_have_value('')
    field('Upload GAM CSV').set_input_files({'name':'too-large.csv','mimeType':'text/csv','buffer':b'x'*131073})
    expect(measurement().get_by_role('alert')).to_contain_text('128 KB');expect(result_region).to_have_count(0)
    field('Upload GAM CSV').set_input_files({'name':'valid.csv','mimeType':'text/csv','buffer':raw.encode()})
    expect(field('GAM CSV')).to_have_value(raw);button('Review GAM CSV').click();expect(result_region).to_be_visible()
    check(f'{width}: UTF-8 upload failure and size refusal recover with a valid file',True)
    _,read_only=api('/__qa/inspect');check(f'{width}: financial previews and errors never write storage',len(read_only['puts'])==puts_before and read_only['unchanged'])
    # A different immutable plan clears the CSV and result; editing a new plan does not mutate the old one.
    open_form();field('Report currency').fill('USD');expect(result_region).to_have_count(0)
    button('Save reporting plan').click();expect(field('GAM CSV')).to_have_value('')
    expect(field('Saved reporting plan')).not_to_have_value(plan_id)
    plan_id=field('Saved reporting plan').input_value();expect(measurement().locator('.ab-measurement-context').first).to_contain_text('USD')
    check(f'{width}: changing context creates another plan and clears report input',True)
    # Stored plans retain their copy of the scope after source packages disappear.
    api('/__qa/source-off','POST',{});button('Reload reporting plans').click()
    open_form();expect(measurement().get_by_role('alert')).to_contain_text('New plans are unavailable');expect(button('Save reporting plan')).to_be_disabled()
    with page.expect_download() as event:button('Download GAM CSV template').click()
    check(f'{width}: existing plan template remains readable without source packages',HEADERS in Path(event.value.path()).read_text())
    review_input(raw);expect(result_region).to_be_visible();shot('source-unavailable')
    api('/__qa/source-on','POST',{});button('Reload reporting plans').click();expect(button('Save reporting plan')).to_be_enabled()
    _,inspection=api('/__qa/inspect')
    # Only the second immutable plan may write after the financial previews began.
    measurement_puts=inspection['puts'][puts_before:]
    check(f'{width}: only the explicitly saved new context wrote a reporting plan',len(measurement_puts)==1 and 'measurement-v1/' in measurement_puts[0])
    check(f'{width}: raw financial CSV is never stored',not inspection['financialDataPersisted'])
    check(f'{width}: measurement actions do not alter publisher/release SQL',inspection['unchanged'])
    check(f'{width}: previews have no outbound traffic',inspection['outboundRequests']==0)
    # A late Alpha preview cannot populate Beta's independently keyed panel.
    mode['hold']=('POST',BASE+'/'+plan_id+'/preview');button('Review GAM CSV').click();pending,snapshot=take_held()
    page.get_by_role('button',name='Beta site',exact=True).click()
    beta_article=page.get_by_role('article',name='A/B test: '+beta['name'],exact=True);expect(beta_article).to_be_visible()
    beta_article.get_by_text('Measurement and GAM report',exact=True).click()
    beta_article.get_by_role('button',name='Daily summary',exact=True).click()
    beta_panel=beta_article.get_by_role('region',name='Measurement and GAM report',exact=True)
    expect(beta_panel.get_by_label('Inventory path',exact=True)).to_have_value('/999/beta-site/')
    fulfill(pending,snapshot);page.wait_for_timeout(50)
    expect(beta_panel.get_by_role('region',name='GAM CSV review')).to_have_count(0)
    check(f'{width}: late preview cannot cross site context','9876.543219' not in beta_panel.inner_text())
    page.close()
   check('No browser JavaScript errors',not errors);check('No external browser requests',not external)
   OUT.joinpath('result.json').write_text(json.dumps({'passed':len(checks),'failed':0,'checks':checks,'requests':requests,
     'scope':fixture['scope'],'screenshots':[path.name for path in OUT.glob('*.png')],'externalRequests':external,'pageErrors':errors},indent=2))
   print(json.dumps({'passed':len(checks),'failed':0,'screenshots':len(list(OUT.glob('*.png')))}))
  finally:
   if not (OUT/'result.json').exists() and browser.contexts:
    try:
     current=browser.contexts[-1].pages[-1]
     OUT.joinpath('failure.html').write_text(current.content())
     OUT.joinpath('failure-aria.txt').write_text(current.locator('body').aria_snapshot())
     current.screenshot(path=str(OUT/'failure.png'))
    except Exception:pass
   browser.close()
except Exception as error:
 OUT.joinpath('failure.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'error':str(error),'requests':requests,'external':external,'pageErrors':errors},indent=2))
 raise
finally:
 process.stdin.close();process.terminate();process.wait(timeout=10)
