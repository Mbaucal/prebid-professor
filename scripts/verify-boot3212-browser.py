"""3.21.2 boot with a TakeOver interval in Chromium; synthetic CMP/GPT/Prebid, no paid traffic.

Run scripts/prepare-boot3212-browser.mjs first. Every program is the full generated
ads.js or ads.min.js. GPT and Prebid are tests/runtime/mock-ad-libraries.js, the CMP is
a local TCF stub, the fixture page is served by a route and every other request is
aborted. The page clock is virtual, so waits are exact and nothing depends on load.

Checked on the 3.21.2 interval-5 programs (GAM and Prebid, readable and minified):
- before the CMP decision: window.adSlots and data-ad-size-map are set at load, the
  TakeOver is undecided (null, waiting-consent), and there is no guard,
  enableServices, display, refresh, storage access or data-google-interstitial;
- accept: the guard is defined before enableServices and every slot is displayed once;
- a stored cap: no guard and no interstitial attribute, every slot displayed once;
- containers inserted while the decision is pending: discovered, defined and held,
  then displayed once after enableServices.
Page targeting (GPT semantics: setTargeting replaces a key's values) with
window.adsKeywords changed between load and the decision must equal production
3.21.0 at intervals 5 and 30: the single load-time value.
"""
import json
import hashlib
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1] if len(sys.argv) > 1 else root / '.generated/boot3212-browser')
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
manifest = json.loads((output / 'manifest.json').read_text())
for name, expected in manifest['files'].items():
    assert hashlib.sha256((output / name).read_bytes()).hexdigest() == expected, 'Generated program changed: ' + name
now = datetime(2026, 11, 13, 12, tzinfo=timezone.utc)
CONTAINERS = '<div id="Billboard" class="wrapperAd"></div><main style="height:1200px"></main><div id="P1" class="wrapperAd"></div>'
FIXTURE = 'https://boot3212-fixture.invalid/'
hook = r'''
options => {
 window.__flow=[]; window.__storageAccess=[]; window.__cmpCallbacks=[]; window.__interstitialAttr=[]; window.__kv=[]; window.__decided=false;
 window.fetch=()=>Promise.resolve(new Response(JSON.stringify({version:1,status:'known',country:'RS',source:'cloudflare'}),{headers:{'content-type':'application/json'}}));
 const values=new Map();
 if(options.persisted)values.set('tessera:takeover:/123/test/Overlay',String(Date.now()-1000));
 Object.defineProperty(window,'sessionStorage',{configurable:true,get(){
  __storageAccess.push('session:getter');
  return {getItem(key){__storageAccess.push('session:read');return values.get(key)||null;},
   setItem(key,value){__storageAccess.push('session:write');values.set(key,value);}};
 }});
 Object.defineProperty(window,'localStorage',{configurable:true,get(){__storageAccess.push('local:getter');throw new DOMException('Denied','SecurityError');}});
 window.__tcfapi=(command,version,callback)=>{
  if(command==='addEventListener')__cmpCallbacks.push(callback);
  else if(command==='getTCData')callback({},false);
 };
 window.__emitConsent=kind=>{__decided=true;__cmpCallbacks.forEach(callback=>callback({gdprApplies:true,cmpStatus:'loaded',
  eventStatus:'useractioncomplete',tcString:'synthetic-current-choice',purpose:{consents:{1:kind==='grant'}}},true));};
 if(options.keywords)window.adsKeywords=options.keywords;
 const record=(owner,name,label)=>{const original=owner[name];owner[name]=function(...args){__flow.push(label(...args));return original.apply(this,args);};};
 const service=__testAds.service;
 record(googletag,'defineSlot',(path,sizes,id)=>'define:'+id);
 record(googletag,'defineOutOfPageSlot',()=>'guard');
 record(googletag,'enableServices',()=>'enable');
 record(googletag,'display',slot=>'display:'+(typeof slot==='string'?slot:slot.getSlotElementId()));
 record(service,'enableSingleRequest',()=>'single-request');
 record(service,'refresh',list=>'request:'+(list||[]).map(slot=>slot.getSlotElementId()).join(','));
 const page=new Map();
 window.__pageTargeting=()=>Object.fromEntries([...page].map(([key,list])=>[key,[...list]]));
 service.getTargeting=key=>[...(page.get(key)||[])];
 service.setTargeting=function(key,value){const list=(Array.isArray(value)?value:[value]).map(String);__kv.push([key,list,__decided]);page.set(key,list);return this;};
 service.clearTargeting=function(key){page.delete(key);return this;};
 const setAttribute=Element.prototype.setAttribute;
 Element.prototype.setAttribute=function(name,value){
  if(String(name).toLowerCase()==='data-google-interstitial')__interstitialAttr.push(this.tagName+'='+value);
  return setAttribute.call(this,name,value);
 };
}
'''
STATE = '''() => ({flow:__flow, access:__storageAccess, attr:__interstitialAttr, kv:__kv, targeting:__pageTargeting(),
 adSlots:Object.keys(window.adSlots||{}), sizeMap:{Billboard:document.getElementById('Billboard')?.getAttribute('data-ad-size-map')??null,
 P1:document.getElementById('P1')?.getAttribute('data-ad-size-map')??null},
 displays:__testAds.observations.displays, requests:__testAds.observations.requests.map(request=>request.id),
 active:window.TAKEOVER_ACTIVE_FOR_PAGE, takeOver:takeOverDebug.state(),
 htmlAttr:document.documentElement.getAttribute('data-google-interstitial'), bodyAttr:document.body.getAttribute('data-google-interstitial')})'''
