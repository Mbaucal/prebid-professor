"""Real Chromium -> actual Worker handler -> real local SQLite, fake R2.
All target traffic INCLUDING redirect chains is resolved to loopback TLS.
No Cloudflare API, real credentials, external ad libraries or publisher requests.
"""
import json
from position_editor_actions import add_takeover_position
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
out=pathlib.Path('.generated/test-workspace-evidence')
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
    navigation=page.goto(origin+'/')
    page.wait_for_url(origin+'/login')
    policy=navigation.header_value('content-security-policy') or ''
    check('CSP remains enabled without unsafe-eval',"script-src 'self'" in policy and 'unsafe-eval' not in policy)
    expect(page.get_by_role('heading',name='Sign in to test')).to_be_visible()
    check('Signed-out redirect reaches LOCAL test login',not nonlocal_responses)
    page.locator('#email').fill('tester@example.invalid')
    page.locator('#password').fill('Local-fixture-only-password-927!')
    page.get_by_role('button',name='Sign in',exact=True).click()
    page.wait_for_url(origin+'/')
    page.locator('#initialize').wait_for(state='visible')
    page.locator('#initialize').click()
    page.locator('#generate').wait_for(state='visible')
    check('Explicit setup unlocks generator',page.locator('#generator').is_visible())
    page.goto(origin+'/runtime-selection')
    expect(page.locator('#runtime')).to_be_enabled()
    check('Selection requires explicit version and Preview opt-in',page.locator('#save-selection').is_disabled())
    second=page.context.new_page()
    second.on('response',inspect_response)
    second.on('pageerror',lambda error:page_errors.append(str(error)[:500]))
    try:
        second.goto(origin+'/runtime-selection')
        expect(second.locator('#runtime')).to_be_enabled()
        page.locator('#runtime').select_option('0')
        check('Preview opt-in is not preselected',page.locator('#save-selection').is_disabled())
        page.locator('#allow-preview').check()
        expect(page.locator('#release-history article')).to_have_count(len(json.loads(pathlib.Path('worker/runtime/runtime-releases.json').read_text())))
        expect(page.locator('#release-history article[data-available="true"]')).to_have_count(4)
        for row in page.locator('#release-history article[data-available="false"]').all():
            expect(row).to_contain_text('Not selectable')
        writes_before=sum(event['method']=='POST' for event in http_events)
        page.get_by_role('link',name='View version history').click()
        page.locator('#release-history article').last.locator('summary').click()
        check('Version history distinguishes current and earlier builds without changing the choice',page.locator('#runtime').input_value()=='0' and page.locator('#allow-preview').is_checked() and writes_before==sum(event['method']=='POST' for event in http_events))
        page.locator('#save-selection').click()
        expect(page.locator('#message')).to_contain_text('Runtime selection saved')
        check('Selection writes through the authenticated API','Saved selection:' in page.locator('#saved').inner_text())
        second.locator('#runtime').select_option('0')
        second.locator('#allow-preview').check()
        with second.expect_response(lambda r: urllib.parse.urlsplit(r.url).path=='/test-api/runtime-selection' and r.request.method=='POST') as stale_response:
            second.locator('#save-selection').click()
        check('Stale second tab cannot overwrite current settings',stale_response.value.status==409)
        expect(second.locator('#save-selection')).to_be_disabled()
        check('Conflict needs explicit reload before another save',second.locator('#reload-selection').is_enabled())
        second.locator('#reload-selection').click()
        expect(second.locator('#runtime')).to_be_enabled()
        second.locator('#allow-preview').check()
        second.locator('#save-selection').click()
        expect(second.locator('#message')).to_contain_text('already saved')
        check('Reloaded same selection is idempotent',True)
    finally:
        second.close()
    page.reload()
    expect(page.locator('#saved')).to_contain_text('Saved selection:')
    check('Selected version survives page reload',bool(page.locator('#runtime').input_value()))
    expect(page.locator('#release-history article[data-saved="true"]')).to_contain_text('Saved on this site')
    check('Version history marks the exact saved build after reload',page.locator('#release-history article[data-saved="true"][data-available="true"]').count()==1)
    page.screenshot(path=str(out/'selection-desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    check('Selection screen fits mobile without horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.screenshot(path=str(out/'selection-mobile.png'),full_page=True)
    page.set_viewport_size({'width':1280,'height':900})
    page.get_by_role('link',name='Back to Generate').click()
    page.locator('#generate').wait_for(state='visible')
    page.get_by_role('link',name='Ad positions and TakeOver',exact=True).click()
    page.locator('#add-position').wait_for(state='visible')
    add_takeover_position(page)
    page.locator('#confirm-draft').check()
    page.locator('#save-site').click()
    expect(page.locator('#editor-message')).to_contain_text('Site settings saved')
    page.get_by_role('link',name='Back to Generate',exact=True).click()
    expect(page.locator('#takeover-summary')).to_contain_text('TakeOver: ON')
    page.locator('#generate').click()
    page.locator('#review').wait_for(state='visible',timeout=90000)
    source=page.locator('#source').text_content()
    check('Generated JS is shown as text only','takeOver' in source and page.evaluate('typeof window.takeOverDebug')=='undefined')
    check('Save requires review acknowledgement',page.locator('#save').is_disabled())
    page.locator('#ack').check()
    page.locator('#note').fill('Browser test · TakeOver')
    page.locator('#save').click()
    expect(page.locator('#releases article')).to_have_count(1,timeout=90000)
    # Locator assertions retry without evaluating a string predicate in the
    # page. Do NOT bypass or relax the application's Content Security Policy.
    expect(page.locator('#save')).to_be_enabled(timeout=90000)
    with page.expect_response(lambda r: urllib.parse.urlsplit(r.url).path=='/test-api/save' and r.request.method=='POST',timeout=90000) as repeated:
        page.locator('#save').click()
    check('Repeated Save reaches the authenticated API',repeated.value.status==200)
    expect(page.locator('#message')).to_contain_text('already saved',timeout=90000)
    expect(page.locator('#save')).to_be_enabled(timeout=90000)
    check('Repeated Save creates one release',page.locator('#releases article').count()==1)
    page.reload()
    page.get_by_role('button',name='Open saved release').wait_for(state='visible')
    page.get_by_role('button',name='Open saved release').click()
    page.locator('#opened').wait_for(state='visible')
    details=json.loads(page.locator('#opened-details').text_content())
    check('Reopen after reload verifies saved files',details['verified'] is True and details['draft']['publishable'] is False)
    with page.expect_download() as download_info:
        page.get_by_role('link',name='Download saved ZIP').click()
    raw=pathlib.Path(download_info.value.path()).read_bytes()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        check('ZIP contains the exact originally reviewed JS',archive.read('ads.js').decode()==source)
        check('GPT-only package has nine files and no Prebid',len(archive.namelist())==9 and 'prebid.js' not in archive.namelist())
    direct_url=origin+'/test-api/releases/'+details['draft']['id']+'/download'
    with page.expect_download() as direct_download:
        page.goto(direct_url)
    direct_raw=pathlib.Path(direct_download.value.path()).read_bytes()
    check('Existing direct download URL assembles the same ZIP in browser',direct_raw==raw)
    page.goto(origin+'/')
    page.locator('#logout').wait_for(state='visible')
    page.screenshot(path=str(out/'desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    check('Mobile workspace has no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.screenshot(path=str(out/'mobile.png'),full_page=True)
    page.goto(origin+'/runtime-selection')
    expect(page.locator('#runtime')).to_be_enabled()
    page.locator('#runtime').select_option(label='3.12.0-tessera.preview.1 · preview')
    page.locator('#allow-preview').check()
    page.locator('#save-selection').click()
    expect(page.locator('#message')).to_contain_text('Runtime selection saved')
    page.get_by_role('link',name='Back to Generate').click()
    page.locator('#generate').click()
    expect(page.locator('#source')).to_contain_text('__tesseraGamMeasurement',timeout=90000)
    page.locator('#ack').check()
    page.locator('#save').click()
    expect(page.locator('#releases article')).to_have_count(2,timeout=90000)
    check('New measured version is explicitly selected and saved without replacing the old package',page.evaluate('typeof window.__tesseraRuntimeDiagnostics')=='undefined')
    check('No external ad or third-party requests',not external and not nonlocal_responses)
    page.locator('#logout').click()
    page.wait_for_url(origin+'/login')
    expect(page.get_by_role('heading',name='Sign in to test')).to_be_visible()
    check('Logout returns to LOCAL test login',not nonlocal_responses)
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
