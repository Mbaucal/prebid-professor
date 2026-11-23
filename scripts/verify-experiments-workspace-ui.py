"""Tanjug-like legacy history and zero sources, through the actual App and authenticated MAIN routes."""
import base64,hashlib,io,json,os,subprocess,time,zipfile
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.generated/experiments-workspace-ui';OUT.mkdir(parents=True,exist_ok=True)
for name in ['result.json','failure.json']:(OUT/name).unlink(missing_ok=True)
for stale in OUT.glob('failure-*'):
 if stale.suffix in ['.json','.txt','.png']:stale.unlink()
checks=[];requests=[];external=[];metadata=[];errors=[];inspections=[]
columns='date,TestId,Variant,impressions,revenue,adRequests,responsesServed,measurableImpressions,viewableImpressions'

def check(name,condition=True):assert condition,name;checks.append(name)

try:
 with sync_playwright() as p:
  launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
  if os.environ.get('CHROMIUM_PATH'):launch['executable_path']=os.environ['CHROMIUM_PATH']
  browser=p.chromium.launch(**launch)
  try:
   for width in [1440,390]:
    process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/experiments-workspace-browser-fixture.mjs'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    fixture=json.loads(process.stdout.readline());assert fixture['ready'];origin=fixture['origin']
    mode={'loseSource':False,'loseTest':False,'failReadiness':False,'hold':None};held=[]
    def send(path,method='GET',body=None):
     process.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');process.stdin.flush()
     result=json.loads(process.stdout.readline());assert 'error' not in result,result;return result
    def data(path,method='GET',body=None):
     result=send(path,method,body);assert result['status']==200,result;return json.loads(base64.b64decode(result['body']))
    def fulfill(route,result):route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
    def intercept(route):
     request=route.request;url=urlsplit(request.url)
     if request.url=='https://js-download.prebid.org/versions':
      metadata.append({'width':width,'url':request.url,'fulfilled':'synthetic version catalog'})
      route.fulfill(status=200,content_type='application/json',body=json.dumps({'versions':['11.34.0','11.11.0']}));return
     if url.netloc!=urlsplit(origin).netloc:external.append(request.url);route.abort();return
     path=url.path+('?'+url.query if url.query else '')
     result=send(path,request.method,request.post_data)
     entry={'width':width,'path':path,'method':request.method,'status':result['status']}
     if result['status']>=400:
      try:entry['error']=json.loads(base64.b64decode(result['body'])).get('error')
      except (ValueError,TypeError):pass
     requests.append(entry)
     if request.method=='GET' and path=='/api/publishers/tanjug/builtin-releases' and mode['failReadiness']:
      mode['failReadiness']=False;route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic source readiness unavailable'}));return
     if mode['hold']==(request.method,path):mode['hold']=None;held.append((route,result));return
     if request.method=='POST' and path=='/api/publishers/tanjug/builtin-releases' and mode['loseSource']:
      mode['loseSource']=False;assert result['status']==201,result
      route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic response lost after script version commit'}));return
     if request.method=='POST' and path=='/api/publishers/tanjug/ab-tests' and mode['loseTest']:
      mode['loseTest']=False;assert result['status']==201,result
      route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic response lost after A/B test commit'}));return
     fulfill(route,result)
    page=browser.new_page(viewport={'width':width,'height':960},accept_downloads=True)
    page.route('**/*',intercept);page.on('pageerror',lambda error:errors.append(str(error)))
    def tab(name):return page.locator('.tabbar').get_by_role('button',name=name,exact=True)
    def here(site='tanjug'):
     query=parse_qs(urlsplit(page.url).query)
     check(f'{width}: workspace keeps publisher/site/Measurement',query.get('publisher')==['minacord-media-doo'] and query.get('site')==[site] and query.get('tab')==['measurement'])
    def source():return page.locator('.ab-source-versions')
    def setup():return source().get_by_role('region',name='Script setup',exact=True)
    def make_button(label):return source().get_by_role('button',name=label,exact=True)
    def new_test():return page.locator('form.ab-tests-form')
    def history():return page.locator('.historical-ab-tests')
    def earlier(name):return page.get_by_role('article',name='Earlier version: '+name,exact=True)
    def current_test(name):return page.get_by_role('article',name='A/B test: '+name,exact=True)
    def report():return page.get_by_role('region',name='Measurement and GAM report',exact=True)
    def report_field(label):return report().get_by_label(label,exact=True)
    def report_button(label):return report().get_by_role('button',name=label,exact=True)
    def select_runtime(version):
     control=setup().get_by_label('Script version',exact=True)
     value=control.locator('option').evaluate_all('(options,version)=>options.find(option=>option.value.startsWith(version+":"))?.value',version)
     assert value,version;control.select_option(value);return value
    def shot(name,target=None):
     if target:target.scroll_into_view_if_needed()
     check(f'{width} {name}: no document horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
     page.screenshot(path=str(OUT/f'{name}-{width}.png'))
    def post_count(path):return sum(row['width']==width and row['method']=='POST' and row['path']==path for row in requests)
    def choose_site(site):
     menu=page.get_by_role('button',name='Menu',exact=True)
     if menu.is_visible():menu.click()
     text={'other-site':'other.example.invalid','blocked-site':'blocked.example.invalid','tanjug':'tanjug.rs'}[site]
     page.locator('.site-link').filter(has_text=text).click()
     if page.locator('.tabbar .active').inner_text()!='Measurement':tab('Measurement').click()
     here(site)
    try:
     page.goto(origin+'/?section=publishers&publisher=minacord-media-doo&site=tanjug&tab=measurement');here()
     expect(page.get_by_role('heading',name='Earlier A/B tests',exact=True)).to_be_visible()
     expect(earlier('Earlier configurable pilot')).to_be_visible()
     expect(source().get_by_label('Version name',exact=True)).to_be_visible()
     check(f'{width}: exact reported user state starts with zero builtin sources',fixture['initialBuiltinSources']==0 and data('/__qa/inspect')['releases']==[])
     expect(new_test().get_by_label('Version A',exact=True)).to_be_disabled()
     expect(new_test().get_by_label('Version B',exact=True)).to_be_disabled()
     expect(page.get_by_role('button',name='Open Releases',exact=True)).to_have_count(0)
     check(f'{width}: opening workspace/history/empty choices performs no writes',not any(row['width']==width and row['method']!='GET' for row in requests))
     opened=data('/__qa/inspect')
     check(f'{width}: merely opening history preserves saved configuration and bytes',opened['configUnchanged'] and opened['originalObjectsUnchanged'] and opened['siteUnchanged'])
     check(f'{width}: empty workspace has an inline script version choice',setup().get_by_label('Script version',exact=True).count()==1)
     shot('source-builder-empty',source())
     shot('history-entry',history())
     # Real opaque pagination, a corrupt archive and original downloads coexist.
     more=history().get_by_role('button',name='Load more earlier tests',exact=True)
     if more.count():more.click()
     for old in fixture['history']['tests']:expect(earlier(old['name'])).to_be_visible()
     check(f'{width}: every earlier named test appears once after real cursor paging',all(earlier(old['name']).count()==1 for old in fixture['history']['tests']))
     named=earlier(fixture['history']['tests'][0]['name'])
     expect(named).to_contain_text('TestId-based CSV review is unavailable')
     with page.expect_download() as event:named.get_by_role('button',name='Download original ZIP',exact=True).click()
     downloaded=Path(event.value.path()).read_bytes()
     check(f'{width}: historical test downloads original verified bytes',hashlib.sha256(downloaded).hexdigest()==fixture['history']['tests'][0]['sha256'])
     script_details=history().locator('details').filter(has=page.locator('summary').filter(has_text='Earlier saved scripts')).first
     script_details.locator('summary').first.click()
     more_scripts=history().get_by_role('button',name='Load more earlier scripts',exact=True)
     if more_scripts.count():more_scripts.click()
     damaged=history().get_by_role('article').filter(has_text=fixture['history']['scripts'][2]['id']);expect(damaged.get_by_role('alert')).to_be_visible()
     damaged_download=damaged.get_by_role('button',name='Download original ZIP',exact=True)
     if damaged_download.count():expect(damaged_download).to_be_disabled()
     standalone=earlier('Earlier fresh script');expect(standalone).to_contain_text('Standalone script without A/B labels')
     check(f'{width}: corrupt row is explicit and healthy history remains available',named.get_by_role('button',name='Download original ZIP',exact=True).is_enabled())
     shot('historical-scripts',standalone)
     send('/__qa/history-failure');history().get_by_role('button',name='Reload earlier tests',exact=True).click()
     expect(history().get_by_role('alert').filter(has_text='Could not load this part of the saved history')).to_be_visible()
     expect(earlier('Earlier configurable pilot')).to_be_visible()
     expect(source().get_by_label('Version name',exact=True)).to_be_visible()
     history().get_by_role('button',name='Retry earlier tests',exact=True).click()
     expect(history().get_by_role('alert').filter(has_text='Could not load this part of the saved history')).to_have_count(0)
     check(f'{width}: one failed history section does not hide other tests or creation',True)
     # A stale setup save preserves the operator's requested version and both forms.
     version_a=f'Current settings A {width}';version_b=f'Current settings B {width}';test_name=f'Workspace comparison {width}';test_id=f'workspace_{width}'
     source().get_by_label('Version name',exact=True).fill(version_a)
     new_test().get_by_label('Test name',exact=True).fill(test_name);new_test().get_by_label('TestId',exact=True).fill(test_id)
     pin_a=select_runtime('3.25.1');expect(make_button('Generate and save package')).to_be_disabled()
     send('/__qa/revision-change');setup().get_by_role('button',name='Save script setup',exact=True).click()
     expect(setup().get_by_role('alert')).to_contain_text('changed')
     expect(source().get_by_label('Version name',exact=True)).to_have_value(version_a)
     expect(new_test().get_by_label('Test name',exact=True)).to_have_value(test_name)
     expect(new_test().get_by_label('TestId',exact=True)).to_have_value(test_id)
     setup().get_by_role('button',name='Reload script setup',exact=True).click()
     expect(setup().get_by_label('Script version',exact=True)).to_have_value(pin_a)
     setup().get_by_role('button',name='Save script setup',exact=True).click();expect(make_button('Generate and save package')).to_be_enabled()
     check(f'{width}: explicit setup CAS recovery retains entered source/test choices',True)
     # Source generation has no idempotency token: a lost response must lead to read/discovery, never an auto-POST.
     mode['loseSource']=True;before_sources=post_count('/api/publishers/tanjug/builtin-releases')
     make_button('Generate and save package').click()
     expect(source().get_by_role('alert').filter(has_text='may already have been saved')).to_be_visible()
     expect(make_button('Generate and save package')).to_be_disabled()
     expect(source().get_by_label('Version name',exact=True)).to_have_value(version_a)
     state=data('/__qa/inspect');assert len(state['releases'])==1,state['releases'];release_a=state['releases'][0]['id']
     page.wait_for_timeout(150)
     check(f'{width}: uncertain source save is not automatically repeated',post_count('/api/publishers/tanjug/builtin-releases')==before_sources+1)
     mode['failReadiness']=True;make_button('Reload source versions').click()
     expect(source().get_by_role('alert').filter(has_text='Synthetic source readiness unavailable')).to_be_visible()
     expect(make_button('Generate and save package')).to_be_disabled()
     check(f'{width}: failed readonly source recovery cannot unlock another generation',post_count('/api/publishers/tanjug/builtin-releases')==before_sources+1)
     make_button('Reload source versions').click()
     expect(new_test().get_by_label('Version A',exact=True).locator('option',has_text=version_a)).to_have_count(1)
     new_test().get_by_label('Version A',exact=True).select_option(release_a)
     select_runtime('3.26.0');source().get_by_label('Version name',exact=True).fill(version_b)
     expect(make_button('Generate and save package')).to_be_disabled()
     setup().get_by_role('button',name='Save script setup',exact=True).click();expect(make_button('Generate and save package')).to_be_enabled()
     make_button('Generate and save package').click()
     expect(source().get_by_role('status').filter(has_text='Script version saved')).to_be_visible()
     state=data('/__qa/inspect');assert len(state['releases'])==2,state['releases'];release_b=next(row['id'] for row in state['releases'] if row['id']!=release_a)
     expect(new_test().get_by_label('Version B',exact=True)).to_have_value(release_b)
     expect(new_test()).to_contain_text('3.25.1');expect(new_test()).to_contain_text('3.26.0')
     check(f'{width}: both new script versions become A/B sources in the same page',True)
     shot('source-selection',new_test())
     send('/__qa/add-corrupt-source');make_button('Reload source versions').click()
     unavailable=new_test().get_by_label('Version A',exact=True).locator('option',has_text='Unavailable saved source')
     expect(unavailable).to_be_disabled();expect(current_test('Other site saved experiment')).to_have_count(0)
     new_test().get_by_role('button',name='Check compatibility',exact=True).click()
     expect(new_test().get_by_text('Compatible. These versions can be compared.',exact=True)).to_be_visible()
     mode['loseTest']=True;new_test().get_by_role('button',name='Save A/B test',exact=True).click()
     expect(new_test().get_by_role('alert')).to_contain_text('Synthetic response lost after A/B test commit')
     expect(new_test().get_by_label('TestId',exact=True)).to_have_value(test_id)
     new_test().get_by_role('button',name='Save A/B test',exact=True).click()
     saved=current_test(test_name);expect(saved).to_be_visible();expect(saved).to_contain_text(test_id)
     listing=data('/api/publishers/tanjug/ab-tests');saved_record=next(row for row in listing['tests'] if row['testId']==test_id)
     check(f'{width}: retry of exact A/B save recovers one original test',len(listing['tests'])==1)
     with page.expect_download() as event:saved.get_by_role('button',name='Download A/B ZIP',exact=True).click()
     bundle_bytes=Path(event.value.path()).read_bytes();record=data('/api/publishers/tanjug/ab-tests/'+saved_record['id'])['record']
     bundle=zipfile.ZipFile(io.BytesIO(bundle_bytes))
     check(f'{width}: complete A/B ZIP pins exact chosen scripts and shared Prebid',hashlib.sha256(bundle_bytes).hexdigest()==record['bundle']['zipSha256'] and all(hashlib.sha256(bundle.read(record['arms'][side]['path'])).hexdigest()==record['arms'][side]['sha256'] for side in ['A','B']) and hashlib.sha256(bundle.read('prebid.js')).hexdigest()==hashlib.sha256((ROOT/'vendor/prebid/tanjug-11.34.0/prebid.js').read_bytes()).hexdigest())
     registry=json.loads((ROOT/'worker/experiments/ab-loader-registry.json').read_text())
     check(f'{width}: new test pins a registered loader while historical records stay separate',record['loader']['version'] in registry and record['loader']['sha256']==registry[record['loader']['version']]['sha256'] and all(old['id']!=saved_record['id'] for old in fixture['history']['tests']))
     if not saved.get_by_role('region',name='Measurement and GAM report',exact=True).count():saved.get_by_role('button',name='Review GAM report',exact=True).click()
     expect(report_field('Saved reporting plan')).to_be_visible();here()
     if not report_field('Report start date').is_visible():report().get_by_text('New reporting plan',exact=True).click()
     date='2026-11-20';report_field('Report start date').fill(date);report_field('Report end date').fill(date);report_field('Report currency').fill('EUR')
     report_field('GAM report time zone').fill('UTC');report_field('Revenue basis').select_option('net');report_field('Revenue metric').select_option('cpm-cpc')
     report_button('Save reporting plan').click();expect(report().get_by_text('Selected report context',exact=True)).to_be_visible()
     with page.expect_download() as event:report_button('Download GAM CSV template').click()
     template=Path(event.value.path()).read_text();check(f'{width}: report template binds the newly saved TestId',template.splitlines()[0]==columns and test_id in template)
     csv=columns+'\n'+f'{date},{test_id},A,1000,9876.543219,2000,1500,900,600\n'+f'{date},{test_id},B,900,11.25,1800,1200,850,425\n'
     before_import=data('/__qa/inspect');report_field('Upload GAM CSV').set_input_files({'name':'gam-selected-test.csv','mimeType':'text/csv','buffer':csv.encode()})
     expect(report_field('GAM CSV')).to_have_value(csv);report_button('Review GAM CSV').click()
     review=report().get_by_role('region',name='GAM CSV review');expect(review).to_be_visible();expect(review).to_contain_text('Revenue comparison unavailable.')
     with page.expect_download() as event:report_button('Download review JSON').click()
     exported=json.loads(Path(event.value.path()).read_text())
     check(f'{width}: report does not invent assigned-page RPM/uplift/winner',not exported['revenueReady'] and exported['winner'] is None and exported['upliftPercent'] is None and exported['totals']['A']['pageRpm'] is None)
     check(f'{width}: CSV import/review adds no persistent objects or config writes',data('/__qa/inspect')==before_import)
     shot('new-test-report',review)
     # A late history response from Tanjug cannot fill the newly selected site.
     tab('Overview').click();mode['hold']=('GET','/api/publishers/tanjug/ab-tests/history');tab('Measurement').click()
     deadline=time.monotonic()+5
     while not held and time.monotonic()<deadline:page.wait_for_timeout(10)
     assert len(held)==1,held;pending,response=held.pop()
     choose_site('other-site');expect(current_test('Other site saved experiment')).to_be_visible();fulfill(pending,response)
     expect(earlier('Earlier configurable pilot')).to_have_count(0);expect(report()).to_have_count(0)
     check(f'{width}: site switch clears prior financial preview and ignores late Tanjug history',True)
     selected_url=page.url;page.reload();here('other-site');check(f'{width}: Measurement refresh retains exact site URL',page.url==selected_url)
     tab('Overview').click();page.go_back();here('other-site');page.go_forward();expect(tab('Overview')).to_have_class('tab active')
     page.goto(origin+'/?section=publishers&publisher=minacord-media-doo&site=blocked-site&tab=measurement');here('blocked-site')
     expect(source().get_by_text('No current Prebid file',exact=False).first).to_be_visible()
     setup().get_by_role('button',name='Open Prebid.js',exact=True).click()
     expect(source().get_by_role('heading',name='Prebid.js setup',exact=True)).to_be_visible();here('blocked-site')
     expect(make_button('Generate and save package')).to_be_disabled();shot('missing-prebid',source())
     state=data('/__qa/inspect');inspections.append({'width':width,**state})
     check(f'{width}: original historical bytes, site/channel and inventory remain unchanged',state['originalObjectsUnchanged'] and state['siteUnchanged'] and state['inventoryUnchanged'] and state['otherSiteUnchanged'])
     check(f'{width}: only explicit setup selects new future runtime and keeps Prebid/cache policy',state['config']['builtinRuntimeSelection']['runtime']['runtimeVersion']=='3.26.0' and state['config']['enablePrebid'] is True and state['config']['prebidBidCache']=={'enabled':True,'maxBidAgeSeconds':60})
     check(f'{width}: no financial CSV persistence, live traffic or browser error',not state['financialDataPersisted'] and state['outboundRequests']==0 and not external and not errors)
     writes=[row for row in requests if row['width']==width and row['method']!='GET']
     allowed=('/builtin-site-settings','/builtin-releases','/ab-tests','/measurement/plans')
     check(f'{width}: UI writes only explicit setup/source/test/report actions',all(row['method']=='POST' and any(part in row['path'] for part in allowed) for row in writes))
    except Exception:
     page.screenshot(path=str(OUT/f'failure-{width}.png'))
     (OUT/f'failure-{width}.txt').write_text(page.locator('.workspace').inner_text())
     (OUT/f'failure-inspection-{width}.json').write_text(json.dumps(data('/__qa/inspect'),indent=2))
     raise
    finally:
     page.close();process.stdin.close();process.wait(timeout=10)
   (OUT/'result.json').write_text(json.dumps({'passed':True,'checks':checks,'requests':requests,'errors':errors,'external':external,'interceptedMetadata':metadata,'inspections':inspections,'scope':'Actual App and MAIN routes with synthetic Tanjug history, approved frozen Prebid bytes and no ad execution; Prebid version catalog fulfilled synthetically'},indent=2))
   print(json.dumps({'passed':True,'checks':len(checks),'widths':[1440,390],'evidence':str(OUT)}))
  finally:browser.close()
except Exception as error:
 (OUT/'failure.json').write_text(json.dumps({'error':str(error),'checks':checks,'requests':requests,'errors':errors,'external':external,'interceptedMetadata':metadata},indent=2));raise
