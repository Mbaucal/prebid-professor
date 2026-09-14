"""Real Chromium -> actual Worker handler -> real local SQLite, fake R2.
All target traffic INCLUDING redirect chains is resolved to loopback TLS.
No Cloudflare API, real credentials, external ad libraries or publisher requests.
"""
import json
import os
import re
import pathlib
import subprocess
import tempfile
import ssl
import time
import urllib.request
import urllib.error
import urllib.parse
import zipfile
import io
from playwright.sync_api import sync_playwright, expect

hostname='prebid-professor-test.mbaucal.workers.dev'
origin='https://'+hostname
out=pathlib.Path('.generated/tanjug-pilot-evidence')
out.mkdir(parents=True,exist_ok=True)
checks=[]
external=[]
http_events=[]
page_errors=[]
nonlocal_responses=[]
def check(name,condition):
    assert condition,name
    checks.append({'name':name,'passed':True})

def exercise(page):
    page.goto(origin+'/login')
    page.locator('#email').fill('tester@example.invalid')
    page.locator('#password').fill('Local-fixture-only-password-927!')
    page.get_by_role('button',name='Sign in',exact=True).click()
    page.get_by_role('link',name='Tanjug TEST paket').click()
    expect(page.get_by_role('heading',name='Tanjug paket je spreman za probu')).to_be_visible()
    with page.expect_download() as download:
        page.get_by_role('link',name='Preuzmi Tanjug ZIP',exact=True).click()
    original=pathlib.Path('.generated/tanjug-pilot/tanjug-test-v1.zip').read_bytes()
    check('Authenticated download matches frozen Tanjug package byte for byte',pathlib.Path(download.value.path()).read_bytes()==original)
    for mode,width in [('desktop',1920),('mobile',390)]:
        page.set_viewport_size({'width':width,'height':900})
        page.locator('#'+mode).click()
        frame=page.frame_locator('#pilot-preview')
        expect(frame.locator('#Billboard iframe')).to_be_visible(timeout=15000)
        expect(frame.locator('#Sticky iframe')).to_be_visible(timeout=15000)
        inner=next(f for f in page.frames if f.url.endswith('/pilot/tanjug/preview'))
        check(mode+' opaque origin cannot access parent or cookies',inner.evaluate("""() => {let parentBlocked=false,cookieBlocked=false;try{void parent.document}catch(e){parentBlocked=true}try{void document.cookie}catch(e){cookieBlocked=true}return parentBlocked&&cookieBlocked}"""))
        check(mode+' no TakeOver or codeless request',inner.evaluate("!__testAds.slots.some(s=>s.id==='adsx-takeover-slot'||s.id==='interstitial-guard')"))
        for unit in ['Billboard_2','P2','InText_1']:
            frame.locator('#'+unit).scroll_into_view_if_needed()
            expect(frame.locator('#'+unit+' iframe')).to_be_visible(timeout=15000)
        check(mode+' lazy positions run the generated runtime with four Tanjug bidders',inner.evaluate("""() => __testAds.observations.bids.some(b=>b.adUnits.some(u=>u.code==='InText_1'&&u.bids.length===4))"""))
        check(mode+' all GAM requests retain Tanjug path',inner.evaluate("__testAds.observations.requests.every(r=>r.path.startsWith('/22852026051/Tanjug.rs-Display/'))"))
        check(mode+' preview fits viewport',inner.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        inner.evaluate('scrollTo(0,0)')
        page.locator('#pilot-preview').scroll_into_view_if_needed()
        page.screenshot(path=str(out/('tanjug-'+mode+'.png')),full_page=True)
        check(mode+' sticky close control works',inner.evaluate("""() => {const b=document.querySelector('#close_sticky_ad');if(!b)return false;b.click();return !document.getElementById('Sticky').classList.contains('ad-loaded');}"""))
    check('No external requests or third party responses',not external and not nonlocal_responses)
    check('No page JavaScript errors',not page_errors)

with tempfile.TemporaryDirectory(prefix='tessera-local-tls-') as tls:
    key=pathlib.Path(tls)/'key.pem'
    cert=pathlib.Path(tls)/'cert.pem'
    # Ephemeral test certificate is never committed or included in artifacts.
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
                    '-keyout',str(key),'-out',str(cert),'-subj','/CN='+hostname,
                    '-addext','subjectAltName=DNS:'+hostname],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    process=subprocess.Popen(['node','--experimental-strip-types','scripts/test-workspace-server.mjs',str(key),str(cert)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for attempt in range(80):
            if process.poll() is not None:
                raise RuntimeError('Local workspace server exited: '+process.stderr.read().decode())
            try:
                response=urllib.request.urlopen('https://127.0.0.1:8877/login',context=ssl._create_unverified_context(),timeout=1)
                assert response.headers.get('x-tessera-local-fixture')=='sqlite-fake-r2'
                response.read()
                break
            except (urllib.error.URLError,TimeoutError):
                time.sleep(.25)
        else:
            raise RuntimeError('Local workspace server did not start')
        with sync_playwright() as playwright:
            # Interception alone does not capture all redirect hops. Pin DNS at
            # the network layer; every other hostname fails resolution.
            browser=playwright.chromium.launch(headless=True,executable_path=os.environ.get('TESSERA_TEST_CHROMIUM'),args=[
                '--no-proxy-server','--disable-quic',
                '--host-resolver-rules=MAP '+hostname+' 127.0.0.1:8877, MAP * ~NOTFOUND'])
            context=browser.new_context(viewport={'width':1280,'height':900},accept_downloads=True,ignore_https_errors=True,service_workers='block')
            def handle(route):
                if not route.request.url.startswith(origin+'/'):
                    external.append(urllib.parse.urlsplit(route.request.url).hostname)
                    route.abort()
                else:
                    route.continue_()
            context.route('**/*',handle)
            page=context.new_page()
            def inspect_response(response):
                path=urllib.parse.urlsplit(response.url).path
                local=response.header_value('x-tessera-local-fixture')=='sqlite-fake-r2'
                if not local:
                    nonlocal_responses.append(path)
                http_events.append({'method':response.request.method,'path':path,'status':response.status,'localFixture':local})
            page.on('response',inspect_response)
            page.on('pageerror',lambda error:page_errors.append(str(error)[:500]))
            try:
                exercise(page)
            except Exception:
                # Synthetic visible UI only; never input values, request bodies,
                # authentication headers/cookies, review receipts or TLS keys.
                page.screenshot(path=str(out/'failure.png'),full_page=True)
                diagnostic={'scope':'LOCAL LOOPBACK TLS HARNESS','path':urllib.parse.urlsplit(page.url).path,
                            'visibleText':page.locator('body').inner_text()[:3000],
                            'http':http_events,'pageErrors':page_errors,'checks':checks,'failed':1}
                (out/'failure.json').write_text(json.dumps(diagnostic,indent=2))
                print(json.dumps(diagnostic,indent=2))
                raise
            finally:
                browser.close()
        report={'scope':'loopback TLS + actual Worker handler + SQLite + fake R2, real Chromium; NOT a hosted Cloudflare test',
                'checks':checks,'externalRequests':external,'nonlocalResponses':nonlocal_responses,'http':http_events,'passed':len(checks),'failed':0}
        (out/'report.json').write_text(json.dumps(report,indent=2))
        print(json.dumps(report,indent=2))
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill();process.wait()
