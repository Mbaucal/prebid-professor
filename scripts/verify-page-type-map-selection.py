"""Page-type size-map selection in Chromium, before and after a base-map rename.

Loads the 3.21.1 packages from scripts/prepare-page-type-map-selection.mjs with the repository
GPT/Prebid/CMP mock. The country signal is answered locally and every other request is aborted;
no ad traffic. Checks that the GPT size mapping of P1 and P2 is the page-type map's rows for
"naslovna" and "Članak" both before and after renaming P, and the base map's rows for any other
page type.
"""
import json,os,sys
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent
work=root/'.generated/page-type-map-selection'
out=Path(os.environ.get('PAGE_TYPE_EVIDENCE_DIR') or work)
out.mkdir(parents=True,exist_ok=True)
cases=json.loads((work/'cases.json').read_text())['cases']
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
def normalized(rows):return sorted([json.dumps({'viewport':row['viewport'],'sizes':row['sizes']},sort_keys=True) for row in rows])
results=[];failures=[]
with sync_playwright() as playwright:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=playwright.chromium.launch(**launch)
 try:
  for label in ['before','after']:
   source=(work/f'ads-{label}.js').read_text()
   for width,height in [(1440,900),(390,844)]:
    for page_type,expected in cases[label].items():
     page=browser.new_page(viewport={'width':width,'height':height});errors=[];outbound=[]
     page.on('pageerror',lambda error:errors.append(str(error)))
     def intercept(route,outbound=outbound):
      # The generated country signal is answered locally; anything else is aborted and reported.
      if route.request.url.endswith('/geo/v1/country'):return route.fulfill(status=200,content_type='application/json',body=json.dumps({'version':1,'status':'unknown','country':None,'source':'fixture'}))
      outbound.append(route.request.url);route.abort()
     page.route('**/*',intercept)
     page.set_content('<!doctype html><html lang="en"><body style="margin:0;font:14px sans-serif"><h1 style="font-size:18px;margin:12px">Page type '+page_type+'</h1><div id="P1" class="wrapperAd"></div><div id="P2" class="wrapperAd"></div></body></html>')
     page.add_script_tag(content=mock)
     page.evaluate('pageType=>{window.adsKeywords={pageType};}',page_type)
     page.add_script_tag(content=source)
     try:page.wait_for_function("()=>['P1','P2'].every(id=>window.__testAds.slots.some(slot=>slot.id===id&&slot.mapping))",timeout=10000)
     except Exception as error:errors.append('slots not defined: '+str(error)[:120])
     slots=page.evaluate("()=>window.__testAds.slots.filter(slot=>['P1','P2'].includes(slot.id)).map(slot=>({id:slot.id,mapping:slot.mapping}))")
     findings=[]
     if errors:findings.append('page errors')
     if outbound:findings.append('outbound request attempted')
     if sorted(slot['id'] for slot in slots)!=['P1','P2']:findings.append('P1/P2 not defined')
     for slot in slots:
      if normalized(slot['mapping'] or [])!=normalized(expected['rows']):findings.append(f"{slot['id']} mapping is not {expected['map']}")
     if label=='after' and page_type=='naslovna' and not findings:page.screenshot(path=str(out/f'page-type-selection-{width}.png'),full_page=True)
     results.append({'package':label,'pageType':page_type,'viewport':[width,height],'expectedMap':expected['map'],'slots':slots,'findings':findings,'errors':errors[:3],'outbound':outbound[:3]})
     if findings:failures.append(f'{label} {page_type} {width}: {findings}')
     page.close()
 finally:browser.close()
report={'scope':'Chromium + repository GPT mock; country signal answered locally, every other request aborted; 3.21.1 packages from the real admin Worker','passed':not failures,'failures':failures,'results':results}
(out/'page-type-selection.json').write_text(json.dumps(report,indent=1,ensure_ascii=False)+'\n')
print(json.dumps({'passed':not failures,'checks':len(results),'failures':failures},ensure_ascii=False))
sys.exit(1 if failures else 0)
