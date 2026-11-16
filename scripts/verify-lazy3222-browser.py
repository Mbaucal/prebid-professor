"""Full generated 3.22.1/3.22.2 lazy-observer checks in Chromium.

GPT, Prebid and CMP are synthetic. IntersectionObserver delivery and the clock
are controlled; every HTTP(S) request is intercepted. This proves the emitted
readable/minified programs' observer/readiness integration, not SSP acceptance.
Run prepare-lazy3222-browser-fixtures.mjs first.
"""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.generated/lazy3222-evidence'
MOCK = (ROOT / 'tests/runtime/mock-ad-libraries.js').read_text()
HTML = '<!doctype html><body><div id="P1" class="wrapperAd lazyAd"></div></body>'
SETUP = '''(() => {
 window.__lazyIO=[];
 window.IntersectionObserver=class {
  constructor(callback,options){this.callback=callback;this.options=options;this.targets=new Set();window.__lazyIO.push(this);}
  observe(element){this.targets.add(element);}
  unobserve(element){this.targets.delete(element);}
  disconnect(){this.targets.clear();}
  fire(){const element=document.getElementById('P1');this.callback([{target:element,isIntersecting:true,intersectionRatio:1}],this);}
 };
})()'''
LIBRARIES = '''(() => {
 const handlers={},auctions=[],targets={},responses={};
 window.__auctions=auctions;
 Object.assign(pbjs,{
  version:'11.11.0',
  onEvent(name,fn){(handlers[name]||(handlers[name]=new Set())).add(fn);},
  offEvent(name,fn){handlers[name]?.delete(fn);},
  getAdserverTargetingForAdUnitCode(code){return targets[code]||{};},
  getBidResponses(){return responses;},
  requestBids(input){
   auctions.push(input);
   for(const fn of [...handlers.auctionInit||[]])fn({auctionId:input.auctionId});
   if(window.__throwRequest)throw Error('Synthetic request failure');
  },
 });
 window.__finishAuction=(index,ttl=300,noBid=false)=>{
  const input=auctions[index];if(!input)throw Error('No auction '+index);
  const bids={};for(const unit of input.adUnits||[]){
   const adId='local-'+index+'-'+unit.code;
   const bid={auctionId:input.auctionId,adUnitCode:unit.code,bidder:'ix',adId,cpm:1,ttl,responseTimestamp:Date.now()};
   bids[unit.code]={bids:noBid?[]:[bid]};responses[unit.code]=bids[unit.code];
   targets[unit.code]=noBid?{}:{hb_adid:adId,hb_bidder:'ix',hb_pb:'1.00'};
  }
  input.bidsBackHandler(bids,false,input.auctionId);
 };
 const cmpListeners=[];
 window.__cmpData={gdprApplies:false,listenerId:1,eventStatus:'tcloaded',cmpStatus:'loaded'};
 window.__tcfapi=(command,version,callback)=>{
  if(command==='addEventListener'){cmpListeners.push(callback);callback({...__cmpData},true);}
  else if(command==='getTCData')callback({...__cmpData},true);
  else callback(true);
 };
 window.__emitCmp=data=>{window.__cmpData=data;for(const callback of cmpListeners)callback({...data,listenerId:1},true);};
 window.__fireLazy=step=>{
  const observer=__lazyIO.find(o=>step==='display'
   ?o.options.rootMargin==='0px'&&Array.isArray(o.options.threshold)
   :o.options.rootMargin!=='0px'&&o.options.threshold===0);
  if(!observer)throw Error('Missing '+step+' observer');observer.fire();
 };
})()'''
PENDING = "{gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown'}"
DECIDED = "{gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'}"
SCENARIOS = [
 'display-complete-late-prefetch',
 'display-inflight-prefetch',
 'prefetch-queued-display',
 'prefetch-inflight-display',
 'prefetch-ready-display',
 'repeated-callbacks',
 'expired-prefetch-replacement',
 'no-bid-prefetch',
 'prefetch-timeout',
 'consent-pending-at-load',
 'consent-change-inflight',
 'request-throws',
 'duplicate-completion',
 'gam-only',
]

