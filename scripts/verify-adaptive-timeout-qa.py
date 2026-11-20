"""Native Prebid timeout probes; all HTTP is fulfilled locally or aborted.

The exact compiled ads.js and pinned Prebid bytes run unchanged. A QA-only native
request hook models post-request timeout changes and pre-auction/RTD waiting.
GPT is mocked: this proves native timing/targeting integration, not real GAM,
the remote timeout provider, paid demand, hosted delivery or revenue.
"""
import hashlib,json,os,sys,traceback
from collections import Counter
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from playwright.sync_api import sync_playwright

OUT=Path(sys.argv[1]).resolve()
ORIGIN='https://reporting.example.invalid'
NOW=datetime(2026,11,20,12,tzinfo=timezone.utc)
SETUP=r'''
(()=>{
 const scenario=%SCENARIO%;window.__scenario=scenario;window.__auctions=[];window.__nativeRequests=[];window.__gam=[];window.__bidWire=[];
 window.__cmpReady=scenario!=='pending';const listeners=[];
 window.__AD_GEO={version:1,getSnapshot:()=>({version:1,status:'known',country:'RS',source:'cloudflare'}),ready:()=>Promise.resolve(__AD_GEO.getSnapshot())};
 window.__tcfapi=(command,version,callback)=>{
  const data=()=>__cmpReady?{gdprApplies:false,listenerId:1,eventStatus:'tcloaded',cmpStatus:'loaded'}:
   {gdprApplies:true,listenerId:1,eventStatus:'cmpuishown',cmpStatus:'loaded'};
  if(command==='addEventListener'){listeners.push(callback);callback(data(),true);}
  else if(command==='getTCData')callback(data(),true);
  else if(command==='ping')callback({cmpLoaded:true,gdprApplies:!__cmpReady,cmpStatus:'loaded'},true);
  else callback(true);
 };
 window.__releaseCmp=()=>{__cmpReady=true;for(const callback of listeners)callback({gdprApplies:false,listenerId:1,eventStatus:'useractioncomplete',cmpStatus:'loaded'},true);};
 if(scenario==='local'){
  Object.defineProperty(navigator,'userAgentData',{configurable:true,value:{mobile:true}});
  Object.defineProperty(navigator,'connection',{configurable:true,value:{effectiveType:'2g'}});
 }
 const service=googletag.pubads(),refresh=service.refresh;
 service.refresh=function(slots){
  __gam.push({at:performance.now(),slots:(slots||[]).map(slot=>({code:slot.getSlotElementId(),
   targeting:Object.fromEntries(slot.getTargetingKeys().map(key=>[key,slot.getTargeting(key)]))}))});
  return refresh.apply(this,arguments);
 };
 window.pbjs={que:[()=>{
  pbjs.onEvent('auctionInit',event=>__auctions.push({at:performance.now(),id:event.auctionId,timeout:event.timeout,codes:event.adUnitCodes}));
  if(typeof pbjs.requestBids.before!=='function')throw Error('Native request hook is missing');
  pbjs.requestBids.before(function(next,request){
   const codes=(request.adUnits||[]).map(unit=>unit.code);
   __nativeRequests.push({at:performance.now(),id:request.auctionId,timeout:request.timeout,codes});
   const run=()=>{
    if(scenario==='extension')request.timeout=1800;
    if(scenario==='shortening')request.timeout=600;
    if(scenario==='concurrent')request.timeout=codes.includes('Billboard')?1800:600;
    return next(request);
   };
   if(scenario==='preauction')setTimeout(run,2000);else run();
  },5);
  for(const base of ['pubmatic','openx'])pbjs.registerBidAdapter(null,base,{
   code:base,gvlid:base==='pubmatic'?76:69,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
   buildRequests(bids,request){
    const payload=bids.map(bid=>({requestId:bid.bidId,cpm:3,width:300,height:250,ttl:120,currency:'EUR',netRevenue:true,
     creativeId:'synthetic',ad:'<div>Local timeout QA</div>',meta:{advertiserDomains:['example.invalid']}}));
    const codes=bids.map(bid=>bid.adUnitCode);__bidWire.push({at:performance.now(),id:request.auctionId,codes,bidder:request.bidderCode});
    return {method:'GET',url:'%ORIGIN%/synthetic-bid',options:{withCredentials:false},data:{payload:JSON.stringify(payload),codes:JSON.stringify(codes)}};
   },interpretResponse:response=>response.body.bids,
  });
 }]};
})();
'''.replace('%ORIGIN%',ORIGIN)

