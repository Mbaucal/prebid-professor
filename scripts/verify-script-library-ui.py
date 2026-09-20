"""Named script library: real React + service with all external traffic blocked."""
import base64,json,subprocess,hashlib
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/script-library-ui';out.mkdir(exist_ok=True)
process=subprocess.Popen(['node','scripts/script-library-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert json.loads(process.stdout.readline())['ready']
errors=[];requests=[];checks=[];last_saved=None
def check(name,ok):
 assert ok,name
 checks.append(name)
def route(r):
 global last_saved
 url=urlsplit(r.request.url);assert url.netloc=='tessera.fixture.invalid'
 payload={'path':url.path+('?' + url.query if url.query else ''),'method':r.request.method,'body':r.request.post_data}
 process.stdin.write(json.dumps(payload)+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result
 body=base64.b64decode(result['body']);requests.append({'method':payload['method'],'status':result['status']})
 if payload['method']=='POST' and result['status'] in [200,201]:last_saved=json.loads(body)['item']
 r.fulfill(status=result['status'],headers=result['headers'],body=body)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True);page=browser.new_page(viewport={'width':1280,'height':1000})
  page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('https://tessera.fixture.invalid/');page.get_by_role('button',name='Save script version',exact=True).wait_for()
  check('Opening the library is read-only',all(r['method']=='GET' for r in requests))
  page.get_by_label('Script name',exact=True).fill('Standard 10s')
  page.get_by_label('Refresh',exact=True).select_option('fixed');page.get_by_label('Standard interval (seconds)',exact=True).fill('10')
  page.get_by_role('button',name='Save script version',exact=True).click();page.get_by_role('status').filter(has_text='Script saved').wait_for()
  first=last_saved.copy()
  cache_name='Cache-60s-'+('LongName'*8)
  page.get_by_label('Script name',exact=True).fill(cache_name)
  page.get_by_label('Auction mode',exact=True).select_option('auction-with-cache')
  page.get_by_label('Maximum bid age (seconds)',exact=True).fill('60')
  page.get_by_role('button',name='Save script version',exact=True).click();page.get_by_role('status').filter(has_text='Script saved').wait_for()
  second=last_saved.copy()
  check('Named standalone cache version saved',second['name']==cache_name and second['settings']['mode']=='auction-with-cache' and second['settings']['refreshSeconds']==10)
  card=page.get_by_role('article',name='Script: '+cache_name,exact=True)
  with page.expect_download() as downloaded:card.get_by_role('button',name='Download standalone ZIP',exact=True).click()
  downloaded.value.save_as(str(out/'standalone.zip'))
  check('Standalone download has the chosen name and verified bytes',downloaded.value.suggested_filename.startswith(cache_name) and hashlib.sha256((out/'standalone.zip').read_bytes()).hexdigest()==second['sha256'])
  page.get_by_label('Test name',exact=True).fill('Standard vs Cache')
  page.get_by_label('Script A',exact=True).select_option(first['id']);page.get_by_label('Script B',exact=True).select_option(second['id'])
  page.get_by_label('Traffic to B (%)',exact=True).fill('10')
  page.get_by_role('button',name='Save A/B test',exact=True).click();page.get_by_role('status').filter(has_text='A/B test saved').wait_for()
  saved_test=last_saved.copy()
  check('A/B test references exact named saved versions',saved_test['scripts']['A']['id']==first['id'] and saved_test['scripts']['B']['id']==second['id'] and saved_test['trafficBPercent']==10)
  with page.expect_download() as downloaded:page.get_by_role('article',name='Test: Standard vs Cache',exact=True).get_by_role('button',name='Download A/B ZIP',exact=True).click()
  downloaded.value.save_as(str(out/'test.zip'));check('Test ZIP matches saved version',hashlib.sha256((out/'test.zip').read_bytes()).hexdigest()==saved_test['sha256'])
  page.screenshot(path=str(out/'desktop.png'),full_page=True)
  page.reload();page.get_by_role('article',name='Script: '+cache_name,exact=True).wait_for();page.get_by_role('article',name='Test: Standard vs Cache',exact=True).wait_for()
  check('Saved names and references survive reload',page.get_by_role('article',name='Script: Standard 10s',exact=True).count()==1)
  page.get_by_role('article',name='Script: '+cache_name,exact=True).get_by_role('button',name='Create from these settings').click()
  page.get_by_label('Script name',exact=True).fill('Cache 30s');page.get_by_label('Maximum bid age (seconds)',exact=True).fill('30')
  page.get_by_role('button',name='Save script version',exact=True).click();page.get_by_role('status').filter(has_text='Script saved').wait_for()
  check('Editing creates a separate version without changing the saved test',last_saved['id']!=second['id'] and cache_name in page.get_by_role('article',name='Test: Standard vs Cache',exact=True).inner_text())
  page.get_by_role('button',name='Save script version',exact=True).click();page.get_by_role('status').filter(has_text='already saved').wait_for()
  check('Same name and settings do not duplicate the version',page.get_by_role('article',name='Script: Cache 30s',exact=True).count()==1)
  page.get_by_label('Test name',exact=True).fill('Cache A/A');page.get_by_label('Script A',exact=True).select_option(second['id']);page.get_by_label('Script B',exact=True).select_option(second['id'])
  check('Same version can be chosen for A/A',page.get_by_text('Both variants use the same script.',exact=False).is_visible())
  page.get_by_role('button',name='Save A/B test',exact=True).click();page.get_by_role('status').filter(has_text='A/B test saved').wait_for()
  page.set_viewport_size({'width':390,'height':844});page.get_by_role('article',name='Script: '+cache_name,exact=True).get_by_text('Version details',exact=True).click()
  check('Long names and version identities fit mobile',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
  page.screenshot(path=str(out/'mobile.png'),full_page=True);check('No unhandled UI error',not errors)
  browser.close()
finally:
 process.stdin.close();process.wait(timeout=10)
(out/'report.json').write_text(json.dumps({'checks':checks,'passed':len(checks),'failed':0,'errors':errors,'requests':requests},indent=2))
print(json.dumps({'passed':len(checks),'failed':0}))
