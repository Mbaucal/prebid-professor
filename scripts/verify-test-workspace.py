"""Real Chromium -> actual Worker handler -> real local SQLite, fake R2.
No Cloudflare API, real credentials, external ad libraries or publisher requests.
"""
import json
import pathlib
import subprocess
import time
import urllib.request
import urllib.error
import urllib.parse
import zipfile
import io
from playwright.sync_api import sync_playwright, expect

origin='https://prebid-professor-test.mbaucal.workers.dev'
out=pathlib.Path('.generated/test-workspace-evidence')
out.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','scripts/test-workspace-server.mjs'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
checks=[]
external=[]
http_events=[]
page_errors=[]
def check(name,condition):
    assert condition,name
    checks.append({'name':name,'passed':True})

def exercise(page):
    page.goto(origin+'/')
    page.wait_for_url(origin+'/login')
    expect(page.get_by_role('heading',name='Sign in to test')).to_be_visible()
    check('Signed-out user sees separate test login',True)
    page.locator('#email').fill('tester@example.invalid')
    page.locator('#password').fill('Local-fixture-only-password-927!')
    page.get_by_role('button',name='Sign in',exact=True).click()
    page.wait_for_url(origin+'/')
    page.locator('#initialize').wait_for(state='visible')
    page.locator('#initialize').click()
    page.locator('#generate').wait_for(state='visible')
    check('Explicit setup unlocks generator',page.locator('#generator').is_visible())
    page.locator('#takeover').check()
    page.locator('#generate').click()
    page.locator('#review').wait_for(state='visible',timeout=90000)
    source=page.locator('#source').text_content()
    check('Generated JS is shown as text only','takeOver' in source and page.evaluate('typeof window.takeOverDebug')=='undefined')
    check('Save requires review acknowledgement',page.locator('#save').is_disabled())
    page.locator('#ack').check()
    page.locator('#note').fill('Browser test · TakeOver')
    page.locator('#save').click()
    page.locator('#releases article').wait_for(state='visible',timeout=90000)
    page.wait_for_function("!document.querySelector('#save').disabled")
    page.locator('#save').click()
    page.wait_for_function("document.querySelector('#message').textContent.includes('already saved')",timeout=90000)
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
    page.screenshot(path=str(out/'desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    check('Mobile workspace has no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.screenshot(path=str(out/'mobile.png'),full_page=True)
    check('No external ad or third-party requests',not external)
    page.locator('#logout').click()
    page.wait_for_url(origin+'/login')
    expect(page.get_by_role('heading',name='Sign in to test')).to_be_visible()
    check('Logout returns to test login',True)
    check('No page JavaScript errors',not page_errors)

try:
    for attempt in range(80):
        if process.poll() is not None:
            raise RuntimeError('Local workspace server exited: '+process.stderr.read().decode())
        try:
            urllib.request.urlopen('http://127.0.0.1:8877/login',timeout=1).read()
            break
        except (urllib.error.URLError,TimeoutError):
            time.sleep(.25)
    else:
        raise RuntimeError('Local workspace server did not start')
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True)
        context=browser.new_context(viewport={'width':1280,'height':900},accept_downloads=True)
        def handle(route):
            request=route.request
            if not request.url.startswith(origin+'/'):
                external.append(urllib.parse.urlsplit(request.url).hostname)
                route.abort()
                return
            headers={k:v for k,v in request.all_headers().items() if k.lower() not in ['host','content-length','connection','accept-encoding']}
            url='http://127.0.0.1:8877'+request.url[len(origin):]
            call=urllib.request.Request(url,data=request.post_data_buffer,headers=headers,method=request.method)
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*args,**kwargs): return None
            try:
                response=urllib.request.build_opener(NoRedirect).open(call,timeout=90)
            except urllib.error.HTTPError as error:
                response=error
            body=response.read()
            # urllib has decoded HTTP chunk framing. Let Playwright set a fresh
            # body length rather than forwarding Node's transfer-encoding header.
            response_headers={k:v for k,v in response.headers.items() if k.lower() not in ['transfer-encoding','content-length','connection','keep-alive','content-encoding']}
            http_events.append({'method':request.method,'path':urllib.parse.urlsplit(request.url).path,'status':response.code})
            route.fulfill(status=response.code,headers=response_headers,body=body)
        context.route('**/*',handle)
        page=context.new_page()
        page.on('pageerror',lambda error:page_errors.append(str(error)[:500]))
        try:
            exercise(page)
        except Exception:
            # Only synthetic UI text and method/path/status. No input values,
            # request bodies, authentication headers, cookies or review receipts.
            page.screenshot(path=str(out/'failure.png'),full_page=True)
            diagnostic={'scope':'LOCAL HARNESS ONLY','path':urllib.parse.urlsplit(page.url).path,
                        'visibleText':page.locator('body').inner_text()[:3000],
                        'http':http_events,'pageErrors':page_errors,'checks':checks,'failed':1}
            (out/'failure.json').write_text(json.dumps(diagnostic,indent=2))
            print(json.dumps(diagnostic,indent=2))
            raise
        finally:
            browser.close()
    report={'scope':'local Worker handler + SQLite + fake R2, real Chromium; NOT a hosted Cloudflare test','checks':checks,'externalRequests':external,'passed':len(checks),'failed':0}
    (out/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
finally:
    process.terminate()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.kill()
