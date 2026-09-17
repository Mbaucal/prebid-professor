"""Synthetic A/B loader, SRI, CSP and dependency ordering. No live ad requests."""
import json, os, pathlib, subprocess, tempfile, ssl, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright, expect
hostname='prebid-professor-test.mbaucal.workers.dev'
origin='https://'+hostname
out=pathlib.Path('.generated/experiment-loader-evidence');out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[];external=[];nonlocal_responses=[]
def check(name,ok):
    assert ok,name
    checks.append({'name':name,'passed':True})
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
                for name,status,event in [('corrupt','load-error','load-error'),('corruptads','load-error','load-error'),('blocked','load-error','load-error'),('legacy','conflict','conflict')]:
                    page.goto(origin+'/case/'+name+'/')
                    page.wait_for_function("window.__tesseraExperiments?.['tanjug-test']?.status==="+json.dumps(status))
                    result=page.evaluate("({count:window.fixtureExecutions||0,snapshot:window.__tesseraExperiments['tanjug-test'].snapshot()})")
                    check(name+': fails closed without another wrapper',result['count']==0 and [e['type'] for e in result['snapshot']['events']]==(['assigned','prebid-loaded',event] if name=='corruptads' else ['assigned',event]))
                check('No page JavaScript errors or external requests',not errors and not external and not nonlocal_responses)
            except Exception:
                page.screenshot(path=str(out/'failure.png'),full_page=True)
                (out/'failure.json').write_text(json.dumps({'checks':checks,'pageErrors':errors,'text':page.locator('body').inner_text()[:2500]},indent=2));raise
            finally: browser.close()
        report={'scope':'LOCAL Chromium + actual experimental loader and synthetic packages; NOT hosted or real auctions','checks':checks,'passed':len(checks),'failed':0}
        (out/'browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill();process.wait()