INSERT = '''() => document.body.insertAdjacentHTML('afterbegin', '%s')''' % CONTAINERS.replace("'", "\\'")


def load(browser, program, body, options):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors, outbound = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def route(request):
        if request.request.url == FIXTURE:
            request.fulfill(content_type='text/html', body='<!doctype html><body>' + body + '</body>')
        else:
            outbound.append(request.request.url)
            request.abort()
    page.route('**/*', route)
    page.clock.install(time=now)
    page.clock.pause_at(now + timedelta(seconds=1))
    page.goto(FIXTURE)
    page.add_script_tag(content=mock)
    page.evaluate(hook, options)
    page.add_script_tag(content=(output / program).read_text())
    return page, errors, outbound


def assert_pending(state, slots):
    assert all(slot in state['adSlots'] for slot in slots), ('adSlots at load', state)
    assert state['sizeMap']['P1'] is not None and state['sizeMap']['Billboard'] is not None, ('data-ad-size-map at load', state)
    held = [event for event in state['flow'] if event in ('guard', 'enable', 'single-request') or event.startswith(('display:', 'request:'))]
    assert held == [], ('GPT start before the decision', state)
    assert state['displays'] == [] and state['requests'] == [], ('display or request before the decision', state)
    assert state['attr'] == [] and state['htmlAttr'] is None and state['bodyAttr'] is None, ('interstitial attribute before the decision', state)
    assert state['active'] is None and state['takeOver']['activeForPage'] is None and state['takeOver']['status'] == 'waiting-consent', state
    assert state['access'] == [], ('storage before the decision', state)


def assert_started(state, capped):
    flow = state['flow']
    assert flow.count('enable') == 1, ('one enableServices', flow)
    enable = flow.index('enable')
    assert flow.index('single-request') < enable, flow
    displays = Counter(state['displays'])
    assert all(count == 1 for count in displays.values()), ('each slot displayed once', displays)
    assert all(displays[slot] == 1 for slot in state['adSlots']), ('every slot displayed', state['adSlots'], displays)
    assert all(flow.index('display:' + slot) > enable for slot in state['adSlots']), ('display after enableServices', flow)
    assert 'Billboard' in state['requests'], state
    assert not any(value.startswith('local:') for value in state['access']), state
    if capped:
        assert 'guard' not in flow and state['attr'] == [], ('no guard or interstitial attribute when capped', state)
        assert state['takeOver']['status'] == 'frequency-capped' and state['active'] is False, state
        assert 'adsx-takeover-slot' not in state['requests'], state
    else:
        assert flow.count('guard') == 1 and flow.index('guard') < enable, ('guard before enableServices', flow)
        assert flow.index('display:interstitial-guard') > enable, flow
        assert state['active'] is True and state['htmlAttr'] == 'false', state
        assert 'session:read' in state['access'], state


