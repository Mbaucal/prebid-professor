"""Actual generated script in Chromium, native locked Prebid and intercepted demand.
Before/after reproductions are local; there are no real GAM or paid requests.
"""
import json,os
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/runtime3161-evidence'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
native=(root/'vendor/prebid/tanjug-11.34.0/prebid.js').read_text()
native_hook=r'''
window.__wire=[];window.__rounds={};window.__auctions=[];
window.pbjs={que:[function(){window.__adapterInstalled=true;
 for(const name of ['pubmatic','ix'])pbjs.registerBidAdapter(null,name,{
  code:name,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
  buildRequests(bids){
   return {method:'GET',url:'https://audit-fixture.invalid/bid',data:{payload:JSON.stringify(bids.map(b=>{
    const key=name+':'+b.adUnitCode,round=(__rounds[key]||0)+1;__rounds[key]=round;
    const ttl=__scenario==='valid'?300:__scenario==='mixed'?(name==='pubmatic'?30:360):__scenario==='secondary'?(name==='pubmatic'?360:30):55;
    const cpm=name==='pubmatic'?2:1;
    __wire.push({code:b.adUnitCode,bidder:name,round,ttl,at:Date.now()});
    return {requestId:b.bidId,cpm,ttl,currency:'EUR',netRevenue:true,creativeId:name+'-'+round,
      ad:'<div>Synthetic '+name+' '+round+'</div>',width:300,height:250};
   }))},options:{withCredentials:false}};
  },interpretResponse:r=>r.body.bids
 });
 pbjs.onEvent('auctionInit',a=>__auctions.push({id:a.auctionId,codes:a.adUnitCodes,at:Date.now()}));
}]};
'''
hook=r'''
window.__sent=[];const send=__testAds.service.refresh;
__testAds.service.refresh=function(slots,opts){for(const slot of slots||[])__sent.push({code:slot.id,at:Date.now(),targeting:JSON.parse(JSON.stringify(slot.targeting))});return send.call(this,slots,opts);};
googletag.apiReady=true;googletag.pubadsReady=true;
'''
normal='<!doctype html><link rel="icon" href="data:,"><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div></body>'
native_html='<!doctype html><link rel="icon" href="data:,"><body style="margin:0;height:3000px"><div id="Billboard" class="wrapperAd" style="position:absolute;top:0;height:250px"></div><div id="P1" class="wrapperAd" style="position:absolute;top:1800px;height:250px"></div></body>'
results=[]
def run(browser,version,name,extension,fn,width=1440,html=normal,native_mode=None):
 page=browser.new_page(viewport={'width':width,'height':900});errors=[];external=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 def route(r):
  url=r.request.url
  if url=='https://audit-fixture.invalid/fixture':r.fulfill(content_type='text/html',body=html)
  elif url.startswith('https://audit-fixture.invalid/bid'):
   r.fulfill(content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'bids':json.loads(parse_qs(urlparse(url).query)['payload'][0])}))
  elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
   r.fulfill(content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'USD':1,'EUR':1}}}))
  else:external.append(url);r.abort()
 page.route('**/*',route)
 try:
  page.clock.install(time=datetime(2026,10,24,12,tzinfo=timezone.utc));page.goto('https://audit-fixture.invalid/fixture');page.evaluate('window.__testOptions={}')
  if native_mode:
   a=mock.index('  window.pbjs = {');b=mock.index('  window.__tcfapi =',a);page.add_script_tag(content=mock[:a]+mock[b:]);page.evaluate('(v)=>window.__scenario=v',native_mode);page.add_script_tag(content=native_hook);page.add_script_tag(content=native)
  else:page.add_script_tag(content=mock)
  page.add_script_tag(content=hook)
  page.add_script_tag(content=(out/version/(name+extension)).read_text())
  details=fn(page)
  assert not errors,errors;assert not external,external
  results.append({'version':version,'name':name,'file':extension,'width':width,'passed':True,'externalRequests':0,'details':details})
 except Exception as e:
  evidence=page.evaluate('({sent:window.__sent,wire:window.__wire,adapter:window.__adapterInstalled,events:window.pbjs?.getEvents?.().slice(-10),readiness:window.__tesseraReadiness?.snapshot()})')
  results.append({'version':version,'name':name,'file':extension,'width':width,'passed':False,'error':str(e),'errors':errors,'external':external,'evidence':evidence})
  print(json.dumps(results[-1])[:6000]);raise
 finally:page.close()