def case(browser,name,files):
 result={'case':name,'passed':False,'checks':[],'errors':[],'blocked':[],'http':[]}
 context=browser.new_context(viewport={'width':390 if name=='local' else 1280,'height':900},timezone_id='UTC',service_workers='block')
 page=context.new_page();pending=[]
 page.on('pageerror',lambda error:result['errors'].append(str(error)))
 def snapshot():
  return page.evaluate('({auctions:window.__auctions||[],nativeRequests:window.__nativeRequests||[],gam:window.__gam||[],bidWire:window.__bidWire||[],policy:window.__AD_AUCTION_TIMEOUT?.snapshot?.()||null,readiness:window.__tesseraReadiness?.snapshot?.()||null})')
 def check(message,condition):
  result['checks'].append({'message':message,'passed':bool(condition)})
  assert condition,message
 def route(request):
  url=request.request.url;parsed=urlsplit(url)
  if url==ORIGIN+'/fixture':
   request.fulfill(content_type='text/html',body='<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><script src="/mock.js"></script><script src="/setup.js"></script><script src="/prebid.js"></script><script src="/ads.js"></script></body></html>')
  elif url==ORIGIN+'/mock.js':request.fulfill(content_type='application/javascript',body=files['mock'])
  elif url==ORIGIN+'/setup.js':request.fulfill(content_type='application/javascript',body=SETUP.replace('%SCENARIO%',json.dumps(name)))
  elif url==ORIGIN+'/prebid.js':request.fulfill(content_type='application/javascript',body=files[name+'/prebid.js'])
  elif url==ORIGIN+'/ads.js':request.fulfill(content_type='application/javascript',body=files[name+'/ads.js'])
  elif parsed.netloc==urlsplit(ORIGIN).netloc and parsed.path=='/synthetic-bid':
   query=parse_qs(parsed.query);codes=json.loads(query['codes'][0]);payload=json.loads(query['payload'][0])
   delay={'off':700,'local':1100,'pending':100,'preauction':100,'extension':1500,'shortening':900}.get(name,1500 if 'Billboard' in codes else 900)
   at=page.evaluate('performance.now()');pending.append((at+delay,request,payload))
   result['http'].append({'at':at,'codes':codes,'responseDelay':delay})
  elif parsed.path=='/geo/v1/country':request.fulfill(content_type='application/json',body='{"country":"RS"}')
  elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
   request.fulfill(content_type='application/json',body=json.dumps({'dataAsOf':'2026-11-20','conversions':{'EUR':{'EUR':1,'USD':1.1},'USD':{'USD':1,'EUR':0.9}}}))
  else:result['blocked'].append(url);request.abort()
 def advance(ms):
  remaining=max(0,int(ms))
  while remaining:
   step=min(remaining,25);page.clock.run_for(step);remaining-=step
   now=page.evaluate('performance.now()')
   for due,request,payload in pending[:]:
    if now>=due:
     request.fulfill(content_type='application/json',body=json.dumps({'bids':payload}));pending.remove((due,request,payload))
   page.wait_for_timeout(2)
 def pump(condition,message):
  for _ in range(500):
   if condition():return
   advance(10)
  raise AssertionError(message)
 def until(moment):advance(max(0,moment-page.evaluate('performance.now()')))
 try:
  context.route('**/*',route);page.clock.install(time=NOW);page.clock.pause_at(NOW+timedelta(seconds=1))
  page.goto(ORIGIN+'/fixture',wait_until='domcontentloaded')
  pump(lambda:page.evaluate('!!window.__AD_AUCTION_TIMEOUT'),'Runtime diagnostics did not initialize')
  if name=='pending':
   advance(3000);state=snapshot();check('Pending CMP starts no native request, timeout record or GAM',not state['nativeRequests'] and not state['policy']['auctions'] and not state['gam'])
   page.evaluate('__releaseCmp()')
  if name=='preauction':
   pump(lambda:bool(snapshot()['nativeRequests']),'Native pre-auction hook did not run')
   requested=snapshot()['nativeRequests'][0]['at'];until(requested+1000)
   check('Pre-auction wait sends no GAM and consumes no native bidder budget',not snapshot()['gam'] and not snapshot()['auctions'])
  pump(lambda:bool(snapshot()['auctions']),'No real native auctionInit observed')
  start=snapshot()['auctions'][0]['at']
  if name in ['extension','local']:
   until(start+1000);check('No GAM at the obsolete500+500 deadline',not snapshot()['gam'])
  if name=='concurrent':
   until(start+1000);sent=[slot['code'] for row in snapshot()['gam'] for slot in row['slots']]
   check('Shortened P1 can finish while extended Billboard remains pending',sent==['P1'])
  until(start+3500);state=snapshot();result['observed']=state
  check('No uncaught browser error',not result['errors']);check('All non-fixture traffic is blocked and absent',not result['blocked'])
  check('Exactly one natural GAM request per logical position',Counter(slot['code'] for row in state['gam'] for slot in row['slots'])=={'Billboard':1,'P1':1})
  check('Both groups have actual native auction lineage',len(state['auctions'])==2 and len({row['id'] for row in state['auctions']})==2)
  by_code={code:row for row in state['policy']['auctions'] for code in row['codes']}
  check('Both groups retain independent diagnostic records',set(by_code)=={'Billboard','P1'})
  expected={'off':500,'local':1200,'pending':500,'preauction':500,'extension':1800,'shortening':600}
  for auction in state['auctions']:
   native_timeout=expected.get(name,1800 if 'Billboard' in auction['codes'] else 600)
   check('Native auction uses the expected effective timeout: '+','.join(auction['codes']),auction['timeout']==native_timeout)
   for code in auction['codes']:
    record=by_code[code];check('Watchdog follows actual native timeout: '+code,record['nativeTimeoutMs']==native_timeout and record['failsafeMs']==native_timeout+500)
  if name in ['extension','local']:
   check('A bid arriving after the obsolete deadline is still targeted',all(slot['targeting'].get('hb_adid') for row in state['gam'] for slot in row['slots']))
  if name in ['off','shortening']:
   check('Late native bid responses cannot populate the completed fallback',all(not slot['targeting'].get('hb_adid') for row in state['gam'] for slot in row['slots']))
  if name=='concurrent':check('Per-position saved timeout remains distinct before native changes',by_code['Billboard']['baseMs']==500 and by_code['P1']['baseMs']==1200)
  if name=='extension':check('External native override outside local bounds remains visible',all('native-rtd-override' in row['reasons'] and row['timeoutMs']==500 for row in state['policy']['auctions']))
  if name=='off':check('Default/OFF behavior preserves the saved500ms value',state['policy']['enabled'] is False and all(row['timeoutMs']==500 for row in state['policy']['auctions']))
  result['passed']=True
 except Exception as error:
  result['error']=str(error);result['traceback']=traceback.format_exc()
  try:result['observed']=snapshot()
  except Exception as capture:result['captureError']=str(capture)
 finally:context.close()
 return result

