"""Real dashboard navigation and MAIN report actions; all traffic is synthetic and intercepted."""
import base64,json,os,subprocess,time
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.generated/measurement-navigation-ui';OUT.mkdir(parents=True,exist_ok=True)
for name in ['result.json','failure.json']:(OUT/name).unlink(missing_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/measurement-navigation-browser-fixture.mjs'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
fixture=json.loads(process.stdout.readline());assert fixture['ready'];origin=fixture['origin']
alpha,other=fixture['experiments']['alpha-site'];beta=fixture['experiments']['beta-site'][0]
headers='date,TestId,Variant,impressions,revenue,adRequests,responsesServed,measurableImpressions,viewableImpressions'
checks=[];requests=[];external=[];errors=[];held=[];mode={'hold':None}

def send(path,method='GET',body=None):
 process.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result;return result
def fulfill(route,result):route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
def route(route):
 request=route.request;url=urlsplit(request.url)
 if url.netloc!=urlsplit(origin).netloc:external.append(request.url);route.abort();return
 path=url.path+('?'+url.query if url.query else '')
 result=send(path,request.method,request.post_data)
 requests.append({'path':path,'method':request.method,'status':result['status']})
 if mode['hold']==(request.method,path):mode['hold']=None;held.append((route,result));return
 fulfill(route,result)
def check(name,condition=True):assert condition,name;checks.append(name)
def inspect():return json.loads(base64.b64decode(send('/__qa/inspect')['body']))

try:
 with sync_playwright() as p:
  launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
  if os.environ.get('CHROMIUM_PATH'):launch['executable_path']=os.environ['CHROMIUM_PATH']
  browser=p.chromium.launch(**launch)
  try:
   for width in [1440,390]:
    page=browser.new_page(viewport={'width':width,'height':960},accept_downloads=True)
    page.route('**/*',route);page.on('pageerror',lambda error:errors.append(str(error)))
    def tab(name):return page.locator('.tabbar').get_by_role('button',name=name,exact=True)
    def current(site,tab_name='Measurement'):
     expect(page.locator('.workspace h1')).to_have_text(site+'.example.invalid')
     expect(page.locator('.tabbar .active')).to_have_text(tab_name)
     query=parse_qs(urlsplit(page.url).query)
     check(f'{width} {site} {tab_name}: URL keeps publisher and site',query['publisher']==['measurement-publisher'] and query['site']==[site])
    def menu():
     button=page.get_by_role('button',name='Menu',exact=True)
     if button.is_visible():button.click()
    def choose(site):
     menu();page.locator('.site-link').filter(has_text=site+'.example.invalid').click();current(site)
    def saved_cards():return page.locator('.ab-tests-item').filter(has=page.get_by_role('button',name='Review GAM report',exact=True))
    def choose_test(item):
     article=page.get_by_role('article',name='A/B test: '+item['name'],exact=True)
     if not article.get_by_role('region',name='Measurement and GAM report',exact=True).count():article.get_by_role('button',name='Review GAM report',exact=True).click()
     article.get_by_role('button',name='Daily summary',exact=True).click()
     return article
    def measurement():return page.get_by_role('region',name='Measurement and GAM report',exact=True)
    def field(label):return measurement().get_by_label(label,exact=True)
    def button(label):return measurement().get_by_role('button',name=label,exact=True)
    def take_held():
     deadline=time.monotonic()+5
     while not held and time.monotonic()<deadline:page.wait_for_timeout(10)
     assert len(held)==1,{'expectedHeldRoutes':1,'actual':len(held)}
     return held.pop()
    def shot(name,target=None):
     if target:target.scroll_into_view_if_needed()
     check(f'{width} {name}: no document horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
     page.screenshot(path=str(OUT/f'{name}-{width}.png'))
    # Actual legacy Releases previously had no entry to the measurement component.
    page.goto(origin+'/?section=publishers&publisher=measurement-publisher&site=alpha-site&tab=releases')
    current('alpha-site','Releases');expect(tab('Measurement')).to_be_visible()
    status,setup=send('/api/publishers/alpha-site/builtin-site-settings')['status'],None
    setup=json.loads(base64.b64decode(send('/api/publishers/alpha-site/builtin-site-settings')['body']))
    check(f'{width}: Alpha really uses legacy release workflow',status==200 and setup['releaseWorkflow']=='legacy')
    listing='/api/publishers/alpha-site/ab-tests';mode['hold']=('GET',listing);tab('Measurement').click();current('alpha-site')
    expect(page.get_by_text('Loading A/B tests…',exact=True)).to_be_visible();shot('loading')
    pending,_=take_held();pending.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic A/B list unavailable'}))
    expect(page.get_by_role('alert')).to_contain_text('Synthetic A/B list unavailable');shot('list-error')
    page.get_by_role('button',name='Reload A/B tests',exact=True).click();expect(page.get_by_role('heading',name='Saved A/B tests',exact=True)).to_be_visible()
    article=choose_test(alpha);expect(field('Saved reporting plan')).to_be_visible()
    expect(page.get_by_text(alpha['testId'],exact=True).first).to_be_visible()
    check(f'{width}: real legacy site can open generic saved test without migration',True)
    shot('selected-test',article)
    if not field('Report start date').is_visible():measurement().get_by_text('New reporting plan',exact=True).click()
    date='2026-11-05' if width==1440 else '2026-11-06'
    field('Report start date').fill(date);field('Report end date').fill(date);field('Report currency').fill('EUR')
    field('GAM report time zone').fill('UTC');field('Revenue basis').select_option('net');field('Revenue metric').select_option('cpm-cpc')
    button('Save reporting plan').click();expect(measurement().get_by_text('Selected report context',exact=True)).to_be_visible()
    with page.expect_download() as event:button('Download GAM CSV template').click()
    template=Path(event.value.path()).read_text()
    check(f'{width}: template has exact selected TestId and canonical columns',template.splitlines()[0]==headers and alpha['testId'] in template)
    csv=headers+'\n'+f'{date},{alpha["testId"]},A,1000,9876.543219,2000,1500,900,600\n'+f'{date},{alpha["testId"]},B,900,11.25,1800,1200,850,425\n'
    before=inspect();field('Upload GAM CSV').set_input_files({'name':'gam-selected-test.csv','mimeType':'text/csv','buffer':csv.encode()})
    expect(field('GAM CSV')).to_have_value(csv);button('Review GAM CSV').click()
    review=measurement().get_by_role('region',name='GAM CSV review');expect(review).to_be_visible()
    expect(review).to_contain_text('9876.543219');expect(review).to_contain_text('Revenue comparison unavailable.')
    shot('csv-review',review)
    with page.expect_download() as event:button('Download review JSON').click()
    exported=json.loads(Path(event.value.path()).read_text())
    check(f'{width}: no page RPM, uplift or winner invented',not exported['revenueReady'] and exported['winner'] is None and exported['upliftPercent'] is None and exported['totals']['A']['pageRpm'] is None)
    after=inspect();check(f'{width}: report import/review never persists financial CSV or changes saved packages',before==after and after['originalObjectsUnchanged'] and not after['financialDataPersisted'])
    # A different test receives a fresh report form instead of the preceding result.
    choose_test(other);expect(field('Saved reporting plan')).to_be_visible()
    expect(field('GAM CSV')).to_have_count(0);expect(page.get_by_text(other['testId'],exact=True).first).to_be_visible()
    check(f'{width}: changing selected test removes former CSV/review',page.get_by_role('region',name='GAM CSV review').count()==0)
    # Hold an Alpha list response while navigating to Beta; releasing it cannot fill Beta.
    tab('Overview').click();mode['hold']=('GET',listing);tab('Measurement').click();pending,response=take_held()
    choose('beta-site');tab('Measurement').click();current('beta-site');expect(page.get_by_role('article',name='A/B test: '+beta['name'],exact=True)).to_be_visible()
    fulfill(pending,response);choose_test(beta);expect(field('Saved reporting plan')).to_be_visible()
    expect(page.get_by_text(beta['testId'],exact=True).first).to_be_visible()
    check(f'{width}: old site response cannot populate selected site',page.get_by_role('article',name='A/B test: '+alpha['name'],exact=True).count()==0 and page.get_by_role('article',name='A/B test: '+other['name'],exact=True).count()==0)
    tab('Releases').click();current('beta-site','Releases')
    saved=page.get_by_role('article',name='A/B test: '+beta['name'],exact=True);expect(saved).to_be_visible()
    saved.get_by_role('button',name='Open measurement',exact=True).click();current('beta-site')
    expect(field('Saved reporting plan')).to_be_visible()
    selected_article=page.get_by_role('article',name='A/B test: '+beta['name'],exact=True)
    expect(selected_article.locator('.ab-tests-arms')).to_contain_text('Version A · 3.25.1');expect(selected_article.locator('.ab-tests-arms')).to_contain_text('Version B · 3.25.1')
    check(f'{width}: Releases link opens exact saved test and both script versions',True)
    # Refresh, browser traversal and direct links retain the actual publisher/site/tab.
    selected_url=page.url;page.reload();current('beta-site');expect(page.get_by_role('article',name='A/B test: '+beta['name'],exact=True)).to_be_visible();check(f'{width}: refresh retains Measurement URL',page.url==selected_url)
    tab('Overview').click();current('beta-site','Overview');page.go_back();current('beta-site');page.go_forward();current('beta-site','Overview')
    page.goto(origin+'/?section=publishers&publisher=measurement-publisher&site=alpha-site&tab=measurement');current('alpha-site');expect(page.get_by_role('article',name='A/B test: '+alpha['name'],exact=True)).to_be_visible()
    check(f'{width}: direct Measurement link and back/forward work',True)
    # Neither an empty builtin site nor an earlier pilot is silently migrated or fabricated into a test.
    for site in ['empty-site','legacy-site']:
     choose(site);tab('Measurement').click();current(site)
     expect(page.get_by_text('No A/B packages saved yet. Earlier packages are listed below.',exact=True)).to_be_visible()
     expect(saved_cards()).to_have_count(0);expect(measurement()).to_have_count(0)
     expect(page.get_by_label('Test name',exact=True)).to_be_visible()
     check(f'{width} {site}: source creation is available inline without leaving Measurement',page.locator('.ab-source-versions').count()==1)
     shot(site+'-empty')
    check(f'{width}: empty legacy view offers creation without migration or redirect',page.get_by_role('button',name='Open Releases',exact=True).count()==0)
    check(f'{width}: no browser exception or outbound request',not errors and not external)
    page.close()
   state=inspect()
   check('all original release/ZIP/config objects and publisher SQL preserved',state['sqlUnchanged'] and state['originalObjectsUnchanged'])
   check('only explicitly saved reporting plans added storage',len(state['addedObjectKeys'])==2 and all('measurement-v1/' in key for key in state['addedObjectKeys']))
   check('no financial CSV persisted or outbound backend requests',not state['financialDataPersisted'] and state['outboundRequests']==0)
   writes=[request for request in requests if request['method']!='GET']
   check('only report plan creation/CSV previews were requested',all(request['method']=='POST' and '/measurement/plans' in request['path'] for request in writes))
   (OUT/'result.json').write_text(json.dumps({'passed':True,'checks':checks,'requests':requests,'external':external,'errors':errors,'storage':state,'scope':fixture['scope']},indent=2))
   print(json.dumps({'passed':True,'checks':len(checks),'widths':[1440,390],'evidence':str(OUT)}))
  finally:browser.close()
except Exception as error:
 (OUT/'failure.json').write_text(json.dumps({'error':str(error),'checks':checks,'requests':requests,'external':external,'errors':errors},indent=2));raise
finally:
 process.stdin.close();process.wait(timeout=10)
