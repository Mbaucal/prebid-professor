"""Real Chromium -> actual Worker handler -> real local SQLite, fake R2.
All target traffic INCLUDING redirect chains is resolved to loopback TLS.
No Cloudflare API, real credentials, external ad libraries or publisher requests.
"""
import json
from position_editor_actions import add_takeover_position
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
out=pathlib.Path('.generated/prebid-editor-evidence')
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
    fixture=b'/* prebid.js v11.11.0\nModules: adformBidAdapter, consentManagementTcf, tcfControl, currency */\nwindow.fixtureOnly=true;'
    page.locator('#upload-file').set_input_files({'name':'prebid.js','mimeType':'application/javascript','buffer':fixture})
    page.locator('#upload').click()
    expect(page.locator('#message')).to_contain_text('File stored')
    expect(page.locator('#enable-prebid')).not_to_be_checked()
    expect(page.locator('#build')).to_have_value('')
    check('Upload stores file without silently enabling Prebid or choosing a version',True)
    build=page.locator('#build option').nth(1).get_attribute('value')
    page.locator('#build').select_option(build)
    page.locator('#enable-prebid').check()
    page.locator('#add-bidder').click()
    page.locator('#bidders [data-field="bidder"]').select_option('adform')
    page.locator('#bidders [data-field="params"]').fill('{"mid":123}')
    page.locator('#override-section summary').click()
    page.locator('#add-override').click()
    page.locator('#overrides [data-field="bidder"]').select_option('adform')
    page.locator('#overrides [data-field="scopeType"]').select_option('device')
    page.locator('#overrides [data-field="scopeKey"]').select_option('mobile')
    page.locator('#overrides [data-field="params"]').fill('{"mid":456}')
    page.locator('#bidders [data-field="params"]').fill('{bad-json')
    page.locator('#ack').check()
    page.locator('#save-prebid').click()
    expect(page.locator('#message')).to_contain_text('Check the JSON')
    expect(page.locator('#save-prebid')).to_be_enabled()
    expect(page.locator('#overrides [data-field="params"]')).to_have_value('{"mid":456}')
    check('Correctable local JSON errors preserve unsaved edits and do not lock Save',True)
    page.locator('#bidders [data-field="params"]').fill('[]')
    with page.expect_response(lambda r:'/test-api/prebid-settings' in r.url and r.request.method=='POST') as bad_response:
        page.locator('#save-prebid').click()
    check('Server422 preserves the draft instead of forcing Reload',bad_response.value.status==422)
    expect(page.locator('#save-prebid')).to_be_enabled()
    expect(page.locator('#overrides [data-field="params"]')).to_have_value('{"mid":456}')
    page.locator('#bidders [data-field="params"]').fill('{"mid":123}')
    second=page.context.new_page()
    try:
        second.goto(origin+'/prebid-settings')
        expect(second.locator('#editor')).to_be_enabled()
        page.locator('#ack').check()
        page.locator('#save-prebid').click()
        expect(page.locator('#message')).to_contain_text('Prebid settings saved')
        check('Mode, version, global parameters and device override save together',True)
        second.locator('#ack').check()
        with second.expect_response(lambda r:'/test-api/prebid-settings' in r.url and r.request.method=='POST') as response:
            second.locator('#save-prebid').click()
        check('Stale tab is rejected with409 without overwriting selection',response.value.status==409)
        expect(second.locator('#save-prebid')).to_be_disabled()
    finally:
        second.close()
    page.reload()
    expect(page.locator('#enable-prebid')).to_be_checked()
    expect(page.locator('#build')).to_have_value(build)
    expect(page.locator('#bidders [data-field="params"]')).to_have_value(re.compile('123'))
    check('Reload retains the exact file and saved parameters',True)
    page.locator('#ack').check()
    page.locator('#save-prebid').click()
    expect(page.locator('#message')).to_contain_text('already saved')
    check('Unchanged save is a no-op',True)
    page.screenshot(path=str(out/'prebid-desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    check('Prebid editor fits mobile screen',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.screenshot(path=str(out/'prebid-mobile.png'),full_page=True)
    page.get_by_role('link',name='Back to Generate',exact=True).click()
    page.locator('#generate').wait_for(state='visible')
    page.get_by_role('link',name='Ad positions and TakeOver',exact=True).click()
    page.locator('#add-position').wait_for(state='visible')
    add_takeover_position(page, demand='site')
    page.locator('#confirm-draft').check()
    page.locator('#save-site').click()
    expect(page.locator('#editor-message')).to_contain_text('Site settings saved')
    page.get_by_role('link',name='Back to Generate',exact=True).click()
    expect(page.locator('#takeover-summary')).to_contain_text('TakeOver: ON')
    page.locator('#generate').click()
    page.locator('#review').wait_for(state='visible',timeout=90000)
    source=page.locator('#source').text_content()
    check('Generated source contains enabled Prebid, base params and device override',bool(re.search(r'HAS_PREBID\s*=\s*true',source)) and '456' in source)
    check('Uploaded JavaScript is not executed in the platform',page.evaluate('typeof window.fixtureOnly')=='undefined')
    page.locator('#ack').check()
    page.locator('#save').click()
    expect(page.locator('#releases article')).to_have_count(1,timeout=90000)
    with page.expect_download() as download:
        page.get_by_role('link',name='Download saved ZIP').click()
    with zipfile.ZipFile(io.BytesIO(pathlib.Path(download.value.path()).read_bytes())) as archive:
        check('Saved ten-file ZIP includes original Prebid bytes and reviewed wrapper',len(archive.namelist())==10 and archive.read('prebid.js')==fixture and archive.read('ads.js').decode()==source)
    page.get_by_role('link',name='Prebid and bidders',exact=True).click()
    expect(page.locator('#enable-prebid')).to_be_checked()
    page.locator('#enable-prebid').uncheck()
    page.locator('#ack').check()
    with page.expect_response(lambda r:'/test-api/prebid-settings' in r.url and r.request.method=='POST') as blocked_off:
        page.locator('#save-prebid').click()
    check('Prebid cannot turn off while TakeOver explicitly uses Prebid + GAM',blocked_off.value.status==422)
    page.reload()
    expect(page.locator('#enable-prebid')).to_be_checked()
    page.get_by_role('link',name='Back to Generate',exact=True).click()
    page.get_by_role('link',name='Ad positions and TakeOver',exact=True).click()
    page.get_by_label('Demand',exact=True).select_option('gam')
    page.locator('#confirm-draft').check()
    page.locator('#save-site').click()
    expect(page.locator('#editor-message')).to_contain_text('Site settings saved')
    page.get_by_role('link',name='Back to Generate',exact=True).click()
    page.get_by_role('link',name='Prebid and bidders',exact=True).click()
    expect(page.locator('#editor')).to_be_enabled()
    expect(page.locator('#enable-prebid')).to_be_checked()
    page.locator('#enable-prebid').uncheck()
    page.locator('#ack').check()
    page.locator('#save-prebid').click()
    expect(page.locator('#message')).to_contain_text('Prebid settings saved')
    expect(page.locator('#build')).to_have_value(build)
    page.reload()
    expect(page.locator('#editor')).to_be_enabled()
    expect(page.locator('#enable-prebid')).not_to_be_checked()
    expect(page.locator('#build')).to_have_value(build)
    check('Turning off preserves file and bidder parameters',page.locator('#bidders .bidder').count()==1)
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
