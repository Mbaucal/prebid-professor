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
     expect(page.get_by_role('button',name='Start test',exact=True)).to_have_css('background-color','rgb(239, 114, 45)')
     page.keyboard.press('Tab')
     page.get_by_role('button',name='Start test',exact=True).focus()
     expect(page.get_by_role('button',name='Start test',exact=True)).to_have_css('outline-style','solid')
     expect(page.get_by_role('region',name='Ad position results',exact=True)).to_have_attribute('tabindex','0')
     page.screenshot(path=str(out/('ready-desktop.png' if width>=1300 else 'ready-mobile.png')),full_page=True)
     assert page.evaluate('''()=>{try{document.cookie;return false}catch(e){return e.name==='SecurityError'}}''')
     assert page.evaluate('''()=>{try{localStorage.getItem('admin');return false}catch(e){return e.name==='SecurityError'}}''')
     page.get_by_role('button',name='Start test',exact=True).click()
     expect(page.locator('[data-metric="gpt"]')).to_have_text('4 / 4',timeout=15000)
     expect(page.locator('[data-asset="ads"]')).to_have_text('ads: ready')
     expect(page.locator('[data-consent]')).to_have_text('Consent diagnostics unavailable')
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
     expect(page.locator('[data-scan-progress]')).to_be_visible()
     lazy_row=page.locator('[data-rows] tr').filter(has=page.get_by_role('button',name='P1',exact=True))
     expect(lazy_row.locator('td').nth(4)).to_have_text('1',timeout=12000)
     page.get_by_role('button',name='Stop scrolling',exact=True).click()
     expect(page.locator('[data-scan-progress]')).to_be_hidden()
     stopped_y=page.evaluate('scrollY')
     page.wait_for_timeout(1400)
     assert abs(page.evaluate('scrollY')-stopped_y)<1,'Stopped scan moved the page'
     page.get_by_role('button',name='↑ Results',exact=True).click()
     page.get_by_role('button',name='Copy report',exact=True).click()
     page.locator('[data-report]').wait_for(state='visible')
     report=json.loads(page.locator('[data-report]').input_value())
     assert report['consent']=={'status':'unavailable','phase':None,'ready':None,'epoch':None}
     assert len(report['units'])==4
     assert report['startedViewport']=={'width':width,'height':900}
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
     page.get_by_role('button',name='Scroll through positions',exact=True).click()
     page.set_viewport_size({'width':width-10,'height':860})
     expect(page.locator('[data-resize-notice]')).to_contain_text('Restart test')
     expect(page.locator('[data-scan-progress]')).to_be_hidden()
     expect(page.get_by_role('button',name='Stop scrolling',exact=True)).to_be_hidden()
     page.get_by_role('button',name='Restart test',exact=True).click()
     expect(page.get_by_role('button',name='Start test',exact=True)).to_be_enabled()
     expect(page.locator('[data-resize-notice]')).to_be_hidden()
     expect(page.locator('[data-metric="gpt"]')).to_have_text('0 / 4')
     assert len(external)==1,'Restart must wait for a new Start'
     results.append({'width':width,'passed':True,'interceptedGptRequests':len(external),'liveAdRequests':0,'report':report})
    except Exception:
     page.screenshot(path=str(out/('failure-'+str(width)+'.png')),full_page=True)
     print(json.dumps({'width':width,'pageErrors':errors,'scriptErrors':page.locator('[data-errors]').inner_text(),'summary':page.locator('[data-summary]').inner_text()}))
     raise
    context.close()
 # Fault paths must be actionable and must never report registration success.
 for scenario in ('blocked','stalled','wrong-path','duplicate-dom','duplicate-slot'):
    context=browser.new_context(viewport={'width':1440,'height':900})
    page=context.new_page()
    if scenario=='stalled': page.clock.install()
    def fault_route(r):
        if r.request.url=='https://tessera.fixture.invalid/test-page':
            r.fulfill(status=200,headers=headers,body=(out/'page.html').read_text())
        elif r.request.url=='https://securepubads.g.doubleclick.net/tag/js/gpt.js':
            if scenario=='blocked': r.abort('blockedbyclient')
            elif scenario=='stalled': r.fulfill(status=200,headers={'content-type':'application/javascript','access-control-allow-origin':'*'},body="document.documentElement.setAttribute('data-gpt-fixture-loaded','true');")
            else: r.fulfill(status=200,headers={'content-type':'application/javascript','access-control-allow-origin':'*'},body=gpt)
        else: raise AssertionError('Unexpected request: '+r.request.url)
    page.route('**/*',fault_route)
    page.goto('https://tessera.fixture.invalid/test-page')
    page.get_by_role('button',name='Start test',exact=True).click()
    if scenario=='stalled':
        expect(page.locator('html')).to_have_attribute('data-gpt-fixture-loaded','true')
        page.clock.fast_forward(21000)
    if scenario in ('blocked','stalled'):
        expect(page.locator('[data-asset="gpt"]')).to_have_text('gpt: failed')
        expect(page.locator('[data-summary]')).to_contain_text('failed to load or initialize')
        expect(page.get_by_role('button',name='Google Publisher Console',exact=True)).to_be_disabled()
        expect(page.locator('[data-error-count]')).to_have_text('1 error')
    else:
        expect(page.locator('[data-metric="gpt"]')).to_have_text('4 / 4',timeout=15000)
        if scenario=='wrong-path':
            page.evaluate("__testAds.slots[0].getAdUnitPath=()=>'/wrong/path'")
            expect(page.locator('[data-summary]')).to_contain_text('GPT registration mismatch')
            expect(page.locator('[data-rows]')).to_contain_text('Wrong GAM path')
        elif scenario=='duplicate-slot':
            page.evaluate('__testAds.slots.push(__testAds.slots[0])')
            expect(page.locator('[data-summary]')).to_contain_text('GPT registration mismatch')
            expect(page.locator('[data-rows]')).to_contain_text('Duplicate slot')
        else:
            page.evaluate("document.body.append(document.getElementById('Billboard').cloneNode())")
            expect(page.locator('[data-summary]')).to_contain_text('Container check failed')
            expect(page.locator('[data-rows]')).to_contain_text('Duplicate ID')
    results.append({'scenario':scenario,'passed':True,'summary':page.locator('[data-summary]').inner_text(),'liveAdRequests':0})
    context.close()
 # Consent UI uses the unchanged 3.14 GAM-only archive from the compiled Worker.
 # The existing generic GPT double includes a CMP; remove that synthetic CMP
 # synchronously, before queued callbacks, so missing really means missing.
 consent_gpt=gpt.replace('const pending=','const fixtureCMP=window.__tcfapi;const pending=').replace(
    'googletag.apiReady=true;',
    "if(fixtureCMP)window.__tcfapi=fixtureCMP;else delete window.__tcfapi;googletag.apiReady=true;")
 for width in (1440,390):
  for scenario in ('missing-late-decision','script-error','gpt-error'):
   context=browser.new_context(viewport={'width':width,'height':900})
   page=context.new_page();errors=[];external=[];fail_gpt=[scenario=='gpt-error'];consent_evidence={}
   page.on('pageerror',lambda error:errors.append(str(error)))
   def route_consent(r):
    if r.request.url=='https://tessera.fixture.invalid/consent-test':
     r.fulfill(status=200,headers=headers,body=(out/'readiness.html').read_text())
    elif r.request.url=='https://securepubads.g.doubleclick.net/tag/js/gpt.js':
     external.append(r.request.url)
     if fail_gpt[0]:
      fail_gpt[0]=False
      r.abort('failed')
     else:
      r.fulfill(status=200,headers={'content-type':'application/javascript','access-control-allow-origin':'*'},body=consent_gpt)
    else:
     r.abort('blockedbyclient')
     raise AssertionError('Unexpected consent fixture request: '+r.request.url)
   page.route('**/*',route_consent)
   def copy_report():
    button=page.get_by_role('button',name='Copy report',exact=True)
    if not button.count(): button=page.get_by_role('button',name='Copy selected report (Ctrl/Cmd+C)',exact=True)
    button.focus();page.keyboard.press('Enter')
    field=page.locator('[data-report]');expect(field).to_be_visible();expect(field).to_be_focused()
    return json.loads(field.input_value())
   try:
    page.goto('https://tessera.fixture.invalid/consent-test')
    expect(page.locator('[data-consent]')).to_be_hidden()
    if scenario=='script-error':
     # Browser-only fault injection; do not alter the archived script or CSP.
     page.evaluate('''()=>{const append=Element.prototype.appendChild;Element.prototype.appendChild=function(n){
       if(n.tagName==='SCRIPT' && n.src.startsWith('data:application/javascript;')){queueMicrotask(()=>n.onerror(new Event('error')));return n;}
       return append.call(this,n);};}''')
    if scenario=='missing-late-decision':
     page.evaluate('''()=>{const append=Element.prototype.appendChild;Element.prototype.appendChild=function(n){
       if(n.tagName==='SCRIPT' && n.src.startsWith('data:application/javascript;')){window.__releaseScript=()=>append.call(this,n);return n;}
       return append.call(this,n);};}''')
    start=page.get_by_role('button',name='Start test',exact=True)
    start.focus();page.keyboard.press('Enter')
    if scenario=='missing-late-decision':
     expect(page.locator('[data-consent]')).to_have_text('Checking consent status')
     assert not external
     page.screenshot(path=str(out/f'consent-loading-{width}.png'),full_page=True)
     page.evaluate('window.__releaseScript()')
    if scenario!='missing-late-decision':
     expect(page.locator('[data-summary]')).to_contain_text('A required script failed to load',timeout=10000)
     report=copy_report();assert report['errors']
     assert report['assets']['ads' if scenario=='script-error' else 'gpt']=='failed'
     if scenario=='script-error': assert report['consent']['status']=='unavailable'
     assert not page.evaluate('window.__testAds?.observations.requests.length || 0')
     page.screenshot(path=str(out/f'consent-{scenario}-{width}.png'),full_page=True)
     restart=page.get_by_role('button',name='Restart test',exact=True)
     restart.focus();page.keyboard.press('Enter')
     expect(page.get_by_role('button',name='Start test',exact=True)).to_be_enabled()
     expect(page.locator('[data-errors]')).to_have_text('No errors recorded.')
     page.get_by_role('button',name='Start test',exact=True).click()
    expect(page.locator('[data-asset="gpt"]')).to_have_text('gpt: ready',timeout=10000)
    expect(page.locator('[data-consent]')).to_have_text('Waiting for publisher consent',timeout=10000)
    expect(page.locator('[data-consent-detail]')).to_contain_text('does not load the publisher CMP')
    assert page.evaluate('typeof window.__tcfapi')=='undefined'
    assert not page.evaluate('__testAds.observations.requests.length')
    assert 'All ' not in page.locator('[data-summary]').inner_text()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    if scenario=='missing-late-decision':
     page.clock.install();page.clock.fast_forward(33000)
     assert not page.evaluate('__testAds.observations.requests.length')
     report=copy_report()
     assert report['consent']=={'status':'available','phase':'cmp-missing','ready':False,'epoch':0}
     consent_evidence['missingAfter33Seconds']={'consent':report['consent'],'dispatches':page.evaluate('__testAds.observations.requests.length')}
     page.screenshot(path=str(out/f'consent-missing-{width}.png'),full_page=True)
     page.evaluate('''()=>{window.__fixtureCmpListeners=[];window.__tcfapi=(command,version,callback)=>{
       if(command==='addEventListener'){window.__fixtureCmpListeners.push(callback);callback({gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown',listenerId:1},true);}
     };}''')
     page.clock.fast_forward(1500)
     expect(page.locator('[data-consent]')).to_have_text('Waiting for user decision')
     assert not page.evaluate('__testAds.observations.requests.length')
     page.screenshot(path=str(out/f'consent-user-decision-{width}.png'),full_page=True)
     # A valid rejection is deliberately used: ready must never mean accepted.
     page.evaluate('''()=>{for(const callback of window.__fixtureCmpListeners)callback({gdprApplies:true,cmpStatus:'loaded',eventStatus:'useractioncomplete',tcString:'synthetic-decision-no-real-user',purpose:{consents:{}},vendor:{consents:{}},listenerId:1},true);}''')
     page.clock.fast_forward(2000)
     expect(page.locator('[data-consent]')).to_have_text('CMP decision ready')
     expect(page.locator('[data-consent-detail]')).to_contain_text('can include rejection')
     assert 'Consent accepted' not in page.locator('body').inner_text()
     assert page.evaluate('__testAds.observations.requests.length')>0
     # Export an allowlist even if a future runtime exposes more fields.
     page.evaluate('''()=>{const snapshot=window.__tesseraReadiness.snapshot;window.__tesseraReadiness.snapshot=()=>{
       const state=snapshot();state.consent.tcString='private-tc';state.consent.vendor={consents:{1:true}};state.events=[{identity:'private-id'}];return state;};}''')
     report=copy_report();assert report['consent']=={'status':'available','phase':'decision-ready','ready':True,'epoch':1}
     consent_evidence['lateDecision']={'consent':report['consent'],'dispatches':page.evaluate('__testAds.observations.requests.length')}
     assert all(value not in json.dumps(report) for value in ('private-tc','private-id','tcString','synthetic-decision-no-real-user','vendor'))
     page.screenshot(path=str(out/f'consent-ready-{width}.png'),full_page=True)
     # Diagnostics fail closed in the UI and can recover without a page reload.
     page.evaluate('''()=>{window.__savedSnapshot=window.__tesseraReadiness.snapshot;window.__tesseraReadiness.snapshot=()=>{throw Error('private-error');};}''')
     page.clock.fast_forward(1000)
     expect(page.locator('[data-consent]')).to_have_text('Consent diagnostics unavailable')
     assert copy_report()['consent']['ready'] is None
     page.evaluate('window.__tesseraReadiness.snapshot=window.__savedSnapshot')
     page.clock.fast_forward(1000)
     expect(page.locator('[data-consent]')).to_have_text('CMP decision ready')
    assert not errors,errors
    results.append({'width':width,'scenario':scenario,'passed':True,'liveAdRequests':0,'interceptedGptRequests':len(external),'consentEvidence':consent_evidence})
   except Exception:
    page.screenshot(path=str(out/f'failure-consent-{scenario}-{width}.png'),full_page=True)
    print(json.dumps({'scenario':scenario,'width':width,'errors':errors,'summary':page.locator('[data-summary]').inner_text()}))
    raise
   finally:
    context.close()
 browser.close()
(out/'result.json').write_text(json.dumps(results,indent=2))
print('PASS saved 3.10 / 3.14 packages; consent missing, pending, decision, errors/recovery, keyboard/report; responsive slots/Sticky; zero live ads')
