"""Manual opt-in: real cross-origin GEO only, synthetic ads, no paid requests."""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
if '--test' not in sys.argv:raise SystemExit('Use --test to allow the reviewed TEST country endpoint only.')
root=Path(__file__).resolve().parent.parent
out=root/'.generated/geo-runtime-evidence';out.mkdir(parents=True,exist_ok=True)
endpoint='https://prebid-professor-test.mbaucal.workers.dev/geo/v1/country'
origin='https://geo-runtime.fixture.invalid'
script=(out/'prebid.min.js').read_text();mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
 for width in [1440,390]:
  page=browser.new_page(viewport={'width':width,'height':900});geo=[];blocked=[];errors=[];headers=[];failures=[]
  page.on('requestfailed',lambda r:failures.append(r.failure) if r.url==endpoint else None)
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('response',lambda r:headers.append({'status':r.status,'headers':r.all_headers()}) if r.url==endpoint else None)
  def route(r):
   if r.request.url==origin+'/':r.fulfill(status=200,content_type='text/html',body='<html><body><div id="P2" class="wrapperAd"></div></body></html>')
   elif r.request.url==endpoint:geo.append(r.request.url);r.continue_()
   else:blocked.append(r.request.url);r.abort()
  page.route('**/*',route);page.goto(origin+'/')
  page.add_script_tag(content=mock);page.evaluate("window.adsKeywords={category:'Naslovna',pageType:'home'}")
  page.add_script_tag(content=script)
  page.wait_for_function("window.__AD_GEO && __AD_GEO.getSnapshot().status!=='pending'",timeout=10000)
  value=page.evaluate('''()=>({country:__AD_GEO.getSnapshot(),ads:__testAds.observations.requests.length,origin:location.origin})''')
  assert not errors,errors
  assert len(geo)==1,geo
  assert not blocked,blocked
  assert value['ads']>0,value
  results.append({'width':width,**value,'geoRequests':len(geo),'response':headers,'requestFailures':failures})
  page.close()
 browser.close()
(out/'hosted-results.json').write_text(json.dumps({'scope':'Actual HTTPS cross-origin TEST GEO; synthetic ads; two observations only','results':results},indent=2))
print(json.dumps(results,indent=2))
