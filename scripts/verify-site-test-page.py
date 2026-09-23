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
     assert page.locator('[data-metric="dom"]').inner_text()=='4 / 4'
     assert not external,'Scripts loaded without Start'
     assert page.evaluate('''()=>{try{document.cookie;return false}catch(e){return e.name==='SecurityError'}}''')
     assert page.evaluate('''()=>{try{localStorage.getItem('admin');return false}catch(e){return e.name==='SecurityError'}}''')
     page.get_by_role('button',name='Start test',exact=True).click()
     expect(page.locator('[data-metric="gpt"]')).to_have_text('4 / 4',timeout=15000)
     expect(page.locator('[data-asset="ads"]')).to_have_text('ads: ready')
     assert len(external)==1
     assert page.locator('[data-metric="active"]').inner_text()==('4 / 4' if width>=1300 else '3 / 4')
     assert page.evaluate('__testAds.observations.requests.every(r=>r.path.startsWith("/123/test/"))')
     live=page.locator('[data-sticky-live="Sticky"]')
     expect(live).to_contain_text('Empty — OK for this test',timeout=15000)
     expect(live).to_contain_text('Hidden')
     expect(page.locator('body > #Sticky')).to_have_css('position','fixed')
     expect(page.locator('body > #Sticky')).to_have_css('bottom','0px')
     actual_before=page.locator('body > #Sticky').evaluate('(n)=>n.outerHTML')
     request_count=page.evaluate('__testAds.observations.requests.length')
     page.get_by_role('button',name='Show Sticky CSS preview',exact=True).click()
     preview=page.locator('[data-sticky-css-preview="Sticky"] #Sticky')
     expect(preview).to_have_css('position','fixed')
     expect(preview).to_have_css('visibility','visible')
     expect(preview).to_have_css('opacity','1')
     expect(preview).to_have_css('bottom','0px')
     expect(preview.locator('[data-preview-label]')).to_contain_text('970×90' if width>=1300 else '320×50')
     assert page.evaluate('document.querySelectorAll("#Sticky").length')==1
     assert page.locator('body > #Sticky').evaluate('(n)=>n.outerHTML')==actual_before
     assert page.evaluate('__testAds.observations.requests.length')==request_count
     page.evaluate('scrollTo(0,500)')
     assert abs(preview.evaluate('(n)=>innerHeight-n.getBoundingClientRect().bottom'))<1
     page.screenshot(path=str(out/('sticky-preview-desktop.png' if width>=1300 else 'sticky-preview-mobile.png')))
     page.get_by_role('button',name='Google Publisher Console',exact=True).click()
     assert page.evaluate('window.__consoleOpened')
     expect(page.locator('[data-sticky-css-preview]')).to_have_count(0)
     expect(page.locator('[data-sticky-before="Sticky"]')).to_contain_text('Hidden')
     # A real filled response exercises the archived runtime's visibility and close behavior.
     page.evaluate('''()=>{window.__testOptions.allEmpty=false;__testAds.service.refresh([__testAds.slots.find(s=>s.id==='Sticky')]);}''')
     expect(live).to_contain_text('Visible · Ad',timeout=10000)
     expect(page.locator('body > #Sticky')).to_have_css('opacity','1')
     page.evaluate('scrollTo(0,900)')
     assert abs(page.locator('body > #Sticky').evaluate('(n)=>innerHeight-n.getBoundingClientRect().bottom'))<1
     expect(page.get_by_role('button',name='Show Sticky CSS preview',exact=True)).to_be_disabled()
     # Simulate an external style change while opening the console; compare before/live,
     # without claiming that Google's current hosted UI performs this particular change.
     page.evaluate('''()=>{googletag.openConsole=(id)=>{window.__consoleSlot=id;const n=document.getElementById(id);n.style.top='0px';n.style.bottom='auto';};}''')
     page.get_by_role('button',name='Inspect Sticky in GAM',exact=True).click()
     assert page.evaluate('window.__consoleSlot')=='Sticky'
     expect(page.locator('[data-sticky-before="Sticky"]')).to_contain_text('bottom: 0px')
     expect(live).to_contain_text('top: 0px; bottom:')
     assert page.locator('body > #Sticky').evaluate('(n)=>n.getBoundingClientRect().top')==0
     page.evaluate('''()=>{const n=document.getElementById('Sticky');n.style.removeProperty('top');n.style.removeProperty('bottom');}''')
     expect(page.locator('body > #Sticky')).to_have_css('bottom','0px')
     page.locator('body > #Sticky #close_sticky_ad').click()
     expect(live).to_contain_text('Hidden · Ad',timeout=10000)
     page.evaluate('window.__testOptions.allEmpty=true')
     page.get_by_role('button',name='Scroll through positions',exact=True).click()
     lazy_row=page.locator('[data-rows] tr').filter(has=page.get_by_role('button',name='P1',exact=True))
     expect(lazy_row.locator('td').nth(4)).to_have_text('1',timeout=12000)
     page.get_by_role('button',name='Stop scrolling',exact=True).click()
     page.get_by_role('button',name='↑ Results',exact=True).click()
     page.get_by_role('button',name='Copy report',exact=True).click()
     page.locator('[data-report]').wait_for(state='visible')
     report=json.loads(page.locator('[data-report]').input_value())
     assert len(report['units'])==4
     assert all(u['slotCount']==1 and u['pathOk'] for u in report['units'])
     assert any(u['response']=='Empty — OK for this test' for u in report['units'])
     assert not report['cssPreviews']
     assert report['consoleSnapshot']['units'][0]['visible']
     assert report['consoleSnapshot']['units'][0]['layout']['bottom']=='0px'
     sticky=next(u for u in report['units'] if u['id']=='Sticky')
     assert not sticky['visible'] and not sticky['layout']['loaded']
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
