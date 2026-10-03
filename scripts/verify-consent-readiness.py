"""Offline generated 3.14 + original vendored Prebid; every network route is intercepted.
Run after prepare-readiness-browser-fixtures.mjs. No real GPT or paid ad traffic.
"""
import json,os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/readiness-evidence'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
pbsource=(root/'vendor/prebid/tanjug-11.34.0/prebid.js').read_text()
adapter=(root/'tests/runtime/full-cache-browser-fixture.js').read_text()
html='<!doctype html><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:2400px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="Overlay" class="wrapperAd"></div></body>'
setup=r'''
window.__sent=[];window.__configs=[];window.__auctions=[];window.__bidResponses=[];window.__completed=[];window.__listeners=new Map();window.__listenerSeq=0;window.__cmpData=null;
window.__consentTrace=[];window.__traceSeq=0;
window.__traceConsent=(event,details={})=>{
 const consent=window.__tesseraReadiness?.snapshot().consent;
 const record={seq:++__traceSeq,event,at:Date.now(),consent:consent?{...consent}:null,...details};
 __consentTrace.push(record);return record;
};
window.__emitCmp=data=>{
 __traceConsent('cmp-before',{eventStatus:data.eventStatus||null,gdprApplies:data.gdprApplies??null});
 window.__cmpData=data;for(const cb of [...__listeners.values()])cb(data,true);
 __traceConsent('cmp-after',{eventStatus:data.eventStatus||null,gdprApplies:data.gdprApplies??null});
};
window.__tcfapi=(cmd,version,cb,id)=>{
 if(cmd==='addEventListener'){__listeners.set(++__listenerSeq,cb);if(__cmpData)cb({...__cmpData,listenerId:__listenerSeq},true);}
 else if(cmd==='removeEventListener'){__listeners.delete(id);cb(true);}
 else if(cmd==='getTCData')cb(__cmpData,!!__cmpData);
 else if(cmd==='ping')cb({cmpLoaded:true,cmpStatus:'loaded',gdprApplies:__cmpData?.gdprApplies},true);
};
window.__decision=(kind)=>kind==='outside'?{gdprApplies:false,tcfPolicyVersion:4,cmpId:1,cmpVersion:1}:{cmpStatus:'loaded',eventStatus:'useractioncomplete',gdprApplies:true,
 tcString:'COwK6gaOwK6gaFmAAAENAPCAAAAAAAAAAAAAAAAAAAAA.IFoEUQQgAIQwgIwQABAEAAAAOIAACAIAAAAQAIAgEAACEAAAAAgAQBAAAAAAAGBAAgAAAAAAAFAAECAAAgAAQARAEQAAAAAJAAIAAgAAAYQEAAAQmAgBC3ZAYzUw',
 purpose:{consents:Object.fromEntries(Array.from({length:11},(_,i)=>[i+1,kind!=='reject'])),legitimateInterests:{}},
 vendor:{consents:Object.fromEntries(Array.from({length:1000},(_,i)=>[i+1,kind!=='reject'])),legitimateInterests:{}}};
const original=__testAds.service.refresh;
__testAds.service.refresh=function(slots,opts){for(const slot of slots||[]){const event=__traceConsent('dispatch',{id:slot.id});__sent.push({...event,targeting:Object.fromEntries(Object.entries(slot.targeting).filter(([,v])=>v!==null))});}return original.call(this,slots,opts);};
'''
after_pb=r'''
const orig=pbjs.setConfig;
pbjs.setConfig=function(cfg){__configs.push(JSON.parse(JSON.stringify(cfg)));return orig.apply(this,arguments);};
pbjs.onEvent('auctionInit',event=>__auctions.push({at:Date.now(),id:event.auctionId,codes:event.adUnitCodes,consent:pbjs.getConfig('consentManagement')}));
pbjs.onEvent('bidResponse',bid=>__bidResponses.push({id:bid.adId,code:bid.adUnitCode,auctionId:bid.auctionId}));
pbjs.onEvent('auctionEnd',event=>__completed.push(event.auctionId));
'''
def require(value,message):
 if not value:raise AssertionError(message)

def begin_pending_choice(page):
 # All three operations belong to one browser task. The installed clock keeps
 # running between evaluate calls, so a prior ready request must not be counted
 # against the later pending-decision interval.
 return page.evaluate('''() => {
  if(!__auctions.some(a=>a.codes.includes('Billboard')))throw Error('Consent-change scenario did not start its Billboard auction');
  if(__sent.some(r=>r.id==='Billboard'))throw Error('Consent changed after Billboard already dispatched');
  const baseline=__sent.length;
  __traceConsent('pending-baseline',{sent:baseline});
  __emitCmp({cmpStatus:'loaded',eventStatus:'cmpuishown',gdprApplies:true});
  return baseline;
 }''')

