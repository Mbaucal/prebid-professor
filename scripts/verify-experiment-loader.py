"""Synthetic A/B loader, SRI, CSP and dependency ordering. No live ad requests."""
import json, os, pathlib, subprocess, tempfile, ssl, time, urllib.request, urllib.error, urllib.parse, base64
from playwright.sync_api import sync_playwright, expect
hostname='prebid-professor-test.mbaucal.workers.dev'
origin='https://'+hostname
out=pathlib.Path('.generated/experiment-loader-evidence');out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[];external=[];nonlocal_responses=[]
def check(name,ok):
    assert ok,name
    checks.append({'name':name,'passed':True})
def wait_for_state(page,predicate):
    # Poll through the debugger, not waitForFunction's in-page eval. Keep the
    # actual loader page's CSP intact (no unsafe-eval or bypass_csp).
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        if page.evaluate(predicate):return
        page.wait_for_timeout(50)
    raise AssertionError('Timed out waiting for cache loader state: '+predicate)
with tempfile.TemporaryDirectory(prefix='tessera-delivery-tls-') as tls:
    key=pathlib.Path(tls)/'key.pem';cert=pathlib.Path(tls)/'cert.pem'
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),'-subj','/CN='+hostname,'-addext','subjectAltName=DNS:'+hostname],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    process=subprocess.Popen(['node','--experimental-strip-types','scripts/experiment-loader-server.mjs',str(key),str(cert)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for attempt in range(80):
            if process.poll() is not None: raise RuntimeError(process.stderr.read().decode())
            try:
                r=urllib.request.urlopen('https://127.0.0.1:8877/health',context=ssl._create_unverified_context(),timeout=1)
                assert r.headers.get('x-tessera-local-fixture')=='experiment-loader'
                r.read();break
            except (urllib.error.URLError,TimeoutError): time.sleep(.25)
        else: raise RuntimeError('Local harness did not start')
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=os.environ.get('TESSERA_TEST_CHROMIUM'),args=['--no-proxy-server','--disable-quic','--host-resolver-rules=MAP '+hostname+' 127.0.0.1:8877, MAP * ~NOTFOUND'])
            context=browser.new_context(ignore_https_errors=True,viewport={'width':1280,'height':950},service_workers='block')
            def route(r):
                if r.request.url.startswith('https://cache-fixture.invalid/bid?'):
                    rows=json.loads(urllib.parse.parse_qs(urllib.parse.urlparse(r.request.url).query)['payload'][0])
                    bids=[{**x,'creativeId':'synthetic','currency':'USD','netRevenue':True,'ad':'<div>Synthetic</div>','meta':{'advertiserDomains':['example.invalid']}} for x in rows]
                    r.fulfill(status=200,headers={'content-type':'application/json','access-control-allow-origin':'*','x-tessera-local-fixture':'experiment-loader'},body=json.dumps({'bids':bids}));return
                if r.request.url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json?date='):
                    r.fulfill(status=200,headers={'content-type':'application/json','access-control-allow-origin':'*','x-tessera-local-fixture':'experiment-loader'},body=json.dumps({'conversions':{'USD':{'USD':1}}}));return
                if not r.request.url.startswith(origin+'/'): external.append(r.request.url);r.abort()
                else: r.continue_()
            context.route('**/*',route)
            page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('response',lambda r:nonlocal_responses.append(r.url) if r.header_value('x-tessera-local-fixture')!='experiment-loader' else None)
            try:
                for name,variant,label in [('a','A','A'),('b','B','B'),('aa','B','A'),('stopped','A','A')]:
                    page.goto(origin+'/case/'+name+'/')
                    page.wait_for_function("window.__tesseraExperiments?.['tanjug-test']?.status==='loaded'")
                    result=page.evaluate("({count:window.fixtureExecutions,prebid:window.fixturePrebid,label:window.fixtureLabel,snapshot:window.__tesseraExperiments['tanjug-test'].snapshot()})")
                    check(name+': exactly one selected wrapper and matching dependency',result['count']==1 and result['prebid']==label and result['label']==label and result['snapshot']['context']['variant']==variant)
                    check(name+': assignment recorded before dependency and script load',[e['type'] for e in result['snapshot']['events']]==['assigned','prebid-loaded','script-loaded'])
                    page.evaluate("{const s=document.createElement('script');s.src='ads.js';s.nonce='fixture';document.head.append(s);}")
                    page.wait_for_load_state('networkidle')
                    check(name+': duplicate and SPA reinsertion cannot restart runtime',page.evaluate('window.fixtureExecutions')==1)
                measured_results=[]
                for name,variant in [('measureda','A'),('measuredb','B')]:
                    page.goto(origin+'/case/'+name+'/')
                    page.wait_for_function("window.__tesseraExperiments?.['test-site']?.status==='loaded' && requestLabels.some(r=>r.id==='Billboard') && requestLabels.some(r=>r.id==='adsx-takeover-slot')")
                    result=page.evaluate("({context:__tesseraExperiments['test-site'].context,measurement:__tesseraGamMeasurement['test-site'].snapshot(),runtime:__tesseraRuntimeDiagnostics['test-site'].snapshot(),labels:requestLabels})")
                    measured_results.append(result)
                    expected='d'+result['context']['deliverySha256'][:32]+'_'+variant.lower()
                    check(name+': original compiled 3.12 package runs once with correct request labels',result['context']['runtimeVersion']=='3.12.0-tessera.preview.1' and result['context']['variant']==variant and result['runtime']['initializations']==1 and all(r['value']==[expected] for r in result['labels']))
                    page.evaluate("__testAds.service.refresh([adSlots.Billboard])")
                    check(name+': refresh keeps assignment',page.evaluate('requestLabels.at(-1).value')==[expected])
                    report=page.evaluate('() => {'+pathlib.Path('src/debug/experiment-inspect.mjs').read_text().split('export const experimentInspectCommand=')[0].replace('export function inspectExperiments()', 'function inspectExperiments()')+'\nreturn inspectExperiments();}')
                    check(name+': inspector joins loader runtime and measurement',report['experiments'][0]['variant']==variant and report['gamMeasurement'][0]['value']==expected and report['runtimeDiagnostics'][0]['runtimeEntries']==1)
                left,right=measured_results
                check('Measured A/A uses identical package and delivery identity for both arms',left['context']['packageSha256']==right['context']['packageSha256'] and left['context']['deliverySha256']==right['context']['deliverySha256'] and left['measurement']['value']!=right['measurement']['value'])
                cached_results=[]
                for name,variant in [('cachea','A'),('cacheb','B')]:
                    page.goto(origin+'/case/'+name+'/')
                    wait_for_state(page,"() => window.__tesseraExperiments?.['test-site']?.status==='loaded' && window.fixtureRequests?.some(r=>r.id==='Billboard') && fixtureRequests.some(r=>r.id==='adsx-takeover-slot')")
                    page.evaluate("fixtureIntersect('P1','500px')")
                    wait_for_state(page,"() => fixtureBids.filter(b=>b.code==='P1').length===2")
                    assert page.evaluate("adSlots.P1.getTargeting('hb_adid')")==[]
                    page.evaluate("fixtureIntersect('P1','0px')")
                    wait_for_state(page,"() => fixtureRequests.some(r=>r.id==='P1')")
                    result=page.evaluate("({context:__tesseraExperiments['test-site'].context,events:__tesseraExperiments['test-site'].snapshot().events,cache:__tesseraBidCache['test-site'].snapshot(),runtime:__tesseraRuntimeDiagnostics['test-site'].snapshot(),requests:fixtureRequests})")
                    cached_results.append(result);expected='d'+result['context']['deliverySha256'][:32]+'_'+variant.lower()
                    check(name+': stored 3.13 package and exact native Prebid load once with saved policy',result['context']['runtimeVersion']=='3.13.0' and result['context']['variant']==variant and result['runtime']['initializations']==1 and result['cache']['policy']['mode']=='auction-with-cache' and result['cache']['policy']['maxAgeSeconds']==60)
                    check(name+': initial TakeOver and lazy requests carry correct A/A labels',all(r['experiment']==[expected] and r['cpm']==10 and r['status']=='targetingSet' for r in result['requests']))
                    check(name+': dependency loads before wrapper with exact SRI',[e['type'] for e in result['events']]==['assigned','prebid-loaded','script-loaded'] and page.locator('script[src$="/prebid.js"]').get_attribute('integrity')=='sha256-'+base64.b64encode(bytes.fromhex('384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b')).decode())
                    page.evaluate("{const s=document.createElement('script');s.src='ads.js';s.nonce='fixture';document.head.append(s);}")
                    page.wait_for_load_state('networkidle')
                    check(name+': reinsertion does not restart auctions or wrapper',page.evaluate('fixtureRequests.length')==len(result['requests']) and page.evaluate("__tesseraRuntimeDiagnostics['test-site'].snapshot().initializations")==1)
                    report=page.evaluate('() => {'+pathlib.Path('src/debug/experiment-inspect.mjs').read_text().split('export const experimentInspectCommand=')[0].replace('export function inspectExperiments()', 'function inspectExperiments()')+'\nreturn inspectExperiments();}')
                    check(name+': inspector joins new cache policy and assignment',report['experiments'][0]['variant']==variant and report['cacheDiagnostics'][0]['mode']=='auction-with-cache')
                left,right=cached_results
                check('Stored 3.13 A/A preserves identical package and delivery in both arms',left['context']['packageSha256']==right['context']['packageSha256'] and left['context']['deliverySha256']==right['context']['deliverySha256'])
                for name,status,event in [('corrupt','load-error','load-error'),('corruptads','load-error','load-error'),('blocked','load-error','load-error'),('legacy','conflict','conflict')]:
                    page.goto(origin+'/case/'+name+'/')
                    page.wait_for_function("window.__tesseraExperiments?.['tanjug-test']?.status==="+json.dumps(status))
                    result=page.evaluate("({count:window.fixtureExecutions||0,snapshot:window.__tesseraExperiments['tanjug-test'].snapshot()})")
                    check(name+': fails closed without another wrapper',result['count']==0 and [e['type'] for e in result['snapshot']['events']]==(['assigned','prebid-loaded',event] if name=='corruptads' else ['assigned',event]))
                check('No page JavaScript errors or external requests',not errors and not external and not nonlocal_responses)
            except Exception:
                page.screenshot(path=str(out/'failure.png'),full_page=True)
                failure={'checks':checks,'pageErrors':errors,'external':external,'text':page.locator('body').inner_text()[:2500]}
                (out/'failure.json').write_text(json.dumps(failure,indent=2));print(json.dumps(failure,indent=2));raise
            finally: browser.close()
        report={'scope':'LOCAL Chromium + actual experimental loader and synthetic packages; NOT hosted or real auctions','checks':checks,'passed':len(checks),'failed':0}
        (out/'browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill();process.wait()
