"""Two combined MBA-58/402 probes. Native Prebid, mock GPT, all demand local.

Exact saved 3.26 arm/SRI bytes run through loader1.1.1 with its v2 ledger. Memory exports are
inspected offline; no collector, publisher activation or paid request is used.
"""
import hashlib,json,os,subprocess,sys,traceback
from collections import Counter
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT/'.generated/combined-measurement-timeout-qa'
ORIGIN='https://combined.example.invalid';NOW=datetime(2026,11,20,12,tzinfo=timezone.utc)
SETUP=r'''
(()=>{
 window.__auctions=[];window.__nativeRequests=[];window.__bidWire=[];window.__gam=[];window.__rounds={};
 window.__AD_GEO={version:1,getSnapshot:()=>({version:1,status:'known',country:'RS',source:'cloudflare'}),ready:()=>Promise.resolve(__AD_GEO.getSnapshot())};
 window.__tcfapi=(command,version,callback)=>{
  if(command==='addEventListener'||command==='getTCData')callback({gdprApplies:false,listenerId:1,eventStatus:'tcloaded',cmpStatus:'loaded'},true);
  else if(command==='ping')callback({cmpLoaded:true,gdprApplies:false,cmpStatus:'loaded'},true);else callback(true);
 };
 window.adsKeywords={publisher_key:'preserved'};
 const service=googletag.pubads(),refresh=service.refresh;
 service.refresh=function(slots){
  __gam.push({at:performance.now(),page:Object.fromEntries(service.getTargetingKeys().map(key=>[key,service.getTargeting(key)])),
   slots:(slots||[]).map(slot=>({code:slot.getSlotElementId(),targeting:Object.fromEntries(slot.getTargetingKeys().map(key=>[key,slot.getTargeting(key)]))}))});
  return refresh.apply(this,arguments);
 };
 window.pbjs={que:[()=>{
  pbjs.onEvent('auctionInit',event=>__auctions.push({at:performance.now(),id:event.auctionId,timeout:event.timeout,codes:event.adUnitCodes}));
  pbjs.requestBids.before(function(next,request){__nativeRequests.push({at:performance.now(),id:request.auctionId,timeout:request.timeout,codes:(request.adUnits||[]).map(unit=>unit.code)});request.timeout=1800;return next(request);},5);
  for(const base of ['pubmatic','openx'])pbjs.registerBidAdapter(null,base,{
   code:base,gvlid:base==='pubmatic'?76:69,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
   buildRequests(bids,request){
    const payload=[];
    for(const bid of bids){
     const account=request.bidderCode,key=account+':'+bid.adUnitCode,round=(__rounds[key]||0)+1;__rounds[key]=round;
     __bidWire.push({at:performance.now(),bidder:account,code:bid.adUnitCode,round});
     const cpms=account==='pubmatic'?(round===1?[3,2]:[1]):[.5];
     for(const cpm of cpms)payload.push({requestId:bid.bidId,cpm,width:300,height:250,ttl:120,currency:'EUR',netRevenue:true,
      creativeId:'synthetic',ad:'<div>Combined local QA</div>',meta:{advertiserDomains:['example.invalid']}});
    }
    return {method:'GET',url:'%ORIGIN%/synthetic-bid',options:{withCredentials:false},data:{payload:JSON.stringify(payload),codes:JSON.stringify([...new Set(bids.map(bid=>bid.adUnitCode))])}};
   },interpretResponse:response=>response.body.bids,
  });
 }]};
})();
'''.replace('%ORIGIN%',ORIGIN)