def advance(page,ms):
 page.clock.run_for(ms);page.wait_for_timeout(30)
def late(delay,expected,attribute='id'):
 def check(page):
  advance(page,delay)
  page.evaluate('''attribute=>{const x=document.createElement('div');x.innerHTML='<div '+attribute+'="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:1500px"></div><div '+attribute+'="P1" class="wrapperAd" style="height:250px"></div><div style="height:1000px"></div>';document.body.appendChild(x);}''',attribute)
  advance(page,2500);page.evaluate('scrollTo(0,1800)');page.wait_for_timeout(40);advance(page,1500)
  counts=page.evaluate('Object.fromEntries(["Billboard","P1"].map(code=>[code,__sent.filter(s=>s.code===code).length]))')
  assert counts==expected,counts;return counts
 return check
def sticky_only(page):
 advance(page,25000);assert page.locator('#Sticky').evaluate("e=>e.classList.contains('ad-loaded')");return {'stickyRequests':page.evaluate('__sent.filter(s=>s.code==="Sticky").length')}
def empty_sticky(page):
 # Set next refresh response empty after the first filled impression; then recover.
 advance(page,1000);page.evaluate('__testOptions.allEmpty=true');advance(page,32000);page.evaluate('__testOptions.allEmpty=false');advance(page,35000)
 count=page.evaluate('__sent.filter(s=>s.code==="Sticky").length');assert count>=3,count;assert page.locator('#Sticky').evaluate("e=>e.classList.contains('ad-loaded')");page.locator('#close_sticky_ad').click();advance(page,70000);assert page.evaluate('__sent.filter(s=>s.code==="Sticky").length')==count;return {'stickyRequests':count,'closedNoExtraRequest':True}
def resume(page):
 advance(page,12000);page.evaluate('''()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});dispatchEvent(new Event('blur'));document.dispatchEvent(new Event('visibilitychange'));}''');paused=page.evaluate('__sent.length');advance(page,600000);assert page.evaluate('__sent.length')==paused
 hidden=page.evaluate('__sent.length');page.evaluate('''()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));dispatchEvent(new Event('focus'));}''');advance(page,80000)
 count=page.evaluate('__sent.filter(s=>s.code==="P1").length');assert count>=3,count;return {'requestsBeforeReturn':hidden,'P1Requests':count}
def gap(page):
 advance(page,250000);times=page.evaluate('__sent.filter(s=>s.code==="P1").map(s=>s.at)');assert len(times)>=3,times
 assert all(b-a>=99000 for a,b in zip(times[1:],times[2:])),times;return {'P1Times':times}
def effective_refresh(version,per_unit=False):
 def check(page):
  advance(page,75000);counts=page.evaluate('Object.fromEntries(["Billboard","P1"].map(code=>[code,__sent.filter(s=>s.code===code).length]))')
  assert counts['P1']>=3 if version=='fixed' else counts['P1']==1,counts
  if per_unit:assert counts['Billboard']==1,counts
  return counts
 return check
