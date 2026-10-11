"""Offline experimental facade + frozen readiness + exact native Prebid 11.34.
All browser network intercepted; synthetic bidder, simulated CMP/GPT only.
"""
import hashlib,json,os
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
PB=ROOT/'vendor/prebid/tanjug-11.34.0/prebid.js'
assert hashlib.sha256(PB.read_bytes()).hexdigest()=='384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b'
SETUP=r'''
window.__enforcement=[];window.__requests=[];window.__sent=[];window.__bids=[];window.__errors=[];window.__cmps=[];window.__auctionEnds=[];
function tc(allow){
 const bits=(n,w)=>Number(n).toString(2).padStart(w,'0');
 let s=bits(2,6)+bits(17909856000,36)+bits(17909856000,36)+bits(1,12)+bits(1,12)+bits(0,6)+bits(4,6)+bits(13,6)+bits(1,12)+bits(4,6)+'10'+'0'.repeat(12)+(allow?'1':'0').repeat(24)+'0'.repeat(24)+'0'+bits(4,6)+bits(4,6)+bits(1000,16)+'0'+(allow?'1':'0').repeat(1000)+bits(1000,16)+'0'+'0'.repeat(1000)+bits(0,12);
 s=s.padEnd(Math.ceil(s.length/8)*8,'0');return btoa(s.match(/.{8}/g).map(x=>String.fromCharCode(parseInt(x,2))).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
window.decision=kind=>kind==='outside'?{gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded',tcfPolicyVersion:4,cmpId:1,cmpVersion:1}:{gdprApplies:true,cmpStatus:'loaded',eventStatus:'useractioncomplete',tcfPolicyVersion:4,cmpId:1,cmpVersion:1,tcString:tc(kind==='accept'),purpose:{consents:Object.fromEntries(Array.from({length:24},(_,i)=>[i+1,kind==='accept'])),legitimateInterests:{}},vendor:{consents:Object.fromEntries(Array.from({length:1000},(_,i)=>[i+1,kind==='accept'])),legitimateInterests:{}}};
window.makeCmp=(name,kind=null)=>{
 const cmp={name,data:kind?decision(kind):null,live:new Map(),all:[],calls:[],seq:0};
 cmp.api=(cmd,v,cb,id)=>{cmp.calls.push({cmd,id:id??null});if(cmd==='addEventListener'){const n=++cmp.seq;cmp.live.set(n,cb);cmp.all.push({id:n,cb});if(cmp.data)cb({...cmp.data,listenerId:n},true);}else if(cmd==='removeEventListener'){cmp.live.delete(id);cb(true);}else if(cmd==='ping')cb({cmpLoaded:true,cmpStatus:'loaded',gdprApplies:cmp.data?.gdprApplies},true);else if(cmd==='getTCData')cb(cmp.data,!!cmp.data);};
 cmp.emit=kind=>{cmp.data=decision(kind);for(const [id,cb] of [...cmp.live])cb({...cmp.data,listenerId:id},true);};
 cmp.stale=kind=>{for(const {id,cb} of cmp.all)cb({...decision(kind),listenerId:id},true);};
 __cmps.push(cmp);return cmp;
};
window.install=(cmp)=>{window.__tcfapi=cmp.api;};
'''
CONTROL=r'''
let nativeConfigured=false;window.configureNative=()=>{if(nativeConfigured)return;nativeConfigured=true;pbjs.setConfig({debug:false,deviceAccess:false,userSync:{syncEnabled:false},bidderTimeout:400,consentManagement:{gdpr:{cmpApi:'iab',timeout:200,actionTimeout:200,defaultGdprScope:true}}});};
pbjs.onEvent('tcf2Enforcement',e=>__enforcement.push(e));
pbjs.onEvent('bidRequested',r=>__requests.push({auctionId:r.auctionId,gdprApplies:r.gdprConsent?.gdprApplies,consent:r.gdprConsent?.consentString===tc(true)?'accept':r.gdprConsent?.consentString===tc(false)?'reject':r.gdprConsent?.consentString?'other':'absent'}));
pbjs.onEvent('bidResponse',b=>__bids.push({adId:b.adId,auctionId:b.auctionId}));
pbjs.onEvent('auctionEnd',a=>__auctionEnds.push(a.auctionId));
window.adapter=createCmpRecoveryExperiment(window);
window.slot={id:'Billboard',targeting:{}};
const options={configure:configureNative,prebidWaitMs:100,preAuctionWaitMs:1000,rawRequest:(pb,input)=>pb.requestBids(input),rawDispatch:(service,slots)=>__sent.push({at:Date.now(),targeting:{...slot.targeting},epoch:gate.snapshot().consent.epoch}),clear:s=>s.targeting={},apply:(s,v)=>s.targeting={...v},code:s=>s.id,discard:()=>slot.targeting={}};
window.gate=adapter.createReadiness(createTesseraReadiness,options);
window.ask=()=>gate.request(pbjs,{adUnits:[{code:'Billboard',mediaTypes:{banner:{sizes:[[300,250]]}},bids:[{bidder:'pubmatic',params:{publisherId:'fixture',adSlot:'fixture'}}]}],timeout:window.__hold?2000:400,bidsBackHandler:()=>gate.dispatch({},[slot])});
window.report=()=>({enforcement:__enforcement,requests:__requests,sent:__sent,bids:__bids,auctionEnds:__auctionEnds,readiness:gate.snapshot(),adapter:adapter.snapshot(),cmps:__cmps.map(c=>({name:c.name,decision:!c.data?'pending':c.data.gdprApplies===false?'outside':c.data.tcString===tc(true)?'accept':c.data.tcString===tc(false)?'reject':'unknown',purposeOneGranted:c.data?.purpose?.consents?.[1]??null,vendor76Granted:c.data?.vendor?.consents?.[76]??null,live:c.live.size,calls:c.calls}))});
'''
def run(browser,name):
 page=browser.new_page();unexpected=[];errors=[];bid_network=[];pending=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 def route(r):
  u=urlparse(r.request.url)
  if r.request.url=='https://cmp-recovery.test/':r.fulfill(status=200,content_type='text/html',body='<!doctype html><body></body>')
  elif u.netloc=='readiness-fixture.invalid':
   payload=json.loads(parse_qs(u.query)['payload'][0]);bid_network.append(len(payload))
   for b in payload:b.update(creativeId='fixture',currency='USD',netRevenue=True,ad='<div>offline</div>')
   if name=='native-held-response':pending.append((r,json.dumps({'bids':payload})))
   else:r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'bids':payload}))
  else:unexpected.append(r.request.url);r.abort()
 page.route('**/*',route)
 try:
  page.goto('https://cmp-recovery.test/');page.add_script_tag(content=SETUP)
  initial='accept' if name.startswith(('native-','immediate-','queued-')) else None
  page.evaluate('(kind)=>{window.old=makeCmp("old",kind);install(old)}',initial)
  page.add_script_tag(content=(ROOT/'tests/runtime/full-cache-browser-fixture.js').read_text().replace('code:name,supportedMediaTypes',"code:name,gvlid:name==='pubmatic'?76:69,supportedMediaTypes"));page.add_script_tag(content=PB.read_text())
  for path in ['worker/runtime-readiness-v1/browser-readiness.mjs','tests/support/cmp-recovery-experiment.mjs']:
   page.add_script_tag(content=(ROOT/path).read_text().replace('export function','function'))
  page.add_script_tag(content=CONTROL)
  page.evaluate('window.__hold='+str(name=='native-held-response').lower())
  if name=='no-response':
   page.evaluate('ask()');page.wait_for_timeout(1800)
  elif name.startswith(('late-','same-')):
   page.evaluate('ask()');page.wait_for_timeout(300)
   assert page.evaluate('__sent.length')==0
   if name.startswith('same-'):page.evaluate('(kind)=>old.emit(kind)',name[5:])
   else:page.evaluate('(kind)=>{window.fresh=makeCmp("new",kind);install(fresh)}',name[5:])
   page.wait_for_timeout(1600)
  elif name.startswith(('immediate-','queued-')):
   page.evaluate('(queued)=>{if(queued)ask();window.fresh=makeCmp("new");install(fresh);if(!queued)ask();}',name.startswith('queued-'))
   page.wait_for_timeout(100);assert page.evaluate('__sent.length')==0,'replacement permitted early dispatch'
   page.evaluate('fresh.emit("reject")');page.wait_for_timeout(1500)
  else:
   page.evaluate('ask()');page.wait_for_timeout(200 if name=='native-held-response' else 700)
   assert page.evaluate('__requests.length')>0,'initial native accept did not request'
   if name=='native-same-change':page.evaluate('window.baseline=__requests.length;old.emit("reject")')
   else:page.evaluate('window.baseline=__requests.length;window.fresh=makeCmp("new","reject");install(fresh)')
   page.wait_for_timeout(350)
   if name in ['native-reconfigure','native-reconfigure-stale']:
    page.evaluate('nativeConfigured=false;configureNative()')
   if name in ['native-stale-callback','native-reconfigure-stale']:page.evaluate('old.stale("accept")')
   if name=='native-held-response':
    for r,body in pending:r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=body)
    pending.clear()
   else:page.evaluate('ask()')
   page.wait_for_timeout(1000)
  data=page.evaluate('report()');data.update(unexpectedNetwork=unexpected,browserErrors=errors,syntheticBidRequests=len(bid_network))
  assert not unexpected and not errors,'Unexpected network/browser error'
  if name=='no-response':assert not data['requests'] and not data['sent'],'silent CMP unblocked'
  else:
   assert data['readiness']['consent']['ready'],'current decision did not recover'
   assert len(data['sent'])==(2 if name.startswith('native-') and name!='native-held-response' else 1),'initial dispatch count differs; readiness alone is not recovery'
   if name.endswith('accept'):assert data['requests'] and all(r['consent']=='accept' for r in data['requests']),'native accept missing'
   elif name.endswith('outside'):assert data['requests'] and all(r['gdprApplies'] is False for r in data['requests']),'native did not adopt outside scope'
   elif name=='native-held-response':assert all(not any(k.startswith('hb_') for k in r['targeting']) for r in data['sent']),'stale response targeting leaked'
   elif name.startswith('native-'):
    baseline=page.evaluate('baseline');assert all(r['consent']!='accept' for r in data['requests'][baseline:]),'BLOCKER: native Prebid reused old Accept after current CMP Reject'
   else:assert not data['requests'],'BLOCKER: native bidder request despite current Reject'
  return {'case':name,'passed':True,'evidence':data}
 except Exception as e:
  try:data=page.evaluate('report()')
  except Exception:data={}
  return {'case':name,'passed':False,'error':str(e),'evidence':data,'unexpectedNetwork':unexpected,'browserErrors':errors}
 finally:
  for r,_ in pending:
   try:r.abort()
   except Exception:pass
  page.close()
def main():
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
  results=[]
  cases='no-response,same-accept,same-reject,late-accept,late-reject,late-outside,immediate-replacement,queued-replacement,native-held-response,native-same-change,native-cache-reject,native-stale-callback,native-reconfigure,native-reconfigure-stale'
  for n in os.environ.get('CMP_RECOVERY_CASES',cases).split(','):
   r=run(browser,n);results.append(r);print(('PASS' if r['passed'] else 'FAIL'),r['case'],r.get('error',''),flush=True)
  browser.close()
 out=ROOT/'.generated/cmp-recovery-native';out.mkdir(parents=True,exist_ok=True);(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 return 0 if all(r['passed'] for r in results) else 1
if __name__=='__main__':raise SystemExit(main())
