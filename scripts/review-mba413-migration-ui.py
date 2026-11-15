"""Independent prior TEST schema upgrade UI: actual handler and SQLite, zero remote requests."""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent;out=root/'.generated/review-mba413-migration-ui';out.mkdir(parents=True,exist_ok=True);results=[]
with sync_playwright() as pw:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=pw.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/review-mba413-migration-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(proc.stdout.readline());assert ready['ready'];origin=ready['origin'];requests=[];errors=[];reject=[];hold=[];pending=[]
   def send(path,method='GET',body=None):
    proc.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');proc.stdin.flush();value=json.loads(proc.stdout.readline());assert 'error' not in value,value;return value
   def snapshot():return json.loads(base64.b64decode(send('/__fixture/snapshot')['body']))
   def fulfill(route):
    request=route.request;path=urlsplit(request.url).path;value=send(path,request.method,request.post_data);requests.append({'path':path,'method':request.method,'status':value['status']});route.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
   def route(route):
    request=route.request;url=urlsplit(request.url);assert url.netloc==urlsplit(origin).netloc,'Unexpected external request'
    if url.path=='/test-api/setup' and request.method=='POST':
     if reject:reject.pop();route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic upgrade failure: retry.'}));return
     if hold:hold.pop();pending.append(route);return
    fulfill(route)
   page=browser.new_page(viewport={'width':width,'height':1000});page.on('pageerror',lambda error:errors.append(str(error)));page.route('**/*',route)
   def screen(name):
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal page overflow';page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
   try:
    before=snapshot();page.goto(origin+'/',wait_until='domcontentloaded');expect(page.locator('#upgrade')).to_be_visible();expect(page.locator('#setup')).to_be_hidden();expect(page.locator('#generator')).to_be_hidden();expect(page.locator('#message')).to_contain_text('saved packages are kept');assert snapshot()==before;screen('upgrade-available')
    reject.append(True);page.locator('#migrate').click();expect(page.locator('#message')).to_contain_text('Synthetic upgrade failure');expect(page.locator('#migrate')).to_be_enabled();assert snapshot()==before;screen('upgrade-error')
    hold.append(True);page.locator('#migrate').click();expect(page.locator('#migrate')).to_be_disabled();screen('upgrade-loading');assert len(pending)==1;fulfill(pending.pop());expect(page.locator('#upgrade')).to_be_hidden();expect(page.locator('#generator')).to_be_visible();screen('upgrade-complete')
    after=snapshot();assert 'account_json' in after['columns'];assert [{k:v for k,v in row.items() if k!='account_json'} for row in after['bidders']]==before['bidders'];assert all(row['account_json']=='{}' for row in after['bidders']);assert after['objects']==before['objects'] and after['config']==before['config'];assert len([r for r in requests if r['path']=='/test-api/setup'])==1
    page.reload();expect(page.locator('#upgrade')).to_be_hidden();expect(page.locator('#generator')).to_be_visible();assert snapshot()==after;assert not errors,errors
    results.append({'width':width,'passed':['Legacy state offers explicit upgrade without initializing or changing data','Rejected upgrade preserves settings and enables retry','Busy upgrade prevents duplicate submit','Successful upgrade preserves all bidder fields, site config and saved ZIP bytes','Reload keeps upgraded state without replay'],'requests':requests,'pageErrors':errors})
   except Exception:
    screen('failure');(out/f'failure-{width}.json').write_text(json.dumps({'requests':requests,'pageErrors':errors,'visibleText':page.locator('body').inner_text()},indent=2));raise
   finally:page.close();proc.stdin.close();proc.wait(timeout=15)
 finally:browser.close()
report={'scope':'Actual TEST handler and prior schema in SQLite. No hosted migration.','results':results,'passed':sum(len(row['passed']) for row in results),'failed':0};(out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