def ttl_check(version,scenario):
 def check(page):
  for _ in range(40):
   advance(page,100)
   if page.evaluate('__sent.some(s=>s.code==="Billboard")'):break
  page.evaluate('scrollTo(0,600)');page.wait_for_timeout(50)
  for _ in range(40):
   advance(page,100)
   if page.evaluate('window.pbjs.getBidResponses().P1?.bids.length>0'):break
  assert page.evaluate('__sent.filter(s=>s.code==="P1").length')==0,'Prefetch sent before display'
  assert page.locator('#P1').evaluate('el=>el.getBoundingClientRect().top>innerHeight'),'TTL fixture must remain outside the render viewport'
  advance(page,200000 if scenario=='valid' else 45000 if scenario in ['mixed','secondary'] else 90000)
  assert page.evaluate('__sent.filter(s=>s.code==="P1").length')==0,'TTL aging must not render the prefetched slot'
  page.evaluate('scrollTo(0,1200)');page.wait_for_timeout(50)
  for _ in range(60):
   advance(page,100)
   if page.evaluate('__sent.some(s=>s.code==="P1")'):break
  data=page.evaluate('({sent:__sent.filter(s=>s.code==="P1"),wire:__wire.filter(s=>s.code==="P1"),auctions:__auctions.filter(a=>a.codes.includes("P1"))})')
  assert len(data['sent'])==1,data
  target=data['sent'][0]['targeting'];scalar=lambda v:v[0] if isinstance(v,list) else v
  expected=2 if version=='fixed' and scenario=='expired' else 1
  assert len(data['auctions'])==expected,data
  if version=='fixed' and scenario=='mixed':assert scalar(target['hb_bidder'])=='ix' and not target.get('hb_adid_pubmatic'),target
  if version=='fixed' and scenario=='secondary':assert scalar(target['hb_bidder'])=='pubmatic' and not target.get('hb_adid_ix') and not target.get('hb_pb_ix'),target
  if version=='before' and scenario=='secondary':assert target.get('hb_adid_ix') and target.get('hb_pb_ix'),target
  if version=='fixed' and scenario=='expired':assert target.get('hb_adid') and all(w['round']==2 for w in data['wire'][-2:]),data
  return {'scenario':scenario,'auctionCount':len(data['auctions']),'bidder':scalar(target.get('hb_bidder')),'requestCount':len(data['sent'])}
 return check
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
 for extension in ['.js','.min.js']:
  for width in ([] if os.environ.get('TESSERA_NATIVE_ONLY') else [1440,390]):
   for name in ['late','configured']:
    for delay in [500,1500,9000]:run(browser,'fixed',name,extension,late(delay,{'Billboard':1,'P1':1}),width,html='<!doctype html><link rel="icon" href="data:,"><body></body>')
    for attribute in ['data-ad','data-slot','data-gpt']:run(browser,'fixed',name,extension,late(9000,{'Billboard':1,'P1':1},attribute),width,html='<!doctype html><link rel="icon" href="data:,"><body></body>')
   run(browser,'fixed','late',extension,sticky_only,width,html='<!doctype html><link rel="icon" href="data:,"><body></body>')
   run(browser,'fixed','sticky-empty',extension,empty_sticky,width)
  if not os.environ.get('TESSERA_NATIVE_ONLY'):
   run(browser,'fixed','refresh',extension,resume)
   run(browser,'fixed','gap',extension,gap)
   run(browser,'fixed','late',extension,effective_refresh('fixed'))
   run(browser,'fixed','per-unit',extension,effective_refresh('fixed',True))
  for name in ['native-legacy','native-configured']:
   for scenario in ['expired','valid','mixed','secondary']:run(browser,'fixed',name,extension,ttl_check('fixed',scenario),html=native_html,native_mode=scenario)
 if not os.environ.get('TESSERA_NATIVE_ONLY'):
  run(browser,'before','late','.js',effective_refresh('before'))
  run(browser,'before','per-unit','.js',effective_refresh('before',True))
 # Actual native baseline demonstrates that the old cache sends the old bid once.
 run(browser,'before','native-legacy','.js',ttl_check('before','expired'),html=native_html,native_mode='expired')
 run(browser,'before','native-legacy','.js',ttl_check('before','secondary'),html=native_html,native_mode='secondary')
 browser.close()
(out/'browser-results.json').write_text(json.dumps({'passed':True,'checks':results},indent=2)+'\n')
print(json.dumps({'passed':len(results),'externalRequests':0,'evidence':str(out)}))
