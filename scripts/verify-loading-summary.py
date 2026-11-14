"""Actual rules table + compiler-derived settings, with all network intercepted."""
import base64,json,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/loading-summary-evidence';out.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/loading-summary-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
requests=[];errors=[];unavailable=False
def call(path):
    process.stdin.write(json.dumps({'method':'GET','path':path})+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    return result
def route(request):
    url=urlsplit(request.request.url)
    assert url.netloc=='tessera.fixture.invalid'
    assert request.request.method=='GET'
    requests.append(url.path)
    if unavailable and url.path.endswith('/builtin-site-settings'):
        request.fulfill(status=503,content_type='application/json',body='{"error":"Unavailable"}');return
    result=call(url.path);assert result['status']==200,result
    request.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
try:
    assert json.loads(process.stdout.readline())['ready']
    with sync_playwright() as p:
        browser=p.chromium.launch()
        page=browser.new_page(viewport={'width':1440,'height':1000});page.route('**/*',route)
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('https://tessera.fixture.invalid/')
        table=page.locator('.effective-rule-table')
        table.get_by_text('Automatic · BTF lazy load',exact=True).wait_for()
        for code,label in [('Billboard','Automatic · ATF'),('Sticky','Automatic · Sticky'),('InText_1','Automatic · BTF lazy load'),('InText_2','Immediately after consent'),('InText_3','Lazy load'),('TakeOver','TakeOver · after consent'),('OffUnit','Not requested')]:
            row=table.get_by_role('row').filter(has=page.get_by_text(code,exact=True))
            assert row.locator('.effective-loading-cell').get_by_text(label,exact=True).count()==1,(code,label)
        lazy=table.get_by_role('row').filter(has=page.get_by_text('InText_3',exact=True))
        assert '100px' in lazy.inner_text() and 'Prebid is off' in lazy.inner_text()
        assert table.locator('.effective-loading-cell').get_by_text('Disabled',exact=True).count()==0
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        table.screenshot(path=str(out/'desktop-loading-table.png'))
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        table.locator('.effective-loading-cell').first.scroll_into_view_if_needed()
        page.screenshot(path=str(out/'mobile-loading-table.png'))
        unavailable=True
        page.get_by_role('button',name='Reload rules',exact=True).click()
        page.get_by_role('status').filter(has_text='Loading behavior is unavailable').wait_for()
        assert table.locator('.effective-loading-cell').get_by_text('Loading behavior unavailable',exact=True).count()==7
        unavailable=False
        page.get_by_role('button',name='Reload rules',exact=True).click()
        table.get_by_text('Automatic · BTF lazy load',exact=True).wait_for()
        assert json.loads(base64.b64decode(call('/unchanged')['body']))['unchanged']
        assert not errors,errors
        browser.close()
    (out/'result.json').write_text(json.dumps({'passed':True,'requests':requests,'errors':errors},indent=2))
    print('PASS loading summary: ATF/BTF, overrides, Sticky/TakeOver, GAM-only, disabled, retry, mobile, read-only')
finally:
    process.stdin.close();process.wait(timeout=10)
