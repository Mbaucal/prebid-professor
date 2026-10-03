"""Exercise generated wrappers in Chromium with local GPT/Prebid mocks only."""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/reporting-evidence'
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
html = '<!doctype html><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:2400px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="Overlay" class="wrapperAd"></div></body>'
keys = ['refresh_count', 'refresh_bucket', 'refresh_interval', 'refresh_policy', 'aq_bid_count', 'aq_bidder_count', 'aq_timed_out']
hook = r'''
window.__sent=[];window.__late=[];Math.random=()=>0.2;
const nativeRefresh=__testAds.service.refresh;
__testAds.service.refresh=function(list,options){
  for(const slot of list||[])__sent.push({id:slot.id,targeting:Object.fromEntries(Object.entries(slot.targeting).filter(([k,v])=>v!==null))});
  return nativeRefresh.call(this,list,options);
};
let sequence=0;
pbjs.requestBids=function(input){
  __testAds.observations.bids.push(JSON.parse(JSON.stringify(input)));
  const id='auction-'+(++sequence),results={};
  for(const unit of input.adUnits){
    const bid={auctionId:id,adUnitCode:unit.code,bidderCode:'pubmatic',cpm:1.2,adId:id+'-'+unit.code};
    results[unit.code]={bids:[bid,{...bid},{...bid,adId:bid.adId+'-second'},
      {...bid,adId:'old',auctionId:'old'},{...bid,adId:'zero',cpm:0}]};
  }
  if(window.__mode==='fallback'){__late.push(()=>input.bidsBackHandler(results,false,id));return;}
  if(window.__mode==='zero')for(const row of Object.values(results))row.bids=[];
  setTimeout(()=>input.bidsBackHandler(results,window.__mode==='timeout',id),1);
};
pbjs.getAdserverTargetingForAdUnitCode=code=>({hb_bidder:'pubmatic',hb_pb:'1.20',hb_adid:'bid-'+code});
'''
results = []
def check(value, message):
    if not value: raise AssertionError(message)

