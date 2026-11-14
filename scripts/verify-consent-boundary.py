"""MBA-188 deterministic browser-task boundary regression, using unchanged 3.14.
A held, real synthetic TakeOver dispatch makes the split-boundary failure
reproducible. Each successful run still executes the verifier's full assertions.
"""
import importlib.util
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

spec=importlib.util.spec_from_file_location('readiness_verifier',Path(__file__).with_name('verify-consent-readiness.py'))
verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)


def install_control(page):
 page.evaluate('''() => {
  const dispatch=__testAds.service.refresh;
  window.__heldReadyDispatch=null;
  window.__resumeBillboard=null;
  window.__releaseReadyDispatch=()=>{
   if(!__heldReadyDispatch)throw Error('Controlled TakeOver dispatch was not ready');
   const release=__heldReadyDispatch;__heldReadyDispatch=null;release();
  };
  __testAds.service.refresh=function(slots,opts){
   if(slots.length===1&&slots[0].id==='adsx-takeover-slot'&&!window.__heldOnce){
    window.__heldOnce=true;
    __heldReadyDispatch=()=>dispatch.call(this,slots,opts);
    __traceConsent('dispatch-held',{id:slots[0].id});
    if(__resumeBillboard){const resume=__resumeBillboard;__resumeBillboard=null;resume();}
    return;
   }
   return dispatch.call(this,slots,opts);
  };
 }''')


def install_auction_barrier(page):
 # The native Billboard auction starts only after an actual ready TakeOver
 # dispatch exists. This is an event dependency, independent of timer timing.
 page.evaluate('''() => {
  pbjs.requestBids.before(function(next,options){
   if(!(options.adUnits||[]).some(unit=>unit.code==='Billboard')){next(options);return;}
   let resumed=false;
   const resume=()=>{
    if(resumed)throw Error('Billboard control continuation resumed twice');
    resumed=true;__traceConsent('billboard-release');next(options);
   };
   __traceConsent('billboard-gate');
   if(__heldReadyDispatch)resume();
   else {
    if(__resumeBillboard)throw Error('A Billboard control continuation already exists');
    __resumeBillboard=resume;
   }
  },1);
 }''')


def boundary(mode):
 def begin(page):
  verifier.require(page.evaluate("!!__heldReadyDispatch"),'Control did not capture an actual ready TakeOver dispatch')
  if mode=='split-before':
   # Deliberately retain the old task split as the before-control.
   verifier.require(page.evaluate("__auctions.some(a=>a.codes.includes('Billboard'))"),'Consent-change scenario did not start its Billboard auction')
   verifier.require(page.evaluate("!__sent.some(r=>r.id==='Billboard')"),'Consent changed after Billboard already dispatched')
   count=page.evaluate("() => {const count=__sent.length;__traceConsent('pending-baseline',{sent:count});return count;}")
   page.evaluate('__releaseReadyDispatch()')
   page.evaluate("__emitCmp({cmpStatus:'loaded',eventStatus:'cmpuishown',gdprApplies:true})")
   return count
  if mode=='atomic-after':
   page.evaluate('__releaseReadyDispatch()')
   return verifier.begin_pending_choice(page)
  if mode=='pending-sync-negative':
   page.evaluate("() => {__listeners.set(++__listenerSeq,data=>{if(data.eventStatus==='cmpuishown')__releaseReadyDispatch();});}")
   return verifier.begin_pending_choice(page)
  count=verifier.begin_pending_choice(page)
  # A real mock GPT refresh while the runtime reports ready:false deliberately
  # simulates a privacy regression. The new assertion must reject it.
  page.evaluate('__releaseReadyDispatch()')
  return count
 return begin


def verify_trace(mode,evidence):
 verifier.require(not evidence.get('browserErrors'),'Control encountered unrelated browser errors')
 verifier.require(not evidence.get('unexpectedNetwork'),'Control encountered unexpected network traffic')
 trace=evidence['trace']
 verifier.require(all(a['seq']<b['seq'] for a,b in zip(trace,trace[1:])),'Trace sequence must be strictly monotonic')
 baseline=next(e for e in trace if e['event']=='pending-baseline')
 pending=next(e for e in trace if e['event']=='cmp-after' and e.get('eventStatus')=='cmpuishown')
 dispatch=next(e for e in trace if e['event']=='dispatch' and e['id']=='adsx-takeover-slot')
 held=next(e for e in trace if e['event']=='dispatch-held')
 gate=[e for e in trace if e['event']=='billboard-gate']
 release=[e for e in trace if e['event']=='billboard-release']
 verifier.require(len(gate)==len(release)==1 and held['seq']<release[0]['seq'] and gate[0]['seq']<release[0]['seq']<baseline['seq'],'Billboard barrier did not release exactly once after the actual TakeOver dispatch was captured')
 if mode=='split-before':
  verifier.require(baseline['seq']<dispatch['seq']<pending['seq'],'Before-control did not reproduce the task interleaving')
  verifier.require(dispatch['consent']['ready'] is True and dispatch['consent']['phase']=='decision-ready','Before-control must be an allowed earlier request')
  verifier.require(not any(e['event']=='dispatch' and not e['consent']['ready'] for e in trace),'Before-control must not contain an actual pending request')
 elif mode=='atomic-after':
  verifier.require(dispatch['seq']<baseline['seq']<pending['seq'],'Atomic boundary did not include the earlier request in its baseline')
 elif mode=='pending-sync-negative':
  before=next(e for e in trace if e['event']=='cmp-before' and e.get('eventStatus')=='cmpuishown')
  verifier.require(baseline['seq']<before['seq']<dispatch['seq']<pending['seq'] and dispatch['consent']['ready'] is False and dispatch['consent']['phase']=='user-decision','Synchronous negative control was not observed during the CMP callback')
 else:
  verifier.require(pending['seq']<dispatch['seq'] and dispatch['consent']['ready'] is False and dispatch['consent']['phase']=='user-decision','Negative control did not actually dispatch during pending consent')


def main():
 results=[]
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
  for extension in ['.js','.min.js']:
   for mode in ['split-before','atomic-after','pending-negative','pending-sync-negative']:
    label=mode+extension
    try:
     try:
      detail=verifier.run(browser,'changed-decision',extension,change_boundary=boundary(mode),setup_control=install_control,prebid_control=install_auction_barrier)
     except verifier.ReadinessFailure as error:
      if mode=='atomic-after':raise
      verifier.require(str(error)=='Pending decision allowed a request','Control failed for an unrelated reason: '+str(error))
      verify_trace(mode,error.evidence)
      results.append({'case':label,'passed':True,'observed':'expected rejection','error':str(error),'evidence':error.evidence})
     else:
      verifier.require(mode=='atomic-after','Broken boundary or pending request unexpectedly passed')
      verify_trace(mode,{'trace':detail['consentTrace']})
      results.append({'case':label,'passed':True,'observed':'full verifier passed',**detail})
     print('PASS',label,flush=True)
    except Exception as error:
     results.append({'case':label,'passed':False,'error':str(error),'evidence':getattr(error,'evidence',{})});print('FAIL',label,str(error),flush=True)
  browser.close()
 (verifier.out/'boundary-results.json').write_text(json.dumps(results,indent=2)+'\n')
 return 0 if all(r['passed'] for r in results) else 1


if __name__=='__main__':raise SystemExit(main())
