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
out=pathlib.Path('.generated/prebid-config-evidence')
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
    page.get_by_role('link',name='Prebid and bidders',exact=True).click()
    expect(page.locator('#editor')).to_be_enabled()
    check('Prebid editor is reachable using existing navigation',True)
    page.locator('#add-bidder').click()
    page.locator('#bidders [data-field="bidder"]').select_option('openx')
    page.locator('#bidders [data-field="params"]').fill('{"unit":"fixture","delDomain":"example.invalid"}')
    page.locator('#enable-prebid').check()
    with page.expect_download() as exported:
        page.locator('#download-config').click()
    configuration=json.loads(pathlib.Path(exported.value.path()).read_text())
    check('Prebid JSON exports before any file, containing only version and automatic modules',set(configuration)=={'version','modules'} and configuration['modules']==['consentManagementTcf','currency','openxBidAdapter','tcfControl'])
    check('Configuration filename is distinct from final site package',exported.value.suggested_filename=='prebid-config.json')
    second=page.context.new_page()
    second.goto(origin+'/prebid-settings')
    expect(second.locator('#editor')).to_be_enabled()
    page.locator('#ack').check()
    page.locator('#save-plan').click()
    expect(page.locator('#message')).to_contain_text('Build preparation saved')
    expect(page.locator('#saved-mode')).to_contain_text('GPT only')
    page.reload()
    expect(page.locator('#enable-prebid')).to_be_checked()
    expect(page.locator('#build')).to_have_value('')
    expect(page.locator('#bidders [data-field="bidder"]')).to_have_value('openx')
    check('Saved preparation survives reload without a file or active mode change',True)
    second.locator('#ack').check()
    second.locator('#save-plan').click()
    expect(second.locator('#message')).to_contain_text('Settings changed')
    expect(second.locator('#save-plan')).to_be_disabled()
    second.close()
    check('Stale preparation cannot overwrite the newer plan',True)
    fixture=('/* prebid.js v'+configuration['version']+'\nModules: '+', '.join(configuration['modules'])+' */\n// inert build fixture').encode()
    page.locator('#upload-file').set_input_files({'name':'prebid.js','mimeType':'application/javascript','buffer':fixture})
    page.locator('#upload').click()
    expect(page.locator('#message')).to_contain_text('File stored')
    expect(page.locator('#build')).to_have_value('')
    build=page.locator('#build option').nth(1).get_attribute('value')
    page.locator('#build').select_option(build)
    expect(page.locator('#plan-state')).to_contain_text('declares the required version and modules')
    page.locator('#ack').check()
    page.locator('#save-prebid').click()
    expect(page.locator('#message')).to_contain_text('Prebid settings saved')
    check('Returned build activates only after its version and module checks',True)
    page.get_by_role('link',name='Back to Generate',exact=True).click()
    page.locator('#generate').click()
    expect(page.locator('#ack')).to_be_visible()
    page.locator('#ack').check()
    page.locator('#save').click()
    expect(page.locator('#message')).to_contain_text('Test release saved')
    with page.expect_download() as downloaded:
        page.get_by_role('link',name='Download saved ZIP',exact=True).click()
    with zipfile.ZipFile(downloaded.value.path()) as z:
        check('Final ZIP has 10 files and preserves the original returned Prebid bytes',len(z.namelist())==10 and z.read('prebid.js')==fixture)
    page.goto(origin+'/prebid-settings')
    expect(page.locator('#editor')).to_be_enabled()
    page.locator('#add-bidder').click()
    page.locator('#bidders .bidder').nth(1).locator('[data-field="bidder"]').select_option('pubmatic')
    page.locator('#bidders .bidder').nth(1).locator('[data-field="params"]').fill('{"publisherId":"fixture"}')
    expect(page.locator('#plan-state')).to_contain_text('pubmaticBidAdapter')
    page.locator('#ack').check()
    page.locator('#save-prebid').click()
    expect(page.locator('#message')).to_contain_text('pubmaticBidAdapter (Bidder: pubmatic)')
    expect(page.locator('#save-prebid')).to_be_enabled()
    check('Changed bidder recalculates requirements and gives a precise recoverable error',True)
    page.evaluate('window.scrollTo(0,0)')
    page.screenshot(path=str(out/'desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    check('Mobile flow has no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'))
    page.screenshot(path=str(out/'mobile.png'),full_page=True)
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
