"""New experiment controls only. Loopback TLS, synthetic jobs, no live requests."""
import json, os, pathlib, subprocess, tempfile, ssl, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright, expect
hostname='prebid-professor-test.mbaucal.workers.dev'
origin='https://'+hostname
out=pathlib.Path('.generated/experiment-evidence');out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[];external=[];nonlocal_responses=[]
def check(name,ok):
    assert ok,name
    checks.append({'name':name,'passed':True})
with tempfile.TemporaryDirectory(prefix='tessera-delivery-tls-') as tls:
    key=pathlib.Path(tls)/'key.pem';cert=pathlib.Path(tls)/'cert.pem'
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),'-subj','/CN='+hostname,'-addext','subjectAltName=DNS:'+hostname],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    process=subprocess.Popen(['node','--experimental-strip-types','scripts/deployment-ui-server.mjs',str(key),str(cert)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for attempt in range(80):
            if process.poll() is not None: raise RuntimeError(process.stderr.read().decode())
            try:
                r=urllib.request.urlopen('https://127.0.0.1:8877/login',context=ssl._create_unverified_context(),timeout=1)
                assert r.headers.get('x-tessera-local-fixture')=='delivery-synthetic'
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
            page.on('response',lambda r:nonlocal_responses.append(r.url) if r.header_value('x-tessera-local-fixture')!='delivery-synthetic' else None)
            try:
                page.goto(origin+'/login');page.locator('#email').fill('tester@example.invalid');page.locator('#password').fill('Local-fixture-only-password-927!');page.get_by_role('button',name='Sign in',exact=True).click()
                page.get_by_role('link',name='A/B TEST',exact=True).click()
                expect(page.locator('#release-a')).to_contain_text('tanjug-test-v1')
                expect(page.locator('#comparison')).to_contain_text('A/A check')
                expect(page.locator('#inspect-code')).to_have_value(__import__('re').compile('inspectExperiments'))
                expect(page.locator('#copy-inspect')).to_be_visible()
                page.locator('#save').click();expect(page.locator('#history')).to_contain_text('Saved')
                page.get_by_role('button',name='Prepare GAM values',exact=True).click()
                expect(page.locator('#history')).to_contain_text('Measurement unavailable for these versions')
                page.locator('#history details summary').click()
                expect(page.locator('#history')).to_contain_text('Variant A has no verified measurement support')
                check('Legacy A/A stays explicitly unmeasured and cannot export misleading GAM values',page.get_by_role('link',name='Download GAM values (CSV)').count()==0)
                stale=context.new_page();stale.goto(origin+'/experiments');expect(stale.locator('#history')).to_contain_text('Saved')
                page.get_by_role('button',name='Start preview',exact=True).click()
                expect(page.locator('#history')).to_contain_text('Running preview')
                stale.locator('#save').click();expect(stale.locator('#message')).to_contain_text('Refresh')
                check('Stale tab cannot overwrite newer history',stale.locator('#history article').count()==1)
                stale.close()
                page.reload();expect(page.locator('#history')).to_contain_text('Running preview')
                check('Started experiment survives reload',page.locator('#history article').count()==1)
                page.locator('#traffic').fill('10');page.locator('#save').click()
                expect(page.locator('#history article')).to_have_count(2)
                expect(page.locator('#history article').nth(1)).to_contain_text('50% to B')
                expect(page.get_by_role('button',name='Start preview',exact=True)).to_be_disabled()
                check('Saving new rules leaves running allocation pinned', 'Running preview' in page.locator('#history article').nth(1).inner_text())
                page.get_by_role('button',name='Stop preview',exact=True).click()
                expect(page.locator('#history article').nth(1)).to_contain_text('Stopped')
                page.locator('#history article').first.get_by_role('button',name='Start preview',exact=True).click()
                expect(page.locator('#history article').first).to_contain_text('Running preview')
                check('Explicit Stop then Start selects the new allocation','10% to B' in page.locator('#history article').first.inner_text())
                page.evaluate("""async()=>{
                  async function call(path,body){const r=await fetch('/test-api/'+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v;}
                  await call('setup',{confirm:'prepare-empty-test-database'});
                  const state=await call('runtime-selection'),runtime=state.runtimes.find(r=>r.version==='3.12.0-tessera.preview.1');
                  await call('runtime-selection',{expectedRevision:state.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
                  const packages=await call('site-packages');
                  await call('site-packages',{action:'generate',revision:packages.revision,notes:'Reporting UI fixture'});
                }""")
                page.locator('#refresh').click()
                expect(page.locator('#message')).to_contain_text('history refreshed')
                page.locator('#site').select_option('test-site')
                page.locator('#collect-assignments').check()
                page.locator('#save').click()
                expect(page.locator('#history article')).to_have_count(1)
                page.get_by_role('button',name='Prepare GAM values',exact=True).click()
                expect(page.locator('#history')).to_contain_text('GAM values prepared')
                page.locator('#history details summary').click()
                expect(page.locator('#history')).to_contain_text('GAM key: tessera_ab')
                with page.expect_download() as download:
                    page.get_by_role('link',name='Download GAM values (CSV)',exact=True).click()
                csv=pathlib.Path(download.value.path()).read_text()
                check('Measured A/A exports exact A/B labels with full identity', 'tessera_ab' in csv and '_a' in csv and '_b' in csv and 'deliverySha256' in csv and '3.12.0-tessera.preview.1' in csv)
                page.get_by_role('button',name='Show received assignments',exact=True).click()
                expect(page.locator('#history')).to_contain_text('A: 0 received')
                page.locator('#history details summary').click()
                check('Preparing reports does not start ads or claim connected revenue',page.get_by_role('button',name='Start preview',exact=True).is_enabled() and page.evaluate('typeof window.__TESSERA_RUNTIME_STARTED')=='undefined' and 'Revenue reporting and real traffic coverage are not verified' in page.locator('#history').inner_text())
                page.screenshot(path=str(out/'history-desktop.png'),full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                check('Experiment controls fit a phone viewport',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                page.screenshot(path=str(out/'history-phone.png'),full_page=True)
                page.set_viewport_size({'width':1280,'height':950})
                page.get_by_role('link',name='Review GAM report',exact=True).click()
                expect(page.get_by_role('heading',name='Review GAM report',exact=True)).to_be_visible()
                report_plan=page.locator('#report-plan').text_content();report_plan=json.loads(report_plan)
                page.locator('details summary').click()
                with page.expect_download() as download:
                    page.get_by_role('link',name='Download CSV template',exact=True).click()
                template=pathlib.Path(download.value.path()).read_text()
                check('Report template binds both values without inventing zero metrics',all(v in template for v in report_plan['values']) and 'YYYY-MM-DD' in template)
                page.locator('#start-date').fill('2026-09-15');page.locator('#end-date').fill('2026-09-15')
                page.locator('#currency').fill('EUR');page.locator('#time-zone').fill('UTC')
                page.locator('#revenue-basis').select_option('net');page.locator('#revenue-metric').select_option('total')
                header='date,value,impressions,revenue,adRequests,responsesServed,measurableImpressions,viewableImpressions\n'
                a='2026-09-15,'+report_plan['values'][0]+',100,1.100001,200,150,80,60\n'
                b='2026-09-15,'+report_plan['values'][1]+',200,3.200002,400,300,160,120\n'
                def upload_report(content):
                    page.locator('#report-file').set_input_files({'name':'synthetic-gam.csv','mimeType':'text/csv','buffer':content.encode()})
                    page.locator('#analyze').click()
                upload_report(header+a+b)
                expect(page.locator('#report-summary')).to_contain_text('Daily report rows complete')
                expect(page.locator('#blockers')).to_contain_text('Total assignment coverage is unknown')
                expect(page.locator('#metrics')).to_contain_text('1.100001')
                with page.expect_download() as download:
                    page.get_by_role('button',name='Download review (JSON)',exact=True).click()
                review=json.loads(pathlib.Path(download.value.path()).read_text())
                check('GAM preview exports exact totals but never a winner or unverified page RPM',review['totals']['A']['revenueMicros']==1100001 and review['totals']['B']['revenueMicros']==3200002 and review['winner'] is None and review['revenueReady'] is False and review['totals']['A']['pageRpm'] is None)
                upload_report(header+a+a+b)
                expect(page.locator('#message')).to_contain_text('Duplicate day/variant')
                expect(page.locator('#results')).to_be_hidden()
                check('Rejected import clears the previous review',page.locator('#download').is_hidden())
                upload_report(header+a)
                expect(page.locator('#report-summary')).to_contain_text('Report incomplete')
                expect(page.locator('#missing')).to_contain_text('Missing rows: 1')
                expect(page.locator('#metrics')).to_contain_text('Unavailable')
                page.locator('#time-zone').fill('Europe/Belgrade');expect(page.locator('#results')).to_be_hidden()
                page.locator('#analyze').click();expect(page.locator('#blockers')).to_contain_text('time zones do not align')
                check('Missing rows and mismatched time zones remain explicit',page.locator('#missing').inner_text().endswith('2026-09-15 B'))
                check('Import preview never executes an ad runtime',page.evaluate('typeof window.__TESSERA_RUNTIME_STARTED')=='undefined')
                page.screenshot(path=str(out/'report-desktop.png'),full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                check('GAM review fits a phone viewport',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                page.screenshot(path=str(out/'report-phone.png'),full_page=True)
                check('No JavaScript errors or external requests',not errors and not external and not nonlocal_responses)
            except Exception:
                page.screenshot(path=str(out/'failure.png'),full_page=True)
                (out/'failure.json').write_text(json.dumps({'checks':checks,'pageErrors':errors,'text':page.locator('body').inner_text()[:2500]},indent=2));raise
            finally: browser.close()
        report={'scope':'LOCAL browser + actual Worker, synthetic R2 and GitHub jobs; NOT hosted deployment','checks':checks,'passed':len(checks),'failed':0}
        (out/'browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill();process.wait()
