"""Actual TEST Worker + compiled runtime + mock GPT; loopback only, no live ads."""
import json, os, pathlib, subprocess, tempfile, ssl, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright
hostname='prebid-professor-test.mbaucal.workers.dev'
origin='https://'+hostname
out=pathlib.Path('.generated/experiment-evidence');out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[];external=[]
with tempfile.TemporaryDirectory(prefix='tessera-collection-tls-') as tls:
    key=pathlib.Path(tls)/'key.pem';cert=pathlib.Path(tls)/'cert.pem'
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),'-subj','/CN='+hostname,'-addext','subjectAltName=DNS:'+hostname],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    process=subprocess.Popen(['node','--experimental-strip-types','scripts/deployment-ui-server.mjs',str(key),str(cert)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for attempt in range(80):
            if process.poll() is not None: raise RuntimeError(process.stderr.read().decode())
            try:
                r=urllib.request.urlopen('https://127.0.0.1:8877/login',context=ssl._create_unverified_context(),timeout=1)
                assert r.headers.get('x-tessera-local-fixture')=='delivery-synthetic';r.read();break
            except (urllib.error.URLError,TimeoutError): time.sleep(.25)
        else: raise RuntimeError('Local harness did not start')
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=os.environ.get('TESSERA_TEST_CHROMIUM'),args=['--no-proxy-server','--disable-quic','--host-resolver-rules=MAP '+hostname+' 127.0.0.1:8877, MAP * ~NOTFOUND'])
            context=browser.new_context(ignore_https_errors=True,viewport={'width':1280,'height':950},service_workers='block')
            context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(origin+'/') else (external.append(r.request.url),r.abort()))
            admin=context.new_page();admin.on('pageerror',lambda e:errors.append(str(e)))
            try:
                admin.goto(origin+'/login');admin.locator('#email').fill('tester@example.invalid');admin.locator('#password').fill('Local-fixture-only-password-927!');admin.get_by_role('button',name='Sign in',exact=True).click();admin.wait_for_url(origin+'/')
                saved=admin.evaluate("""async()=>{
                  window.fixtureCall=async(path,body)=>{const r=await fetch('/test-api/'+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v;};
                  await fixtureCall('setup',{confirm:'prepare-empty-test-database'});
                  const state=await fixtureCall('runtime-selection'),runtime=state.runtimes.find(r=>r.version==='3.12.0-tessera.preview.1');
                  await fixtureCall('runtime-selection',{expectedRevision:state.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
                  const packages=await fixtureCall('site-packages');
                  const built=await fixtureCall('site-packages',{action:'generate',revision:packages.revision,notes:'Automatic collection fixture'});
                  const before=await fixtureCall('experiments');
                  const saved=await fixtureCall('experiments/save',{expectedRevision:before.revision,siteId:'test-site',releaseA:built.release.id,releaseB:built.release.id,trafficB:100,collectAssignments:true});
                  const row=saved.experiments.at(-1);
                  const started=await fixtureCall('experiments/start',{expectedRevision:saved.revision,experimentId:row.id});
                  return {id:row.id,revision:started.revision};
                }""")
                def summary():
                    return admin.evaluate("id=>fixtureCall('experiments/collection/'+id+'.json')",saved['id'])
                page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
                attempts=[]
                def lost_ack(route):
                    attempts.append(1)
                    if len(attempts)==1:
                        response=route.fetch();assert response.status==204
                        route.fulfill(status=503,headers={'x-tessera-local-fixture':'delivery-synthetic'},body='Lost acknowledgement fixture')
                    else: route.continue_()
                page.route('**/preview/test-site/collect',lost_ack)
                page.goto(origin+'/__fixture/collection-page')
                page.wait_for_function("__tesseraExperiments?.['test-site']?.snapshot().collection.acknowledgedTypes.includes('script-loaded')")
                s=summary();assert s['totals']['B']['assigned']==1 and s['totals']['B']['scriptLoaded']==1
                assert len(attempts)>=2
                assert page.evaluate("__tesseraRuntimeDiagnostics['test-site'].snapshot().initializations")==1
                assert page.evaluate("__tesseraExperiments['test-site'].snapshot().blockedDuplicates")>=1
                page.evaluate("{const s=document.createElement('script');s.src='/test-api/experiments/preview/test-site/ads.js';document.head.append(s);}")
                page.wait_for_load_state('networkidle');assert summary()['totals']['B']['assigned']==1
                checks.append('Lost HTTP acknowledgement retries the same signed assignment; duplicate/SPA tags do not add a page or second runtime')
                page.close()
                page=context.new_page();page.route('**/releases/*/ads.js',lambda r:r.abort());page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(origin+'/__fixture/collection-page')
                page.wait_for_function("__tesseraExperiments?.['test-site']?.snapshot().collection.acknowledgedTypes.includes('load-error')")
                assert summary()['totals']['B']['loadError']==1;page.close()
                page=context.new_page();page.add_init_script('window.__TESSERA_RUNTIME_STARTED=true;');page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(origin+'/__fixture/collection-page')
                page.wait_for_function("__tesseraExperiments?.['test-site']?.snapshot().collection.acknowledgedTypes.includes('conflict')")
                assert summary()['totals']['B']['conflict']==1;page.close()
                checks.append('Script load failures and existing-runtime conflicts remain in the assignment denominator')
                page=context.new_page();page.route('**/preview/test-site/collect',lambda r:r.abort());page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(origin+'/__fixture/collection-page')
                page.wait_for_function("__tesseraExperiments?.['test-site']?.snapshot().collection.attempts===6 && __tesseraExperiments['test-site'].snapshot().collection.status==='failed'",timeout=30000)
                assert page.evaluate("__tesseraRuntimeDiagnostics['test-site'].snapshot().initializations")==1
                assert summary()['totals']['B']['assigned']==3
                checks.append('Blocked collector stops after six attempts without blocking the runtime or inventing received pages')
                page.close()
                admin.evaluate("s=>fixtureCall('experiments/stop',{expectedRevision:s.revision,experimentId:s.id})",saved)
                page=context.new_page();page.goto(origin+'/__fixture/collection-page')
                page.wait_for_function("__tesseraExperiments?.['test-site']?.status==='loaded'")
                assert page.evaluate("__tesseraExperiments['test-site'].snapshot().collection.status")=='disabled'
                assert summary()['totals']['B']['assigned']==3
                checks.append('Stop disables collection for new pages and preserves previous counts')
                assert not external,external
                assert not errors,errors
                assert summary()['coverage']=='unknown' and summary()['revenueReady'] is False
                checks.append('No external requests or JavaScript errors; sample coverage remains explicitly unknown')
            finally: browser.close()
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill();process.wait()
report={'scope':'Local authenticated TEST Worker and compiled runtime; mock ads only','checks':checks,'passed':len(checks)}
(out/'collection-browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
