"""Generated revenue wrapper + locked native Prebid, synthetic SSP/GAM decision.
No real GAM line item, SSP deal activation or paid ad request is exercised.
"""
import json,os,sys
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/('.generated/stable-revenue-evidence' if '--stable' in sys.argv else '.generated/revenue-evidence');out.mkdir(parents=True,exist_ok=True)
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text();a=mock.index('  window.pbjs = {');b=mock.index('  window.__tcfapi =',a);mock=mock[:a]+mock[b:]
native=(root/'vendor/prebid/tanjug-11.34.0/prebid.js').read_text()
hook=r'''
window.__sent=[];window.__rendered=[];window.__wire=[];window.__noBid=false;window.__cmpCallbacks=[];
const cmp=window.__tcfapi;window.__tcfapi=function(command,version,callback){if(command==='addEventListener')__cmpCallbacks.push(callback);return cmp(command,version,callback);};
__testAds.service.addEventListener('slotRenderEnded',event=>__rendered.push(event.slot.id));
const refresh=__testAds.service.refresh;
__testAds.service.refresh=function(slots,options){for(const slot of slots||[])__sent.push({code:slot.id,targeting:JSON.parse(JSON.stringify(slot.targeting))});return refresh.call(this,slots,options);};
googletag.apiReady=true;googletag.pubadsReady=true;
window.pbjs={que:[function(){
 for(const [name,cpm,dealId] of [['ix',1.2,null],['pubmatic',.95,'0000199']])pbjs.registerBidAdapter(null,name,{
  code:name,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
  buildRequests(bids){__wire.push(...bids.map(b=>({bidder:name,code:b.adUnitCode,params:b.params})));return {method:'GET',url:'https://deals-fixture.invalid/bid',data:{payload:JSON.stringify(__noBid?[]:bids.map(b=>({requestId:b.bidId,cpm,ttl:120,currency:'EUR',netRevenue:true,creativeId:name+'-creative',ad:'<div id="creative-'+name+'">Synthetic '+name+'</div>',width:300,height:250,...(dealId?{dealId}:{} )})))},options:{withCredentials:false}};},
  interpretResponse(response){return response.body.bids;}
 });
}]};
'''
html='<!doctype html><link rel="icon" href="data:,"><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:1800px"></div><div id="P1" class="wrapperAd" style="height:250px"></div></body>'
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
 for width in [1440,390]:
  for filename in ['prebid.js','prebid.min.js','gam.js']:
   page=browser.new_page(viewport={'width':width,'height':900});external=[];errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   def route(r):
    if r.request.url=='https://deals-fixture.invalid/fixture':r.fulfill(content_type='text/html',body=html)
    elif r.request.url.startswith('https://deals-fixture.invalid/bid'):
     r.fulfill(headers={'content-type':'application/json','access-control-allow-origin':'*'},body=json.dumps({'bids':json.loads(parse_qs(urlparse(r.request.url).query)['payload'][0])}))
    elif r.request.url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
     r.fulfill(headers={'content-type':'application/json','access-control-allow-origin':'*'},body=json.dumps({'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'USD':1,'EUR':1}}}))
    else:external.append(r.request.url);r.abort()
   page.route('**/*',route)
   try:
    page.clock.install(time=datetime(2026,10,11,12,tzinfo=timezone.utc))
    page.goto('https://deals-fixture.invalid/fixture');page.add_script_tag(content=mock);page.add_script_tag(content=hook)
    if filename!='gam.js':page.add_script_tag(content=native)
    page.add_script_tag(content=(out/filename).read_text())
    for _ in range(30):
     page.clock.run_for(100);page.wait_for_timeout(15)
     if page.evaluate('__sent.some(s=>s.code==="Billboard")&&__rendered.includes("Billboard")'):break
    assert page.evaluate('__rendered.includes("Billboard")'),'Synthetic GPT must finish its placeholder before the selected native creative replaces it'
    captures=page.evaluate('__sent.filter(s=>s.code==="Billboard")');assert captures,captures
    target=captures[-1]['targeting']
    if filename=='gam.js':
     assert not any(k.startswith('hb_') and k!='hb_ver' for k,v in target.items() if v is not None),target
     assert page.evaluate('__wire.length')==0
    else:
     def scalar(v):return v[0] if isinstance(v,list) else v
     assert scalar(target['hb_deal_pubmatic'])=='0000199',target
     assert scalar(target['hb_pb_ix'])=='1.20' and scalar(target['hb_pb_pubmatic'])=='0.95',target
     deal_ad=scalar(target['hb_adid_pubmatic']);open_ad=scalar(target['hb_adid_ix']);assert deal_ad!=open_ad
     bid=page.evaluate('(id)=>pbjs.getBidResponses().Billboard.bids.find(b=>b.adId===id)',deal_ad)
     assert bid['dealId']=='0000199' and bid['bidderCode']=='pubmatic'
     assert page.evaluate('__wire.some(b=>b.bidder==="pubmatic"&&b.params.deals?.[0]==="0000199")'),page.evaluate('({wire:__wire,date:new Date().toISOString()})')
     # Simulated GAM chooses its contracted deal line; native renderAd resolves that exact bid.
     page.evaluate('id=>{const frame=document.createElement("iframe");frame.id="deal-render";document.querySelector("#Billboard").replaceChildren(frame);pbjs.renderAd(frame.contentDocument,id);}',deal_ad)
     page.clock.run_for(100);page.wait_for_timeout(25)
     assert page.frame_locator('#deal-render').frame_locator('iframe').locator('#creative-pubmatic').count()==1,page.evaluate('({html:document.querySelector("#deal-render")?.contentDocument?.documentElement.outerHTML,events:pbjs.getEvents().filter(e=>e.eventType==="adRenderFailed")})')
     assert page.frame_locator('#deal-render').frame_locator('iframe').locator('#creative-pubmatic').text_content()=='Synthetic pubmatic'
     assert page.frame_locator('#deal-render').frame_locator('iframe').locator('#creative-ix').count()==0
     page.screenshot(path=str(out/f'deals-selected-{filename}-{width}.png'))
     page.evaluate('__noBid=true')
     before=len(captures)
     for _ in range(45):
      page.clock.run_for(1000);page.wait_for_timeout(10)
      if page.evaluate('__sent.filter(s=>s.code==="Billboard").length')>before:break
     fresh=page.evaluate('__sent.filter(s=>s.code==="Billboard")');assert len(fresh)>before,'No completed refresh'
     assert not any(k.startswith('hb_deal') or k.startswith('hb_adid') for k,v in fresh[-1]['targeting'].items() if v is not None),fresh[-1]
     wire_before=page.evaluate('__wire.length');sent_before=len(fresh)
     page.clock.set_system_time(datetime(2027,1,2,12,tzinfo=timezone.utc))
     for _ in range(45):
      page.clock.run_for(1000);page.wait_for_timeout(10)
      if page.evaluate('__sent.filter(s=>s.code==="Billboard").length')>sent_before:break
     assert page.evaluate('__sent.filter(s=>s.code==="Billboard").length')>sent_before,'No expiry-boundary refresh'
     expired=page.evaluate('(offset)=>__wire.slice(offset).filter(b=>b.bidder==="pubmatic")',wire_before)
     assert expired and all('deals' not in b['params'] for b in expired),expired
     count=page.evaluate('__sent.length')
     page.evaluate('__cmpCallbacks.forEach(cb=>cb({gdprApplies:true,cmpStatus:"loaded",eventStatus:"cmpuishown",listenerId:1},true))')
     page.clock.run_for(45000);page.wait_for_timeout(25)
     assert page.evaluate('__sent.length')==count,'A pending CMP decision must block new GAM requests'

    assert not external,external;assert not errors,errors
    page.screenshot(path=str(out/f'deals-{filename}-{width}.png'))
    results.append({'file':filename,'width':width,'passed':True,'externalRequests':len(external),'decision':'synthetic GAM, native Prebid renderAd'})
   finally:page.close()
 browser.close()
(out/'deals-native-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps({'passed':len(results),'evidence':str(out)}))
