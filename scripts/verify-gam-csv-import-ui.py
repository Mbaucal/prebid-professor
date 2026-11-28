"""Real dashboard, synthetic MAIN routing and CSV data. No external traffic or writes."""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.generated/gam-csv-import-ui';OUT.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/measurement-navigation-browser-fixture.mjs','--gam-reports'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
fixture=json.loads(process.stdout.readline());assert fixture['ready'];origin=fixture['origin']
csvs=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {siteCsv,sites} from './tests/support/gam-csv-fixture.mjs';console.log(JSON.stringify(Object.fromEntries(Object.keys(sites).map(site=>[site,Object.fromEntries(['01','02','03','04','05'].map(id=>[id,siteCsv(id,{site})]))]))));"],cwd=ROOT,text=True))
checks=[];requests=[];external=[];errors=[]
def send(path,method='GET',body=None):
 process.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result;return result
def route(route):
 req=route.request;url=urlsplit(req.url)
 if url.netloc!=urlsplit(origin).netloc:external.append(req.url);route.abort();return
 assert req.method=='GET','CSV review must not send or persist data'
 path=url.path+('?'+url.query if url.query else '');result=send(path,req.method,req.post_data);requests.append(path)
 route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
def file(id,text=None,site='politika'):return {'name':f'report-{id}.csv','mimeType':'text/csv','buffer':(text or csvs[site][id]).encode()}
def check(name,ok=True):assert ok,name;checks.append(name)
try:
 with sync_playwright() as p:
  launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
  if os.environ.get('CHROMIUM_PATH'):launch['executable_path']=os.environ['CHROMIUM_PATH']
  browser=p.chromium.launch(**launch)
  for width in [1440,390]:
   page=browser.new_page(viewport={'width':width,'height':1000});page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(origin+'/?section=publishers&publisher=measurement-publisher&site=alpha-site&tab=measurement')
   panel=page.get_by_role('region',name='GAM display reports',exact=True);expect(panel).to_be_visible()
   def upload(items):panel.get_by_label('Choose GAM CSV files',exact=True).set_input_files(items)
   def select(prefix):panel.get_by_role('button',name=prefix,exact=False).click()
   def shot(name):
    panel.get_by_role('heading',name='GAM display reports',exact=True).scroll_into_view_if_needed()
    check(f'{width} {name}: no horizontal page overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
    page.screenshot(path=str(OUT/f'{name}-{width}.png'))
    if panel.get_by_role('table').count():
     panel.get_by_role('table').scroll_into_view_if_needed();page.screenshot(path=str(OUT/f'{name}-table-{width}.png'))
    if name=='scope-checks':
     panel.get_by_label('Expected export network name or code',exact=True).scroll_into_view_if_needed();page.screenshot(path=str(OUT/f'{name}-fields-{width}.png'))
   upload([file(id) for id in csvs['politika']]);expect(panel.get_by_role('status')).not_to_contain_text('Reading',timeout=15000)
   if panel.get_by_role('alert').count():print(panel.get_by_role('alert').all_text_contents(),flush=True)
   expect(panel.get_by_role('status')).to_contain_text('5 report(s) loaded')
   expect(panel.get_by_role('columnheader',name='Variant A',exact=True)).to_be_visible()
   expect(panel.get_by_text('Variant-only cohort',exact=False)).to_contain_text('package identity unverified')
   expect(panel.get_by_role('row',name='Ad requests (code served + unfilled) 150 150',exact=True)).to_be_visible()
   expect(panel.get_by_role('row',name='Revenue / 1,000 requests 8.33 EUR 16.67 EUR',exact=True)).to_be_visible();shot('ab-results')
   select('02 ·');panel.get_by_label('Key family',exact=True).select_option('aq_bid_origin')
   expect(panel.get_by_role('columnheader',name='cached',exact=True)).to_be_visible();expect(panel.get_by_role('columnheader',name='Variant B',exact=True)).to_have_count(0)
   check(f'{width}: Prebid family stays separate');shot('bid-origin')
   select('03 ·');expect(panel.get_by_role('row',name='Ad requests 150',exact=True)).to_be_visible()
   expect(panel.get_by_label('Requested ad sizes',exact=True)).to_have_value('')
   panel.get_by_label('Requested ad sizes',exact=True).select_option('300x250, 336x280');panel.get_by_role('button',name='Clear report filters').click()
   select('04 ·');panel.get_by_label('Key family',exact=True).select_option('refresh_interval');expect(panel.get_by_role('columnheader',name='45',exact=True)).to_be_visible()
   select('05 ·');panel.get_by_label('Key family',exact=True).select_option('aq_consent_wait');expect(panel.get_by_role('columnheader',name='timeout',exact=True)).to_be_visible()
   upload([file('01',csvs['politika']['01'].replace('Key-values,','Variant (variant),'))]);expect(panel.get_by_role('alert')).to_contain_text('custom dimensions')
   select('01 ·');expect(panel.get_by_role('row',name='Revenue (EUR) 1.25 2.50',exact=True)).to_be_visible();shot('invalid-retains-results')
   upload([file('01',csvs['politika']['01'].replace('1.25','10.25'))]);expect(panel.get_by_role('status')).to_contain_text('1 report(s) loaded');expect(panel.get_by_role('alert')).to_have_count(0)
   expect(panel.get_by_role('row',name='Revenue (EUR) 10.25 2.50',exact=True)).to_be_visible()
   upload([file('03',csvs['politika']['03'].replace('Nov 19, 2026 - Nov 19, 2026','Nov 19, 2026 - Nov 20, 2026'))]);expect(panel.get_by_role('alert')).to_contain_text('different date ranges')
   panel.get_by_role('button',name='Clear imported reports').click();expect(panel.get_by_role('status')).to_have_text('Reports cleared.')
   # Hold file reads to prove busy feedback, cancellation and stale completion protection.
   page.evaluate("""() => { const read=File.prototype.text; File.prototype.text=function(){return new Promise(resolve=>{window.finishCsv=()=>read.call(this).then(resolve);});}; }""")
   upload([file('01')]);expect(panel.get_by_role('status')).to_contain_text('Reading report-01.csv')
   expect(panel.get_by_label('Choose GAM CSV files',exact=True)).to_be_disabled();shot('loading')
   panel.get_by_role('button',name='Clear imported reports').click();page.evaluate('window.finishCsv()');expect(panel.get_by_role('status')).to_have_text('Reports cleared.')
   expect(panel.get_by_role('table')).to_have_count(0)
   upload([file('01')]);expect(panel.get_by_role('status')).to_contain_text('Reading')
   # Switch site while reading; the old callback must not load a CSV on another site or on return.
   def choose(site):
    menu=page.get_by_role('button',name='Menu',exact=True)
    if menu.is_visible():menu.click()
    page.locator('.site-link').filter(has_text=site).click()
   choose('tanjug.rs');expect(panel).to_be_visible();page.evaluate('window.finishCsv()');expect(panel.get_by_role('table')).to_have_count(0)
   # Restore native reads in the current page after exercising the stale callback.
   page.reload();expect(panel).to_be_visible()
   upload([file('01',site='tanjug')]);expect(panel.get_by_role('status')).to_contain_text('1 report(s) loaded')
   expect(panel.get_by_role('row',name='Revenue (USD) 1.25 2.50',exact=True)).to_be_visible()
   expect(panel.get_by_text('/22852026051/Tanjug.rs-Display/',exact=True)).to_be_visible()
   check(f'{width}: Tanjug accepts renamed USD/UTC reports with no Politika defaults')
   # Changing sites clears all loaded data. Every third site exposes the same workspace.
   choose('direktno.rs');expect(panel).to_be_visible();expect(panel.get_by_role('table')).to_have_count(0)
   upload([file('01',site='third')]);expect(panel.get_by_role('row',name='Revenue (GBP) 1.25 2.50',exact=True)).to_be_visible()
   shot('third-site')
   # Expected identifiers are optional, shared by all five files, and fail closed when supplied.
   panel.get_by_text('GAM export settings and saved reports',exact=True).click()
   panel.get_by_text('Optional expected export identifiers',exact=True).click()
   panel.get_by_label('Expected export network name or code',exact=True).fill('22030000003')
   panel.get_by_label('Expected ad unit root name',exact=True).fill('Direktno display')
   panel.get_by_label('Expected ad unit filter ID',exact=True).fill('333')
   panel.get_by_label('Expected Prebid order IDs',exact=True).fill('701, 702, 703')
   panel.get_by_role('button',name='Apply report checks',exact=True).click();expect(panel.get_by_role('table')).to_have_count(0)
   upload([file(id,site='third') for id in csvs['third']]);expect(panel.get_by_role('status')).to_contain_text('5 report(s) loaded')
   expect(panel.get_by_text('Network: Direktno QA network (22030000003) · matches expected export identifier',exact=True)).to_have_count(1)
   select('02 ·');expect(panel.get_by_text('Delivery scope:',exact=False)).to_contain_text('matches the expected Prebid IDs')
   # A later file from another network cannot replace valid displayed financial data.
   upload([file('01',site='tanjug')]);expect(panel.get_by_role('alert')).to_contain_text('Publisher network does not match')
   select('01 ·');expect(panel.get_by_role('row',name='Revenue (GBP) 1.25 2.50',exact=True)).to_be_visible()
   wrongroot=csvs['third']['01'].replace('Direktno display » QA slot','Direktno display2 » QA slot')
   upload([file('01',wrongroot)]);expect(panel.get_by_role('alert')).to_contain_text('outside the expected site inventory root')
   panel.get_by_label('Time zone when absent from export',exact=True).fill('Invalid/zone')
   panel.get_by_role('button',name='Apply report checks',exact=True).click();expect(panel.get_by_role('alert').filter(has_text='valid IANA time zone')).to_have_text('Use a valid IANA time zone.')
   expect(panel.get_by_role('row',name='Revenue (GBP) 1.25 2.50',exact=True)).to_be_visible();shot('scope-checks')
   panel.get_by_label('Time zone when absent from export',exact=True).fill('')
   # Removing expected IDs is explicit and clears their previous verification.
   for label in ['Expected export network name or code','Expected ad unit root name','Expected ad unit filter ID','Expected Prebid order IDs']:panel.get_by_label(label,exact=True).fill('')
   panel.get_by_role('button',name='Apply report checks',exact=True).click()
   upload([file('01',site='third'),file('03',site='tanjug')]);expect(panel.get_by_role('alert')).to_contain_text('different networks, inventory filters, currencies or time zones')
   choose('politika.rs');expect(panel).to_be_visible();expect(panel.get_by_role('table')).to_have_count(0)
   check(f'{width}: all three sites retain independent data, explicit mismatch refusal and settings recovery')
   page.goto(origin+'/__qa/gam-csv-context');expect(panel).to_be_visible()
   # This harness updates props on the same React instance; there is deliberately no changing key.
   for field,value in [('gamPath','/999/changed/'),('siteDomain','changed.example.invalid'),('siteId','changed-site')]:
    panel.get_by_text('GAM export settings and saved reports',exact=True).click()
    panel.get_by_text('Optional expected export identifiers',exact=True).click()
    panel.get_by_label('Expected export network name or code',exact=True).fill('22850000002')
    panel.get_by_role('button',name='Apply report checks',exact=True).click()
    page.evaluate("""() => { if(!window.originalCsvText)window.originalCsvText=File.prototype.text;File.prototype.text=function(){return new Promise(resolve=>{window.finishCsv=()=>window.originalCsvText.call(this).then(resolve);});}; }""")
    upload([file('01',site='tanjug')]);expect(panel.get_by_role('status')).to_contain_text('Reading')
    page.evaluate('([field,value])=>window.__setGamContext(current=>({...current,[field]:value}))',[field,value])
    page.evaluate('window.finishCsv()');expect(panel.get_by_role('table')).to_have_count(0)
    expect(panel.get_by_label('Expected export network name or code',exact=True)).to_have_value('')
    page.evaluate('() => { File.prototype.text=window.originalCsvText; }')
    # Collapsed details are preserved, so close both before the next loop opens them.
    panel.get_by_text('Optional expected export identifiers',exact=True).click()
    panel.get_by_text('GAM export settings and saved reports',exact=True).click()
   check(f'{width}: same-instance site ID, domain and GAM-path changes cancel reads and reset report checks')
   check(f'{width}: import, overlap isolation, filters, replacement, error recovery, cancellation and site isolation passed')
   page.close()
  browser.close()
 inspection=json.loads(base64.b64decode(send('/__qa/inspect')['body']))
 check('No external requests or page errors',not external and not errors)
 check('No SQL or R2 changes',inspection['sqlUnchanged'] and inspection['originalObjectsUnchanged'] and not inspection['addedObjectKeys'])
 (OUT/'result.json').write_text(json.dumps({'passed':True,'checks':checks,'requestCount':len(requests),'external':external,'errors':errors,'inspection':inspection},indent=2))
 print(json.dumps({'passed':True,'checks':len(checks),'evidence':str(OUT)}))
finally:
 process.stdin.close();process.terminate();process.wait(timeout=15)