report={'passed':False,'cases':[],'scope':'Pinned native Prebid with mock GPT and synthetic intercepted demand; no remote provider, real GAM, hosted acceptance or revenue.'}
try:
 manifest=json.loads((OUT/'manifest.json').read_text());assert manifest['runtime']['version']=='3.26.0'
 files={}
 for name,digest in manifest['files'].items():
  path=(OUT/name).resolve();assert path.is_relative_to(OUT);data=path.read_bytes();assert hashlib.sha256(data).hexdigest()==digest,name;files[name]=data
 mock=files['mock-ad-libraries.js'].decode();files['mock']=(mock[:mock.index('  window.pbjs = {')]+mock[mock.index('  window.__testAds ='):]).encode()
 report['runtime']=manifest['runtime'];report['prebid']=manifest['prebid']['version'];report['native']=manifest['native']
 with sync_playwright() as playwright:
  launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
  if os.environ.get('CHROMIUM_PATH'):launch['executable_path']=os.environ['CHROMIUM_PATH']
  browser=playwright.chromium.launch(**launch)
  try:
   for name in manifest['cases']:
    result=case(browser,name,files);report['cases'].append(result);print(('PASS ' if result['passed'] else 'FAIL ')+name+(': '+result['error'] if 'error' in result else ''),flush=True)
  finally:browser.close()
 report['passed']=len(report['cases'])==7 and all(row['passed'] for row in report['cases'])
except Exception as error:report['setupFailure']={'error':str(error),'traceback':traceback.format_exc()}
finally:
 OUT.mkdir(parents=True,exist_ok=True);(OUT/'browser-report.json').write_text(json.dumps(report,indent=2)+'\n')
 (OUT/'failed-cases.json').write_text(json.dumps({'setupFailure':report.get('setupFailure'),'cases':[row for row in report['cases'] if not row['passed']]},indent=2)+'\n')
sys.exit(0 if report['passed'] else 1)