def run(browser,name,manifest,files):
 result={'case':name,'passed':False,'checks':[],'errors':[],'blocked':[],'servedArms':[]}
 context=browser.new_context(viewport={'width':1280,'height':900},timezone_id='UTC',service_workers='block');page=context.new_page();pending=[]
 arms=manifest['record']['arms'];paths={side:'/'+arm['path'] for side,arm in arms.items()}
 page.on('pageerror',lambda error:result['errors'].append(str(error)))
 def state():return page.evaluate('({loader:window.__tesseraAbLoader?.snapshot?.(),measurement:window.__tesseraAbLoader?.measurement?.(),runtime:window.__TESSERA_RUNTIME_STARTED,policy:window.__AD_AUCTION_TIMEOUT?.snapshot?.(),cache:window.__tesseraBidCache?.snapshot?.()||null,auctions:window.__auctions,nativeRequests:window.__nativeRequests,bidWire:window.__bidWire,gam:window.__gam})')
 def check(message,condition):result['checks'].append({'message':message,'passed':bool(condition)});assert condition,message
 def route(request):
  url=request.request.url;parsed=urlsplit(url);path=parsed.path
  if url==ORIGIN+'/fixture':
   request.fulfill(content_type='text/html',body='<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><script src="/mock.js"></script><script src="/setup.js"></script><script src="/prebid.js"></script><script src="/ads.js"></script></body></html>')
  elif url==ORIGIN+'/setup.js':request.fulfill(content_type='application/javascript',body=SETUP)
  elif url.startswith(ORIGIN+'/') and path[1:] in files:
   if path in paths.values():
    side=next(side for side,p in paths.items() if p==path);result['servedArms'].append(side)
    if name=='assigned-b-executed-a' and side=='B':request.abort();return
   request.fulfill(content_type='application/javascript',headers={'access-control-allow-origin':'*'},body=files[path[1:]])
  elif parsed.netloc==urlsplit(ORIGIN).netloc and path=='/synthetic-bid':
   query=parse_qs(parsed.query);pending.append((page.evaluate('performance.now()')+1500,request,json.loads(query['payload'][0])))
  elif path=='/geo/v1/country':request.fulfill(content_type='application/json',body='{"country":"RS"}')
  elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
   request.fulfill(content_type='application/json',body=json.dumps({'dataAsOf':'2026-11-20','conversions':{'EUR':{'EUR':1,'USD':1.1},'USD':{'USD':1,'EUR':.9}}}))
  else:result['blocked'].append(url);request.abort()
 def advance(ms):
  remaining=max(0,int(ms))
  while remaining:
   step=min(remaining,50);page.clock.run_for(step);remaining-=step;now=page.evaluate('performance.now()')
   for due,request,payload in pending[:]:
    if now>=due:request.fulfill(content_type='application/json',body=json.dumps({'bids':payload}));pending.remove((due,request,payload))
   page.wait_for_timeout(2)
 def pump(condition,message):
  for _ in range(500):
   if condition():return
   advance(20)
  raise AssertionError(message)
 def until(moment):advance(max(0,moment-page.evaluate('performance.now()')))
 try:
  context.route('**/*',route);page.clock.install(time=NOW);page.clock.pause_at(NOW+timedelta(seconds=1));page.goto(ORIGIN+'/fixture',wait_until='domcontentloaded')
  pump(lambda:page.evaluate('!!window.__AD_AUCTION_TIMEOUT'),'3.26 runtime did not start through loader1.1')
  pump(lambda:len(state()['auctions'])>=2,'Both initial native groups did not start')
  started=state()['auctions'][0]['at'];until(started+1000);check('Extended native auction sends no early GAM at old500+500 deadline',not state()['gam'])
  until(started+2200);first=state();check('One initial GAM request per position',Counter(slot['code'] for row in first['gam'] for slot in row['slots'])=={'Billboard':1,'P1':1})
  if name=='native-cache-refresh':
   advance(33000);pump(lambda:Counter(slot['code'] for row in state()['gam'] for slot in row['slots'])=={'Billboard':2,'P1':2},'Natural refresh did not complete exactly once per position')
  observed=state();result['observed']=observed;result['measurement']=observed['measurement']
  check('No uncaught error or unexpected/measurement HTTP request',not result['errors'] and not result['blocked'])
  check('Current loader1.1.1 and explicit3.26 policy both executed',observed['loader']['loader']=='1.1.1' and observed['runtime']['siteId']==manifest['site'] and observed['policy']['enabled'])
  ledger=observed['measurement'];events=ledger['events'];execution=[event['arm'] for event in events if event['type']=='runtime-started']
  check('Original randomized assignment remains B',ledger['assignment']['variant']=='B' and observed['loader']['originalVariant']=='B')
  check('Ledger remains bounded memory-only with unknown collection coverage',ledger['collection']=='memory-only' and ledger['coverage']=='unknown' and ledger['consentPolicy']=='native-runtime-unchanged' and len(events)<=64 and ledger['droppedEvents']==0)
  check('One runtime startup is observed',len(execution)==1)
  for request in observed['gam']:
   check('GAM mock sees assigned B/TestId with unrelated publisher data',request['page'].get('Variant')==['B'] and request['page'].get('TestId')==[manifest['record']['testId']] and request['page'].get('publisher_key')==['preserved'])
   for slot in request['slots']:
    auction=next(row for row in reversed(observed['auctions']) if slot['code'] in row['codes'] and row['at']<=request['at'])
    check('No dispatch precedes its real native completion opportunity',request['at']-auction['at']>=1450)
  check('Every native auction honours1800ms and its2300ms watchdog',all(row['timeout']==1800 for row in observed['auctions']) and all(row['nativeTimeoutMs']==1800 and row['failsafeMs']==2300 for row in observed['policy']['auctions']))
  if name=='native-cache-refresh':
   check('B runs exact saved3.26cache-enabled bytes',execution==['B'] and observed['loader']['scriptSha256']==arms['B']['sha256'] and result['servedArms']==['B'])
   check('Cached offers still require a new native refresh auction',len(observed['auctions'])>=3 and len(observed['auctions'])==len(observed['nativeRequests']) and any(row['round']==2 for row in observed['bidWire']))
   check('Unused cache bid can beat fresh demand after that auction',observed['cache'] is not None and observed['cache']['counters']['cachedWins']>=2 and all(slot['targeting'].get('aq_bid_origin')==['cached'] for row in observed['gam'][2:] for slot in row['slots']))
   check('Exactly one initial and one natural refresh per position',Counter(slot['code'] for row in observed['gam'] for slot in row['slots'])=={'Billboard':2,'P1':2})
  else:
   check('B failure loads exact saved A without changing assignment',execution==['A'] and observed['loader']['fallback'] and observed['loader']['scriptSha256']==arms['A']['sha256'] and result['servedArms']==['B','A'])
   check('Fallback ledger distinguishes requested B from executed A',any(event['type']=='fallback' and event['fromArm']=='B' and event['toArm']=='A' for event in events) and any(event['type']=='arm-failed' and event['arm']=='B' for event in events))
   check('Fallback starts only A and emits no duplicate GAM',len(observed['auctions'])==2 and Counter(slot['code'] for row in observed['gam'] for slot in row['slots'])=={'Billboard':1,'P1':1})
  result['passed']=True
 except Exception as error:
  result['error']=str(error);result['traceback']=traceback.format_exc()
  try:result['observed']=state();result['measurement']=result['observed'].get('measurement')
  except Exception as capture:result['captureError']=str(capture)
 finally:context.close()
 return result

