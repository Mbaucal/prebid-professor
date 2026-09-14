"""New deployment controls only. Loopback TLS, synthetic jobs, no live requests."""
import json, os, pathlib, subprocess, tempfile, ssl, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright, expect
hostname='prebid-professor-test.mbaucal.workers.dev'
origin='https://'+hostname
out=pathlib.Path('.generated/delivery-evidence');out.mkdir(parents=True,exist_ok=True)
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
                page.get_by_role('link',name='TEST objave i verzije',exact=True).click()
                expect(page.locator('#release')).to_contain_text('tanjug-test-v1')
                expect(page.locator('#publish')).to_be_disabled();expect(page.locator('#save-target')).to_be_enabled()
                check('Missing connection leaves setup usable with a specific explanation',page.locator('#connection').inner_text()=='Automatska veza još nije aktivirana.')
                page.locator('#account').fill('1'*32);page.locator('#project').fill('tessera-fixture');page.locator('#secret').fill('CLOUDFLARE_API_TOKEN_FIXTURE');page.locator('#save-target').click()
                expect(page.locator('#message')).to_have_text('TEST odredište je sačuvano.')
                page.reload();expect(page.locator('#target-summary')).to_contain_text('tessera-fixture')
                check('Saved destination and frozen package survive reload',page.locator('#package-hash').inner_text()=='ec1b1c51c870b8e2a5583666c5e48d215cf8c3d3bc3a27549930510856c0d6d0')
                page.screenshot(path=str(out/'setup.png'),full_page=True)
                # Only the separate loopback harness exposes this synthetic switch.
                result=page.evaluate("fetch('/__fixture/connect',{method:'POST'}).then(r=>r.json())");assert result['synthetic']
                page.locator('#refresh').click();expect(page.locator('#publish')).to_be_enabled()
                page.locator('#publish').click();expect(page.locator('#history')).to_contain_text('Čeka pokretanje');expect(page.locator('#publish')).to_be_disabled()
                check('Queued request is visible and blocks a duplicate click',page.locator('#history article').count()==1)
                result=page.evaluate("fetch('/__fixture/complete',{method:'POST'}).then(r=>r.json())")
                check('Exactly one synthetic job was dispatched',result['dispatches']==1)
                page.locator('#refresh').click();expect(page.locator('#history')).to_contain_text('Objavljeno i provereno')
                check('History shows the immutable version and GitHub run',page.get_by_role('link',name='Otvori ovu TEST verziju').get_attribute('href')=='https://1234abcd.tessera-fixture.pages.dev/implementation.html')
                expect(page.locator('#publish')).to_be_disabled();expect(page.locator('#ready-reason')).to_contain_text('već poslednja')
                page.screenshot(path=str(out/'history-desktop.png'),full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                check('New controls fit a phone viewport',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                page.screenshot(path=str(out/'history-phone.png'),full_page=True)
                check('New UI has no JavaScript errors or external requests',not errors and not external and not nonlocal_responses)
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
