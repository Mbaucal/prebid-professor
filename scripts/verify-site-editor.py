"""Real Chromium -> actual Worker handler -> real local SQLite, fake R2.
All target traffic INCLUDING redirect chains is resolved to loopback TLS.
No Cloudflare API, real credentials, external ad libraries or publisher requests.
"""
import json
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
out=pathlib.Path('.generated/site-editor-evidence')
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
    page.locator('#initialize').wait_for(state='visible')
    page.locator('#initialize').click()
    page.locator('#generate').wait_for(state='visible')
    page.get_by_role('link',name='Script version',exact=True).click()
    expect(page.locator('#runtime')).to_be_enabled()
    page.locator('#runtime').select_option('0')
    page.locator('#allow-preview').check()
    page.locator('#save-selection').click()
    expect(page.locator('#saved')).to_contain_text('Saved selection:')
    page.get_by_role('link',name='Site and ad positions').click()
    expect(page.locator('#editor-message')).to_contain_text('Saved test settings loaded')
    check('Site editor reachable from Script version without a manual URL',True)
    second=page.context.new_page()
    try:
        second.goto(origin+'/site-settings')
        expect(second.locator('#editor-message')).to_contain_text('Saved test settings loaded')
        page.get_by_label('Site name',exact=True).fill('Publisher pilot copy')
        page.get_by_label('Domain',exact=True).fill('pilot.example.invalid')
        page.get_by_label('GAM path',exact=True).fill('/123/pilot/')
        page.locator('#add-position').click()
        page.get_by_label('Position ID',exact=True).last.fill('InText1')
        page.get_by_label('Allowed sizes',exact=True).first.fill('300x600, 300x250')
        page.locator('#confirm-draft').check()
        page.locator('#save-site').click()
        expect(page.locator('#editor-message')).to_contain_text('Site settings saved')
        check('Site identity, new position and size changes save through authenticated API',True)
        second.locator('#confirm-draft').check()
        with second.expect_response(lambda r: '/test-api/site-settings' in r.url and r.request.method=='POST') as response:
            second.locator('#save-site').click()
        check('Stale browser tab cannot overwrite site edit',response.value.status==409)
        expect(second.locator('#save-site')).to_be_disabled()
        second.locator('#reload-site').click()
        expect(second.get_by_label('Domain',exact=True)).to_have_value('pilot.example.invalid')
    finally:
        second.close()
    page.reload()
    expect(page.get_by_label('Domain',exact=True)).to_have_value('pilot.example.invalid')
    expect(page.get_by_label('Position ID',exact=True).last).to_have_value('InText1')
    check('Edited configuration survives browser reload',True)
    page.locator('#confirm-draft').check()
    page.locator('#save-site').click()
    expect(page.locator('#editor-message')).to_contain_text('already saved')
    check('Repeated unchanged editor save reports no change',True)
    page.screenshot(path=str(out/'site-desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    check('Site editor fits mobile width',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.screenshot(path=str(out/'site-mobile.png'),full_page=True)
    page.get_by_role('link',name='Back to Generate').click()
    page.locator('#generate').wait_for(state='visible')
    page.locator('#takeover').check()
    page.locator('#generate').click()
    page.locator('#review').wait_for(state='visible',timeout=90000)
    source=page.locator('#source').text_content()
    check('Generated code contains saved position, size and GAM path','InText1' in source and '/123/pilot/' in source and re.search(r'\b300\s*,\s*600\b',source) is not None)
    check('Generated code was not executed',page.evaluate('typeof window.takeOverDebug')=='undefined')
    page.locator('#ack').check()
    page.locator('#save').click()
    expect(page.locator('#releases article')).to_have_count(1,timeout=90000)
    with page.expect_download() as download:
        page.get_by_role('link',name='Download saved ZIP').click()
    with zipfile.ZipFile(io.BytesIO(pathlib.Path(download.value.path()).read_bytes())) as archive:
        check('Saved ZIP retains exactly the reviewed script with new settings',archive.read('ads.js').decode()==source)
    check('No external ad or third-party requests',not external and not nonlocal_responses)
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
            browser=playwright.chromium.launch(headless=True,args=[
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
