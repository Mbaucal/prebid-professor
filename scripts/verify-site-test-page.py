"""CI browser regression: real compiled package, synthetic GPT, zero live ads."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/test-page-evidence'
headers=json.loads((out/'headers.json').read_text())
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
gpt='''(()=>{const pending=window.googletag.cmd.slice();window.__testOptions={allEmpty:true};
'''+mock+'''
googletag.apiReady=true;googletag.openConsole=()=>{window.__consoleOpened=true};
pending.forEach(fn=>fn());})();'''
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for width in (1440,390):
    context=browser.new_context(viewport={'width':width,'height':900})
    context.add_cookies([{'name':'admin-fixture','value':'must-not-be-readable','url':'https://tessera.fixture.invalid'}])
    page=context.new_page();errors=[];external=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    def route(r):
        if r.request.url=='https://tessera.fixture.invalid/test-page?googfc':
            r.fulfill(status=200,headers=headers,body=(out/'page.html').read_text())
        elif r.request.url=='https://securepubads.g.doubleclick.net/tag/js/gpt.js':
            external.append(r.request.url)
            r.fulfill(status=200,headers={'content-type':'application/javascript','access-control-allow-origin':'*'},body=gpt)
        else:
            raise AssertionError('Unexpected request: '+r.request.url)
    page.route('**/*',route)
    try:
     page.goto('https://tessera.fixture.invalid/test-page?googfc')
     assert page.locator('[data-metric="dom"]').inner_text()=='3 / 3'
     assert not external,'Scripts loaded without Start'
     assert page.evaluate('''()=>{try{document.cookie;return false}catch(e){return e.name==='SecurityError'}}''')
     assert page.evaluate('''()=>{try{localStorage.getItem('admin');return false}catch(e){return e.name==='SecurityError'}}''')
     page.get_by_role('button',name='Start test',exact=True).click()
     expect(page.locator('[data-metric="gpt"]')).to_have_text('3 / 3',timeout=15000)
     expect(page.locator('[data-asset="ads"]')).to_have_text('ads: ready')
     assert len(external)==1
     assert page.locator('[data-metric="active"]').inner_text()==('3 / 3' if width>=1300 else '2 / 3')
     assert page.evaluate('__testAds.observations.requests.every(r=>r.path.startsWith("/123/test/"))')
     page.get_by_role('button',name='Google Publisher Console',exact=True).click()
     assert page.evaluate('window.__consoleOpened')
     page.get_by_role('button',name='Scroll through positions',exact=True).click()
     lazy_row=page.locator('[data-rows] tr').filter(has=page.get_by_role('button',name='P1',exact=True))
     expect(lazy_row.locator('td').nth(4)).to_have_text('1',timeout=12000)
     page.get_by_role('button',name='Stop scrolling',exact=True).click()
     page.get_by_role('button',name='↑ Results',exact=True).click()
     page.get_by_role('button',name='Copy report',exact=True).click()
     page.locator('[data-report]').wait_for(state='visible')
     report=json.loads(page.locator('[data-report]').input_value())
     assert len(report['units'])==3
     assert all(u['slotCount']==1 and u['pathOk'] for u in report['units'])
     assert any(u['response']=='Empty — OK for this test' for u in report['units'])
     assert not report['errors'],report['errors']
     assert not errors,errors
     assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
     page.screenshot(path=str(out/('desktop.png' if width>=1300 else 'mobile.png')),full_page=True)
     results.append({'width':width,'passed':True,'interceptedGptRequests':len(external),'liveAdRequests':0,'report':report})
    except Exception:
     page.screenshot(path=str(out/('failure-'+str(width)+'.png')),full_page=True)
     print(json.dumps({'width':width,'pageErrors':errors,'scriptErrors':page.locator('[data-errors]').inner_text(),'summary':page.locator('[data-summary]').inner_text()}))
     raise
    context.close()
 browser.close()
(out/'result.json').write_text(json.dumps(results,indent=2))
print('PASS isolated saved package, slots/paths, empty responses, responsive map, lazy scroll, console button and report')
