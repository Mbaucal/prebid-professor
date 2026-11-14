"""Full generated runtime in Chromium; synthetic CMP/GPT/Prebid, no paid traffic.

Pass a directory containing gam-0/5 and prebid-0/5 .js/.min.js programs. The
release owner can provide final 3.21.1 compiler output without modifying this lab.
"""
import json
import hashlib
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1] if len(sys.argv) > 1 else root / '.generated/storage3211-browser')
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
manifest = json.loads((output / 'manifest.json').read_text())
for name, expected in manifest['files'].items():
    assert hashlib.sha256((output / name).read_bytes()).hexdigest() == expected, 'Generated program changed: ' + name
results = []
now = datetime(2026, 11, 13, 12, tzinfo=timezone.utc)
html = '<!doctype html><body><div id="Billboard" class="wrapperAd" style="height:250px"></div></body>'
hook = r'''
scenario => {
 window.__storageAccess=[]; window.__flow=[]; window.__cmpCallbacks=[];
 window.fetch=()=>Promise.resolve(new Response(JSON.stringify({version:1,status:'known',country:'RS',source:'cloudflare'}),{headers:{'content-type':'application/json'}}));
 const values=new Map();
 if(scenario==='persisted')values.set('tessera:takeover:/123/test/Overlay',String(Date.now()-1000));
 Object.defineProperty(window,'sessionStorage',{configurable:true,get(){
  __storageAccess.push('session:getter');
  if(scenario==='blocked')throw new DOMException('Denied','SecurityError');
  return {getItem(key){__storageAccess.push('session:read');return values.get(key)||null;},
   setItem(key,value){__storageAccess.push('session:write');values.set(key,value);}};
 }});
 Object.defineProperty(window,'localStorage',{configurable:true,get(){__storageAccess.push('local:getter');throw new DOMException('Denied','SecurityError');}});
 window.__tcfapi=(command,version,callback)=>{
  if(command==='addEventListener')__cmpCallbacks.push(callback);
  else if(command==='getTCData')callback({},false);
 };
 window.__emitConsent=(kind)=>__cmpCallbacks.forEach(callback=>callback(kind==='out-of-scope'?{gdprApplies:false}:
  {gdprApplies:true,cmpStatus:'loaded',eventStatus:kind==='pending'?'cmpuishown':'useractioncomplete',
   tcString:'synthetic-current-choice',purpose:{consents:{1:kind==='grant'}}},true));
 const define=googletag.defineOutOfPageSlot;
 googletag.defineOutOfPageSlot=(...args)=>{__flow.push('guard');return define(...args);};
 const enable=googletag.enableServices;
 googletag.enableServices=(...args)=>{__flow.push('enable');return enable(...args);};
 const refresh=__testAds.service.refresh;
 __testAds.service.refresh=function(list,...args){__flow.push('request');return refresh.call(this,list,...args);};
 if(scenario==='missing-prebid')delete window.pbjs;
}
'''
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
    for mode in ['gam', 'prebid']:
        for extension in ['.js', '.min.js']:
            for scenario in ['grant', 'reject', 'out-of-scope', 'persisted', 'blocked', 'revoke-before-render', 'zero', 'empty-atf', 'missing-prebid']:
                page = browser.new_page(viewport={'width': 1440, 'height': 900})
                errors, outbound = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                def route(request):
                    if request.request.url == 'https://storage-fixture.invalid/':
                        request.fulfill(content_type='text/html', body=html if scenario != 'empty-atf' else '<!doctype html><body></body>')
                    else:
                        outbound.append(request.request.url)
                        request.abort()
                page.route('**/*', route)
                try:
                    page.clock.install(time=now)
                    page.clock.pause_at(now + timedelta(seconds=1))
                    page.goto('https://storage-fixture.invalid/')
                    page.add_script_tag(content=mock)
                    page.evaluate(hook, scenario)
                    frequency = 0 if scenario == 'zero' else 5
                    page.add_script_tag(content=(output / (mode + '-' + str(frequency) + extension)).read_text())
                    page.clock.run_for(1500)
                    page.evaluate('adopsDebug.enable();adopsDebug.disable()')
                    assert page.evaluate('__storageAccess') == [], 'Startup touched browser storage'
                    assert page.evaluate('__testAds.observations.requests.length') == 0, 'Pending CMP dispatched ads'
                    choice = 'reject' if scenario == 'reject' else 'out-of-scope' if scenario == 'out-of-scope' else 'grant'
                    page.evaluate('__emitConsent', choice)
                    if scenario == 'revoke-before-render':
                        page.clock.run_for(5)
                        before = page.evaluate('__storageAccess')
                        page.evaluate('__emitConsent', 'pending')
                        page.clock.run_for(100)
                        assert page.evaluate('__storageAccess') == before, 'Render wrote storage after revocation'
                        page.evaluate('__emitConsent', 'reject')
                    page.clock.run_for(5000)
                    result = page.evaluate('({access:__storageAccess,flow:__flow,requests:__testAds.observations.requests,state:takeOverDebug.state()})')
                    assert not errors, errors
                    assert not outbound, outbound
                    assert not any(value.startswith('local:') for value in result['access']), result
                    overlays = [request for request in result['requests'] if request['id'] == 'adsx-takeover-slot']
                    if scenario == 'persisted':
                        assert len(overlays) == 0 and result['state']['status'] == 'frequency-capped', result
                        assert 'guard' not in result['flow'], result
                    else:
                        assert len(overlays) == 1, result
                        if scenario in ['reject', 'zero']:
                            assert result['access'] == [], result
                        elif scenario not in ['blocked', 'revoke-before-render']:
                            assert 'session:read' in result['access'] and 'session:write' in result['access'], result
                        if 'enable' in result['flow']:
                            assert result['flow'].index('guard') < result['flow'].index('enable'), result
                    if scenario != 'empty-atf':
                        assert any(request['id'] == 'Billboard' for request in result['requests']), result
                    results.append({'mode': mode, 'source': extension, 'scenario': scenario, 'passed': True, 'evidence': result})
                except Exception as error:
                    results.append({'mode': mode, 'source': extension, 'scenario': scenario, 'passed': False, 'error': str(error), 'errors': errors, 'outbound': outbound})
                finally:
                    page.close()
    version = browser.version
    browser.close()
report = {'browser': version, 'manifest': manifest, 'scope': 'Full generated program, synthetic CMP/GPT/Prebid, every external request blocked', 'results': results}
(output / 'browser-results.json').write_text(json.dumps(report, indent=2) + '\n')
failed = [result for result in results if not result['passed']]
print(json.dumps({'checks': len(results), 'failed': failed}, indent=2))
raise SystemExit(1 if failed else 0)