class ReadinessFailure(AssertionError):
 def __init__(self,message,evidence):
  super().__init__(message);self.evidence=evidence

def run(browser,name,extension='.js',change_boundary=begin_pending_choice,setup_control=None,prebid_control=None):
 page=browser.new_page(viewport={'width':1280,'height':900});errors=[];network=[];unexpected=[];pending=[];hold_bids=name in ['late-bid','changed-decision']
 page.on('pageerror',lambda e:errors.append(str(e)))
 def route(r):
  url=r.request.url;network.append(url)
  if url=='https://readiness.test/':r.fulfill(status=200,content_type='text/html',body=html)
  elif url.startswith('https://readiness-fixture.invalid/bid'):
   payload=json.loads(parse_qs(urlparse(url).query)['payload'][0]);
   for bid in payload:bid.update(creativeId='fixture',currency='EUR',netRevenue=True,ad='<div>Fixture</div>')
   if name=='empty':payload=[]
   response=json.dumps({'bids':payload})
   if hold_bids:pending.append((r,response))
   else:r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=response)
  elif urlparse(url).netloc=='cdn.jsdelivr.net' and urlparse(url).path=='/gh/prebid/currency-file@1/latest.json':
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'dataAsOf':'2026-09-30','conversions':{'USD':{'USD':1,'EUR':0.9,'RSD':100},'EUR':{'USD':1.111111,'EUR':1,'RSD':111.1111}}}))
  else:unexpected.append(url);r.abort()
 page.route('**/*',route)
 try:
  page.goto('https://readiness.test/');page.clock.install(time=datetime(2026,9,30,tzinfo=timezone.utc))
  page.add_script_tag(content=mock);page.add_script_tag(content=setup)
  if setup_control:setup_control(page)
  page.evaluate('delete window.pbjs');page.add_script_tag(content=adapter)
  def load_pb():
   page.add_script_tag(content=pbsource);page.add_script_tag(content=after_pb)
   if prebid_control:prebid_control(page)
   if name=='throw':page.evaluate("() => {pbjs.requestBids=()=>{throw Error('fixture load exception')};}")
   if name=='pre-auction':page.evaluate("() => {pbjs.requestBids.before(function(next,opts){setTimeout(()=>next(opts),6000)},1);}")
  if name not in ['missing','late','late-after-fallback','gam']:load_pb()
  if name in ['slow-decision','reject','unknown','no-response','slow-existing']:
   if name=='slow-decision':page.evaluate("__emitCmp({cmpStatus:'loaded',eventStatus:'cmpuishown',gdprApplies:true})")
   if name=='unknown':page.evaluate("__emitCmp({cmpStatus:'loaded',eventStatus:'tcloaded'})")
  else:page.evaluate("__emitCmp(__decision('outside'))")
  fixture='gam' if name=='gam' else 'sticky' if name=='sticky' else 'legacy-lazy' if name=='legacy-lazy' else 'prebid'
  page.add_script_tag(content=(out/(fixture+extension)).read_text())
  if name=='changed-decision':
   for _ in range(60):
    page.clock.run_for(20);page.wait_for_timeout(10)
    if page.evaluate("__auctions.some(a=>a.codes.includes('Billboard'))"):break
   sent_before_choice=change_boundary(page)
   page.clock.run_for(4000);require(page.evaluate('__sent.length')==sent_before_choice,'Pending decision allowed a request')
   page.evaluate("__emitCmp(__decision('accept'))")
  if name in ['slow-decision','reject','unknown','no-response','slow-existing']:
   page.clock.run_for(8000)
   require(page.evaluate('__sent.length')==0,'Request before valid consent decision')
   require(page.evaluate('__auctions.length')==0,'Auction before valid consent decision')
   if name in ['unknown','no-response']:
    page.clock.run_for(25000);require(page.evaluate('__sent.length')==0,'Unknown consent timed out into GAM');return {'blocked':True}
   page.evaluate("kind=>__emitCmp(__decision(kind))",'reject' if name=='reject' else 'accept')
  if name=='late':
   page.clock.run_for(2000);load_pb()
  if name=='late-after-fallback':
   page.clock.run_for(4000);require(page.evaluate("__sent.filter(r=>r.id==='Billboard').length")==1,'Missing PB did not fallback ATF once');load_pb()
  if name=='pre-auction':
   page.clock.run_for(4000);require(page.evaluate('__sent.length')==0,'Bid deadline ran before actual auction')
  page.clock.run_for(15000 if name=='pre-auction' else 4000);page.wait_for_timeout(100)
  if hold_bids:
   hold_bids=False
   for request,response in pending:
    request.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=response)
   pending.clear()
   page.wait_for_timeout(100);page.clock.run_for(100)
  if page.locator('#adsx-takeover-close').is_visible():page.locator('#adsx-takeover-close').click()
  page.evaluate('scrollTo(0,2600)');page.wait_for_timeout(100);page.clock.run_for(10000 if name=='pre-auction' else 4000);page.wait_for_timeout(100)
  data=page.evaluate('({sent:__sent,configs:__configs,auctions:__auctions,bids:__bidResponses,completed:__completed,phase:__tesseraReadiness.snapshot(),privacy:__testAds.observations.privacy})')
  billboard=[r for r in data['sent'] if r['id']=='Billboard'];require(len(billboard)==1,'Initial Billboard count '+str(len(billboard)))
  require(not data['privacy'],'Wrapper must not force NPA')
  require(not errors,'Browser errors '+str(errors));require(not unexpected,'Unexpected network '+str(unexpected))
  if name not in ['gam','missing','throw','reject']:
   require(data['auctions'],'No real Prebid auction')
   require(all(a['consent'].get('gdpr',{}).get('defaultGdprScope') is True for a in data['auctions']),'Auction ran before TCF configuration')
  if name in ['missing','throw','reject']:
   require(all(not any(k.startswith('hb_') and k!='hb_ver' for k in r['targeting']) for r in data['sent']),'Fallback/reject got bidder targeting')
  if name in ['late-bid','changed-decision']:
   require(not any(k.startswith('hb_') and k!='hb_ver' for k in billboard[0]['targeting']),'Late/canceled bid leaked into initial targeting')
  if name=='changed-decision':
   require(not any(k.startswith('aq_') for k in billboard[0]['targeting']),'Canceled consent epoch leaked auction reporting: '+json.dumps({'targeting':billboard[0]['targeting'],'readiness':data['phase']}))
  require(len([r for r in data['sent'] if r['id']=='P1'])==1,'BTF must dispatch exactly once')
  if name=='sticky':require(len([r for r in data['sent'] if r['id']=='Sticky'])==1,'Sticky must dispatch exactly once')
  require(len([r for r in data['sent'] if r['id']=='adsx-takeover-slot'])==1,'TakeOver must dispatch exactly once')
  if name=='fast':
   for request in [r for r in data['sent'] if r['id'] in ['Billboard','P1']]:
    adid=request['targeting'].get('hb_adid');adid=adid[0] if isinstance(adid,list) else adid
    require(adid,'Valid fast auction lost targeting for '+request['id'])
    require(any(b['id']==adid and b['code']==request['id'] and b['auctionId'] in data['completed'] for b in data['bids']),'Targeting did not come from a completed matching auction')
  return {'requests':[{k:v for k,v in r.items() if k!='targeting'} for r in data['sent']],'auctions':len(data['auctions']),'networkIntercepted':len(network)-1,'consentTrace':page.evaluate('__consentTrace')}
 except Exception as error:
  try:evidence=page.evaluate('({trace:window.__consentTrace||[],requests:window.__sent||[],auctions:window.__auctions||[],readiness:window.__tesseraReadiness?.snapshot()||null})')
  except Exception as trace_error:evidence={'traceUnavailable':str(trace_error)}
  evidence.update(browserErrors=errors,unexpectedNetwork=unexpected)
  raise ReadinessFailure(str(error),evidence) from error
 finally:
  for request,_ in pending:
   try:request.abort()
   except Exception:pass
  page.close()
def main():
 results=[]
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
  for extension in os.environ.get('READINESS_VARIANTS','.js,.min.js').split(','):
   for name in os.environ.get('READINESS_CASES','fast,slow-existing,slow-decision,reject,changed-decision,unknown,no-response,missing,late,late-after-fallback,late-bid,throw,empty,pre-auction,gam,sticky,legacy-lazy').split(','):
    try:detail=run(browser,name,extension);results.append({'case':name+extension,'passed':True,**detail});print('PASS',name+extension,flush=True)
    except Exception as error:results.append({'case':name+extension,'passed':False,'error':str(error),'evidence':getattr(error,'evidence',{})});print('FAIL',name+extension,str(error),flush=True)
  browser.close()
 (out/'browser-results.json').write_text(json.dumps(results,indent=2)+'\n')
 return 0 if all(r['passed'] for r in results) else 1

if __name__=='__main__':raise SystemExit(main())