def run(browser, version, suffix, width, scenario):
    print(f'RUN {version}{suffix} {width} {scenario}', flush=True)
    mode = 'gam' if scenario == 'gam-only' else 'prebid'
    page = browser.new_page(viewport={'width': width, 'height': 900})
    errors, intercepted, checkpoints = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def route(request):
        intercepted.append(request.request.url)
        request.fulfill(status=200, content_type='application/json', body='{"country":"RS"}')
    page.route('**/*', route)
    page.set_content(HTML)
    now = datetime(2026, 11, 16, tzinfo=timezone.utc)
    page.clock.install(time=now)
    page.clock.pause_at(now + timedelta(seconds=1))
    page.add_script_tag(content=SETUP)
    page.add_script_tag(content=MOCK)
    page.add_script_tag(content=LIBRARIES)
    if scenario == 'consent-pending-at-load':
        page.evaluate('__emitCmp(' + PENDING + ')')
    page.add_script_tag(content=(OUT / version / mode / ('ads' + suffix)).read_text())
    page.clock.run_for(1500)
    def tick(ms=10):
        page.clock.run_for(ms)
    def fire(step):
        page.evaluate('__fireLazy', step)
        tick()
    def finish(index=0, ttl=300, no_bid=False):
        page.evaluate('([index,ttl,noBid])=>__finishAuction(index,ttl,noBid)', [index, ttl, no_bid])
        tick()
    def state():
        return page.evaluate('''()=>({auctions:__auctions.length,
          requests:__testAds.observations.requests.filter(r=>r.id==='P1').length,
          targeting:window.adSlots?.P1?.targeting||{},
          consent:window.__tesseraReadiness?.snapshot().consent,
          events:window.__tesseraReadiness?.snapshot().events||[]})''')
    if scenario in ('display-complete-late-prefetch', 'gam-only'):
        fire('display')
        if mode == 'prebid':
            finish()
        fire('prefetch')
        tick(250)
    elif scenario == 'display-inflight-prefetch':
        fire('display')
        fire('prefetch')
        finish()
        tick(250)
    elif scenario == 'prefetch-queued-display':
        fire('prefetch')
        fire('display')
        tick(250)
        finish()
    elif scenario == 'prefetch-inflight-display':
        fire('prefetch')
        tick(250)
        fire('display')
        finish()
    elif scenario in ('prefetch-ready-display', 'expired-prefetch-replacement', 'no-bid-prefetch'):
        fire('prefetch')
        tick(250)
        finish(ttl=2 if scenario == 'expired-prefetch-replacement' else 300,
               no_bid=scenario == 'no-bid-prefetch')
        if scenario == 'expired-prefetch-replacement':
            tick(1100)
        fire('display')
        if scenario == 'expired-prefetch-replacement':
            finish(1)
    elif scenario == 'repeated-callbacks':
        fire('display')
        fire('display')
        fire('prefetch')
        finish()
        for _ in range(3):
            fire('display')
            fire('prefetch')
        tick(250)
    elif scenario == 'prefetch-timeout':
        fire('prefetch')
        tick(250)
        fire('display')
        tick(4000)
        finish()  # The late response must not dispatch twice.
    elif scenario == 'consent-pending-at-load':
        tick(250)
        checkpoints.append(state())
        page.evaluate('__emitCmp(' + DECIDED + ')')
        tick(1500)
        fire('display')
        finish()
        fire('prefetch')
        tick(250)
    elif scenario == 'consent-change-inflight':
        fire('display')
        page.evaluate('__emitCmp(' + PENDING + ')')
        tick()
        finish()  # Old-epoch completion is ignored.
        fire('prefetch')
        tick(250)
        checkpoints.append(state())
        page.evaluate('__emitCmp(' + DECIDED + ')')
        tick()
        fire('display')
        fire('prefetch')
        tick(250)
    elif scenario == 'request-throws':
        page.evaluate('window.__throwRequest=true')
        fire('display')
        fire('prefetch')
        tick(250)
    elif scenario == 'duplicate-completion':
        fire('display')
        finish()
        finish()
        fire('prefetch')
        tick(250)
    result = {'version': version, 'suffix': suffix, 'width': width, 'scenario': scenario,
              **state(), 'checkpoints': checkpoints, 'errors': errors,
              'interceptedRequests': intercepted}
    page.close()
    return result

results, failures = [], []
with sync_playwright() as playwright:
    options = {'headless': True, 'args': ['--no-sandbox']}
    if os.environ.get('TESSERA_CHROMIUM_EXECUTABLE'):
        options['executable_path'] = os.environ['TESSERA_CHROMIUM_EXECUTABLE']
    browser = playwright.chromium.launch(**options)
    for width in [1440, 390]:
        for suffix in ['.js', '.min.js']:
            for scenario in SCENARIOS:
                result = run(browser, '3.22.2', suffix, width, scenario)
                results.append(result)
            # Keep the old program as a failure-detection control with the same harness.
            for scenario in ['display-complete-late-prefetch', 'display-inflight-prefetch']:
                results.append(run(browser, '3.22.1', suffix, width, scenario))
    browser.close()
for result in results:
    identity = f"{result['version']}{result['suffix']} {result['width']} {result['scenario']}"
    if result['errors']:
        failures.append(identity + ': page errors ' + repr(result['errors']))
    expected_auctions = 0 if result['scenario'] == 'gam-only' else (
        2 if result['version'] == '3.22.1' or result['scenario'] == 'expired-prefetch-replacement' else 1)
    if result['auctions'] != expected_auctions or result['requests'] != 1:
        failures.append(identity + f": got {result['auctions']} auctions/{result['requests']} GAM, expected {expected_auctions}/1")
    for checkpoint in result['checkpoints']:
        expected = 0 if result['scenario'] == 'consent-pending-at-load' else 1
        if checkpoint['auctions'] != expected or checkpoint['requests'] != 0 or checkpoint['consent']['ready']:
            failures.append(identity + ': pending consent sent or duplicated work ' + repr(checkpoint))
    if result['scenario'] == 'expired-prefetch-replacement':
        if result['targeting'].get('hb_adid') != 'local-1-P1':
            failures.append(identity + ': expired bid survived replacement')
    elif result['version'] == '3.22.2':
        clean = result['scenario'] in ('no-bid-prefetch', 'prefetch-timeout', 'consent-change-inflight', 'request-throws', 'gam-only')
        expected_id = None if clean else 'local-0-P1'
        if result['targeting'].get('hb_adid') != expected_id:
            failures.append(identity + ': missing fresh targeting or stale targeting in clean fallback')
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'browser-results.json').write_text(json.dumps({'results': results, 'failures': failures}, indent=2) + '\n')
for result in results:
    print(json.dumps({key: result[key] for key in ['version', 'suffix', 'width', 'scenario', 'auctions', 'requests']}))
if failures:
    print('\n'.join('FAIL ' + failure for failure in failures))
    raise SystemExit(1)
print(f'Lazy observer matrix passed: {len(results)} generated programs; old-race controls fail as expected, no page errors.')