report={'passed':False,'cases':[],'scope':'Local saved packages + pinned native Prebid/mock GPT; no collector, paid traffic, real GAM or revenue evidence.'}
try:
 manifest=json.loads((OUT/'manifest.json').read_text());assert manifest['record']['loader']['version']=='1.1.1'
 files={}
 for name,digest in manifest['files'].items():
  path=(OUT/name).resolve();assert path.is_relative_to(OUT);data=path.read_bytes();assert hashlib.sha256(data).hexdigest()==digest,name;files[name]=data
 mock=files['mock.js'].decode();files['mock.js']=(mock[:mock.index('  window.pbjs = {')]+mock[mock.index('  window.__testAds ='):]).encode()
 report['loader']=manifest['record']['loader'];report['runtimeSha256']=manifest['runtimeSha256'];report['prebid']=manifest['prebid']['version']
 with sync_playwright() as playwright:
  launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
  if os.environ.get('CHROMIUM_PATH'):launch['executable_path']=os.environ['CHROMIUM_PATH']
  browser=playwright.chromium.launch(**launch)
  try:
   for name in manifest['cases']:
    result=run(browser,name,manifest,files);report['cases'].append(result);print(('PASS ' if result['passed'] else 'FAIL ')+name+(': '+result['error'] if 'error' in result else ''),flush=True)
  finally:browser.close()
 report['passed']=len(report['cases'])==2 and all(row['passed'] for row in report['cases'])
 if report['passed']:
  (OUT/'browser-report.json').write_text(json.dumps(report,indent=2)+'\n')
  code="""import fs from 'node:fs';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';const m=JSON.parse(fs.readFileSync(process.argv[1])),r=JSON.parse(fs.readFileSync(process.argv[2]));const {previewAbMemoryMeasurements}=await import(pathToFileURL(process.argv[3]));const p=previewAbMemoryMeasurements(m.plan,r.cases.map(c=>c.measurement));assert.deepEqual(p.assignments,{A:0,B:2});assert.deepEqual(p.execution.B,{A:1,B:1,none:0});assert.equal(p.fallbacks.B,1);assert.equal(p.coverage,'unknown');assert.equal(p.revenueReady,false);assert.equal(p.winner,null);console.log(JSON.stringify(p));"""
  result=subprocess.run(['node','--experimental-strip-types','--experimental-loader',str(ROOT/'tests/support/ts-extension-loader.mjs'),'--input-type=module','-e',code,str(OUT/'manifest.json'),str(OUT/'browser-report.json'),str(ROOT/'worker/experiments/ab-measurement.mjs')],cwd=ROOT,text=True,capture_output=True)
  assert result.returncode==0,result.stderr;report['memoryPreview']=json.loads(result.stdout)
except Exception as error:report['passed']=False;report['setupFailure']={'error':str(error),'traceback':traceback.format_exc()}
finally:
 OUT.mkdir(parents=True,exist_ok=True);(OUT/'browser-report.json').write_text(json.dumps(report,indent=2)+'\n')
 (OUT/'failed-cases.json').write_text(json.dumps({'setupFailure':report.get('setupFailure'),'cases':[row for row in report['cases'] if not row['passed']]},indent=2)+'\n')
sys.exit(0 if report['passed'] else 1)