def exercise(browser, name, engine, extension, mode='valid', empty=False):
    page = browser.new_page(viewport={'width':1280,'height':900})
    errors, external = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('**/*', lambda route: (external.append(route.request.url),route.abort()))
    try:
        page.clock.install(time=1790164800000)
        page.set_content(html)
        page.evaluate('(v)=>{window.__mode=v.mode;window.__testOptions={takeoverResult:v.empty?"empty":"filled"};}', {'mode':mode,'empty':empty})
        page.add_script_tag(content=mock)
        page.add_script_tag(content=hook)
        page.add_script_tag(content=(out/(name+'-'+engine+extension)).read_text())
        page.clock.run_for(1800)
        page.wait_for_timeout(100)
        if page.locator('#adsx-takeover-close').is_visible(): page.locator('#adsx-takeover-close').click()
        # Lazy fetch is allowed before render, but the actual GPT request keeps its auction result.
        page.evaluate('scrollTo(0,1650)')
        page.wait_for_timeout(100)
        page.clock.run_for(500)
        page.evaluate('scrollTo(0,2600)')
        page.wait_for_timeout(100)
        page.clock.run_for(1000)
        page.evaluate('scrollTo(0,0)')
        page.wait_for_timeout(100)
        page.clock.run_for(200)
        page.evaluate("__testAds.emit('slotVisibilityChanged',{slot:adSlots.Billboard,inViewPercentage:100})")
        # Real dwell/refresh timers run; keep the synthetic page active.
        for _ in range(14):
            page.evaluate("document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}))")
            page.clock.run_for(10000)
        before_late = page.evaluate('__sent.length')
        if mode == 'fallback':
            page.evaluate('__late.forEach(fn=>fn())')
            page.clock.run_for(500)
            check(page.evaluate('__sent.length') == before_late, 'Late callbacks duplicated a GAM request')
        data = page.evaluate('({sent:__sent,bids:__testAds.observations.bids,requests:__testAds.observations.requests})')
        check(not errors, 'Page errors: '+str(errors))
        check(not external, 'Unexpected network requests: '+str(external))
        check(any(r['id']=='P1' for r in data['sent']), 'BTF did not render')
        billboard = [r for r in data['sent'] if r['id']=='Billboard']
        check(len(billboard)>=5, 'Expected four real dwell refreshes: '+str(len(billboard)))
        if engine == 'reporting':
            seen = {}
            for row in data['sent']:
                slot,t=row['id'],row['targeting'];n=seen.get(slot,0);seen[slot]=n+1
                check(t.get('refresh_count')==str(n), 'Wrong request count: '+str(row))
                check(t.get('refresh_bucket')==('initial' if n==0 else 'r1_3' if n<=3 else 'r4_plus'), 'Wrong bucket: '+str(row))
                check(t.get('refresh_interval')==('initial' if n==0 else '30'), 'Wrong selected interval: '+str(row))
                gam=name in ['gam','sticky-gam'] or slot=='interstitial-guard' or (name=='gam-overlay' and slot=='adsx-takeover-slot')
                expect_policy='initial' if n==0 else 'gam_only' if gam else 'prebid_fallback' if mode=='fallback' else 'fresh_auction'
                check(t.get('refresh_policy')==expect_policy, 'Wrong path: '+str(row))
                if gam or mode=='fallback':
                    check(not any(k.startswith('aq_') for k in t), 'GAM/fallback has aq data: '+str(row))
                else:
                    check(t.get('aq_bid_count')==('0' if mode=='zero' else '2'), 'Wrong bid count: '+str(row))
                    check(t.get('aq_bidder_count')==('0' if mode=='zero' else '1'), 'Wrong bidder count: '+str(row))
                    check(t.get('aq_timed_out')==('yes' if mode=='timeout' else 'no'), 'Wrong timeout: '+str(row))
            if name.startswith('sticky'): check(seen.get('Sticky',0)>=5, 'Sticky refresh not covered')
            if empty: check(seen.get('interstitial-guard')==1,'Missing or repeated GAM guard')
        if name in ['gam','sticky-gam']: check(not data['bids'], 'GAM-only requested Prebid')
        return {'requests':[{k:v for k,v in r.items() if k!='at'} for r in data['requests']], 'bids':data['bids'],
                'targeting':[{k:v for k,v in r['targeting'].items() if k not in keys} for r in data['sent']]}
    finally:
        page.close()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
    # The actual bundled Worker must serialize a self-contained browser helper.
    # This catches compiler-injected names that ordinary Node fixtures cannot.
    compiled = out/'compiled-worker-gam.js'
    if compiled.exists():
        page=browser.new_page(viewport={'width':1280,'height':900});errors=[];external=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/*',lambda route:(external.append(route.request.url),route.abort()))
        try:
            page.clock.install(time=1790164800000);page.set_content(html)
            page.add_script_tag(content=mock);page.add_script_tag(content=hook)
            page.add_script_tag(content=compiled.read_text());page.clock.run_for(2500)
            page.wait_for_timeout(100)
            check(not errors and not external,'Compiled Worker errors/network: '+str(errors+external))
            rows=page.evaluate('__sent');check(rows,'Compiled Worker script sent no ads')
            for row in rows:
                check(row['targeting'].get('refresh_bucket')=='initial','Compiled helper failed: '+str(row))
                check(row['targeting'].get('refresh_count')=='0','Compiled count failed')
                check(not any(k.startswith('aq_') for k in row['targeting']),'Compiled GAM-only sends aq')
            results.append({'case':'Compiled Worker browser output / GAM-only','passed':True})
            print('PASS Compiled Worker browser output / GAM-only',flush=True)
        except Exception as error:
            results.append({'case':'Compiled Worker browser output / GAM-only','passed':False,'error':str(error)})
            print('FAIL Compiled Worker: '+str(error),flush=True)
        finally: page.close()
    cases=[(n,'valid',False) for n in ['prebid','gam','gam-overlay','sticky-prebid','sticky-gam','legacy-lazy']]
    cases += [('prebid','timeout',False),('prebid','zero',False),('prebid','fallback',False),('prebid','valid',True)]
    for extension in ['.js','.min.js']:
        for name,mode,empty in cases:
            label=f'{name}/{mode}/empty={empty}/{extension}'
            try:
                base=exercise(browser,name,'base',extension,mode,empty)
                reporting=exercise(browser,name,'reporting',extension,mode,empty)
                check(base==reporting, 'Delivery/auction/hb/Variant behavior differs: '+json.dumps({'base':base,'reporting':reporting}))
                results.append({'case':label,'passed':True})
                print('PASS '+label,flush=True)
            except Exception as error:
                results.append({'case':label,'passed':False,'error':str(error)})
                print('FAIL '+label+': '+str(error),flush=True)
    browser.close()
(out/'browser-results.json').write_text(json.dumps(results,indent=2))
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