def boot(browser, program, scenario):
    insert = scenario == 'insert'
    page, errors, outbound = load(browser, program, '' if insert else CONTAINERS, {'persisted': scenario == 'capped'})
    try:
        page.clock.run_for(1500)
        if insert:
            assert page.evaluate(STATE)['adSlots'] == [], 'no container at load'
            page.evaluate(INSERT)
            page.clock.run_for(1500)
        pending = page.evaluate(STATE)
        assert_pending(pending, ['Billboard', 'P1'])
        page.evaluate('__emitConsent', 'grant')
        page.clock.run_for(5000)
        state = page.evaluate(STATE)
        assert not errors, errors
        assert not outbound, outbound
        assert_started(state, scenario == 'capped')
        if insert:
            flow = state['flow']
            assert flow.count('define:Billboard') == 1 and flow.count('define:P1') == 1, flow
        return {'pending': pending, 'started': state}
    finally:
        page.close()


def keywords(browser, program):
    page, errors, outbound = load(browser, program, CONTAINERS, {'keywords': {'pageType': 'naslovna', 'category': 'Sport', 'tags': ['a', 'b']}})
    try:
        page.clock.run_for(2000)
        page.evaluate("window.adsKeywords={pageType:'naslovna',category:'Politika',tags:['c']}")
        page.clock.run_for(2000)
        page.evaluate('__emitConsent', 'grant')
        page.clock.run_for(5000)
        state = page.evaluate(STATE)
        assert not errors, errors
        assert not outbound, outbound
        assert 'Billboard' in state['requests'], state
        return state
    finally:
        page.close()


results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
    for mode in ['gam', 'prebid']:
        for extension in ['.js', '.min.js']:
            program = '3.21.2-%s-5%s' % (mode, extension)
            for scenario in ['accept', 'capped', 'insert']:
                try:
                    results.append({'check': 'boot', 'program': program, 'scenario': scenario, 'passed': True, 'evidence': boot(browser, program, scenario)})
                except Exception as error:
                    results.append({'check': 'boot', 'program': program, 'scenario': scenario, 'passed': False, 'error': str(error)})
    for mode in ['gam', 'prebid']:
        for frequency in [5, 30]:
            name = '%s-%d.min.js' % (mode, frequency)
            try:
                current, reference = keywords(browser, '3.21.2-' + name), keywords(browser, '3.21.0-' + name)
                assert current['targeting'] == reference['targeting'], ('page targeting differs from 3.21.0', current['targeting'], reference['targeting'])
                assert current['targeting']['category'] == ['Sport'] and current['targeting']['tags'] == ['a', 'b'], current['targeting']
                late = [entry for entry in current['kv'] if entry[2] and entry[0] in ('category', 'tags', 'pageType')]
                assert late == [], ('page key-values written at the decision', late)
                results.append({'check': 'keywords-vs-3.21.0', 'program': name, 'passed': True, 'evidence': {'3.21.2': current['targeting'], '3.21.0': reference['targeting'], 'kv3212': current['kv']}})
            except Exception as error:
                results.append({'check': 'keywords-vs-3.21.0', 'program': name, 'passed': False, 'error': str(error)})
    version = browser.version
    browser.close()
report = {'browser': version, 'manifest': manifest, 'scope': 'Full generated program, synthetic CMP/GPT/Prebid, every external request blocked, virtual clock', 'results': results}
(output / 'browser-results.json').write_text(json.dumps(report, indent=2) + '\n')
failed = [result for result in results if not result['passed']]
print(json.dumps({'checks': len(results), 'failed': failed}, indent=2))
raise SystemExit(1 if failed else 0)
