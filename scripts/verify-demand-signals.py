"""CI: generated wrappers + native Prebid core, synthetic adapters/GPT, no live ads.
The vendored core lacks gptPreAuction. This exercises Tessera's explicit metadata
and native Send All Bids; a full partner build still needs staging wire checks.
"""
import json, os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/demand-evidence'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
a=mock.index('  window.pbjs = {');b=mock.index('  window.__tcfapi =',a)
mock=mock[:a]+mock[b:]
prebid=(root/'vendor/prebid/tanjug-11.34.0/prebid.js').read_text()
html='<!doctype html><link rel="icon" href="data:,"><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:2400px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="Overlay" class="wrapperAd"></div></body>'
hook=r'''
window.__sent=[];window.__bidInput=[];
const originalRefresh=__testAds.service.refresh;
__testAds.service.refresh=function(slots,options){
 for(const slot of slots||[])__sent.push({id:slot.id,targeting:JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(slot.targeting).filter(([k,v])=>v!==null))))});
 return originalRefresh.call(this,slots,options);
};
googletag.apiReady=true;googletag.pubadsReady=true;
window.pbjs={que:[function(){
 for(const [name,cpm] of [['pubmatic',1.5],['openx',1.1],['criteo',.7]])pbjs.registerBidAdapter(null,name,{
  code:name,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
  buildRequests(bids){
   __bidInput.push(...bids.map(b=>({bidder:name,code:b.adUnitCode,gpid:b.ortb2Imp?.ext?.gpid,adslot:b.ortb2Imp?.ext?.data?.adserver?.adslot})));
   return {method:'GET',url:'https://demand-fixture.invalid/bid',data:{payload:JSON.stringify(window.__noBid?[]:bids.map(b=>({
    requestId:b.bidId,cpm,ttl:120,currency:'EUR',netRevenue:true,creativeId:'synthetic',ad:'<div>Fixture</div>',
    width:b.mediaTypes.banner.sizes[0][0],height:b.mediaTypes.banner.sizes[0][1],...(name==='criteo'?{dealId:'fixture-deal'}:{})
   })))},options:{withCredentials:false}};
  },interpretResponse(response){return response.body.bids;}
 });
}]};
'''
results=[]
def check(value,message):
 if not value:raise AssertionError(message)
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
 for name in ['prebid','gam']:
  for extension in ['.js','.min.js']:
   page=browser.new_page(viewport={'width':1280,'height':900});errors=[];external=[];logs=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.on('console',lambda m:logs.append(m.text))
   def route(r):
    if r.request.url=='https://demand-fixture.invalid/fixture':
     r.fulfill(status=200,content_type='text/html',body=html)
    elif r.request.url.startswith('https://demand-fixture.invalid/bid'):
     bids=json.loads(parse_qs(urlsplit(r.request.url).query)['payload'][0])
     r.fulfill(status=200,headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body=json.dumps({'bids':bids}))
    elif r.request.url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
     r.fulfill(status=200,headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},body=json.dumps({'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'USD':1,'EUR':1}}}))
    else:external.append(r.request.url);r.abort()
   page.route('**/*',route)
   try:
    page.clock.install(time=1790164800000);page.goto('https://demand-fixture.invalid/fixture')
    page.add_script_tag(content=mock);page.add_script_tag(content=hook)
    if name=='prebid':page.add_script_tag(content=prebid)
    page.add_script_tag(content=(out/(name+extension)).read_text())
    page.wait_for_function('__sent.some(r=>r.id==="Billboard")')
    page.wait_for_timeout(800)
    if page.locator('#adsx-takeover-close').is_visible():page.locator('#adsx-takeover-close').click()
    page.evaluate('scrollTo(0,2600)');page.wait_for_timeout(800)
    check(page.evaluate('__sent.some(r=>r.id==="P1")'),'Lazy unit did not reach GAM')
    page.evaluate('scrollTo(0,0)');page.wait_for_timeout(100)
    page.evaluate("__testAds.emit('slotVisibilityChanged',{slot:adSlots.Billboard,inViewPercentage:100})")
    # Clock drives dwell timers, native XHR completion gets real event-loop time.
    for _ in range(40):
     page.evaluate("document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}))")
     page.clock.run_for(1000);page.wait_for_timeout(100)
    rows=page.evaluate('__sent.filter(r=>r.id==="Billboard")')
    check(len(rows)>=2,'No actual dwell refresh')
    if name=='prebid':
     config=page.evaluate('({all:pbjs.getConfig("enableSendAllBids"),deals:pbjs.getConfig("targetingControls").alwaysIncludeDeals})')
     check(config=={'all':True,'deals':True},'Wrong native Prebid config: '+str(config))
     first=rows[0]['targeting']
     check(rows[-1]['targeting'].get('hb_pb_pubmatic')=='1.50' and rows[-1]['targeting'].get('aq_timed_out')=='no','Positive refresh auction did not complete: '+str(rows[-1]))
     for bidder in ['pubmatic','openx','criteo']:check(first.get('hb_pb_'+bidder),'Missing bidder price '+bidder+': '+str(first))
     check(first.get('hb_deal_criteo')=='fixture-deal','Deal targeting missing: '+str(first))
     expected=json.loads((out/'prebid.json').read_text())['placements'];seen=page.evaluate('__bidInput')
     check({'Billboard','P1','Sticky','Overlay'}<=set(r['code'] for r in seen),'Missing auction path: '+str(seen))
     for row in seen:
      check(row['gpid']==expected[row['code']]['gpid'] and row['adslot']==expected[row['code']]['adslot'],'Unstable/lost GPID: '+str(row))
     page.evaluate('window.__noBid=true')
     count=len(rows)
     for _ in range(40):
      page.evaluate("document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}))")
      page.clock.run_for(1000);page.wait_for_timeout(100)
     later=page.evaluate('__sent.filter(r=>r.id==="Billboard")')
     check(len(later)>count,'No no-bid refresh')
     check(later[-1]['targeting'].get('aq_bid_count')=='0' and later[-1]['targeting'].get('aq_timed_out')=='no','Expected completed empty auction: '+str(later[-1]))
     check(not any(k.startswith('hb_') and k not in ['hb_ver','hb_version'] for k in later[-1]['targeting']),'Stale bidder/deal targeting: '+str(later[-1]))
    else:
     check(page.evaluate('__bidInput.length')==0,'GAM-only made Prebid requests')
     for row in page.evaluate('__sent'):
      check(not any(k.startswith(('hb_','aq_')) for k in row['targeting']),'GAM-only includes Prebid keys')
      check('refresh_bucket' in row['targeting'],'GAM-only lost refresh reporting')
    check(not errors,'Page errors: '+str(errors));check(not external,'External traffic: '+str(external))
    results.append({'case':name+extension,'passed':True});print('PASS '+name+extension,flush=True)
   except Exception as e:
    print(json.dumps({'case':name+extension,'inputs':page.evaluate('window.__bidInput'),'sent':page.evaluate('window.__sent'),'logs':[x for x in logs if 'ERROR' in x or 'WARN' in x][-15:],'pageErrors':errors,'external':external}),flush=True)
    results.append({'case':name+extension,'passed':False,'error':str(e),'pageErrors':errors});print('FAIL '+name+extension+': '+str(e),flush=True)
   finally:page.close()
 browser.close()
(out/'browser-results.json').write_text(json.dumps(results,indent=2))
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
