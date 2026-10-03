"""Keyboard, 390px/desktop error and recovery checks on the compiled local Worker."""
import json, subprocess, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
test_workspace='--test-workspace' in sys.argv
out=root/('.generated/test-login-recovery-evidence' if test_workspace else '.generated/login-recovery-evidence');out.mkdir(parents=True,exist_ok=True)
tls=tempfile.TemporaryDirectory(prefix='tessera-auth-tls-')
hostname='prebid-professor-test.mbaucal.workers.dev'
key=str(Path(tls.name)/'key.pem');cert=str(Path(tls.name)/'cert.pem')
if test_workspace:
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN='+hostname,'-addext','subjectAltName=DNS:'+hostname],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
process=subprocess.Popen((['node','--experimental-strip-types','scripts/login-test-browser-fixture.mjs',key,cert] if test_workspace else ['node','scripts/verify-auth-boundaries.mjs','--serve']),cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def command(value):
    process.stdin.write(value+'\n');process.stdin.flush()
    for line in process.stdout:
        if line.strip()=='AUTH_COMMAND_DONE '+value:return
    raise RuntimeError('Fixture closed')
try:
    for line in process.stdout:
        if line.startswith('AUTH_FIXTURE_READY '):
            ready=line.split(' ',1)[1].strip().rstrip('/')
            origin=ready
            break
    else:raise RuntimeError('Fixture failed')
    checks=[]
    email='tester@example.invalid' if test_workspace else 'admin@example.invalid'
    password='Local-fixture-only-password-927!' if test_workspace else 'Synthetic-login-fixture-only-927!'
    destination='/' if test_workspace else '/config?site=auth-site#units'
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
        for width,height in [(1440,1000),(390,844)]:
            command('expire')
            context=browser.new_context(viewport={'width':width,'height':height},ignore_https_errors=test_workspace,service_workers='block')
            page=context.new_page();external=[]
            def route(r):
                if not r.request.url.startswith(origin+'/'):external.append(r.request.url);r.abort()
                elif not test_workspace and '/config?site=auth-site' in r.request.url:r.fulfill(status=200,content_type='text/html',body='<h1>Signed in fixture destination</h1>')
                else:r.continue_()
            page.route('**/*',route)
            page.goto(origin+'/login?next=%2Fconfig%3Fsite%3Dauth-site%23units')
            page.keyboard.press('Tab');assert page.locator('input[name=email]').evaluate('(el)=>el===document.activeElement')
            page.keyboard.type(email);page.keyboard.press('Tab');page.keyboard.type('wrong');page.keyboard.press('Tab')
            assert page.locator('button[type=submit]').evaluate('(el)=>el===document.activeElement')
            with page.expect_navigation() as result:page.keyboard.press('Enter')
            assert result.value.status==401
            assert page.locator('input[name=email]').input_value()==email
            assert page.locator('input[name=password]').input_value()==''
            for i in range(4):
                page.locator('input[name=password]').fill('wrong')
                with page.expect_navigation() as result:page.locator('button[type=submit]').click()
                assert result.value.status==401
            page.locator('input[name=password]').fill(password)
            with page.expect_navigation() as result:page.locator('button[type=submit]').click()
            assert result.value.status==429
            assert page.locator('[role=alert]').count()==1
            assert 'Try again in' in page.locator('[role=alert]').inner_text()
            assert int(result.value.headers['retry-after'])<=60
            assert page.locator('button[type=submit]').is_enabled()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(out/f'login-{width}-limited.png'),full_page=True)
            command('unavailable')
            page.locator('input[name=password]').fill(password)
            with page.expect_navigation() as result:page.locator('button[type=submit]').click()
            assert result.value.status==503
            assert 'temporarily unavailable' in page.locator('[role=alert]').inner_text()
            assert page.locator('input[name=email]').input_value()==email
            assert page.locator('input[name=password]').input_value()==''
            page.screenshot(path=str(out/f'login-{width}-unavailable.png'),full_page=True)
            command('recover')
            page.locator('input[name=password]').focus();page.keyboard.type(password);page.keyboard.press('Tab')
            with page.expect_navigation():page.keyboard.press('Enter')
            assert page.url==origin+destination,page.url
            assert not external,external
            checks.append({'width':width,'keyboardSubmit':True,'limited429':True,'unavailable503':True,'emailAndNextPreserved':True,'passwordCleared':True,'retryAndRedirect':True,'noHorizontalOverflow':True})
            context.close()
        browser.close()
    (out/'result.json').write_text(json.dumps(checks,indent=2))
    print('PASS: desktop +390px keyboard login, 401/429/503 recovery, preserved email/next, cleared password, same-origin redirect.')
finally:
    process.stdin.close();process.wait(timeout=20);tls.cleanup()
