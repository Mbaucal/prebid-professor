"""Isolated scope experiment. Native Prebid and real GPT are separate probes.
All browser requests are intercepted; only --fetch-gpt-fixtures downloads public
Google JavaScript ahead of the test. No ad/ping/publisher request reaches network.
"""
import argparse,hashlib,json,os,re,urllib.request
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
PB=ROOT/'vendor/prebid/tanjug-11.34.0/prebid.js'
PB_SHA='384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b'
OUT=ROOT/'.generated/geo-cmp-fallback'
sha=lambda b:hashlib.sha256(b).hexdigest()

def fetch_gpt(folder):
 folder.mkdir(parents=True,exist_ok=True);manifest={}
 for mode,host in [('standard','securepubads.g.doubleclick.net'),('limited','pagead2.googlesyndication.com')]:
  url=f'https://{host}/tag/js/gpt.js'
  with urllib.request.urlopen(url,timeout=30) as response:
   if response.url!=url:raise ValueError('Unexpected GPT redirect')
   source=response.read()
  versions=set(re.findall(rb're\([A-Za-z]+,"(m\d{12})"\)',source))
  if len(versions)!=1:raise ValueError('Review changed GPT implementation URL before fetching')
  version=next(iter(versions)).decode()
  paths=[(f'{mode}.js',url,source),(f'{mode}-impl.js',f'https://{host}/pagead/managed/js/gpt/{version}/pubads_impl.js',None)]
  for name,origin,body in paths:
   if body is None:
    with urllib.request.urlopen(origin,timeout=30) as response:
     if response.url!=origin:raise ValueError('Unexpected GPT implementation redirect')
     body=response.read()
   (folder/name).write_bytes(body);manifest[name]={'url':origin,'sha256':sha(body),'bytes':len(body)}
 (folder/'sources.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print('Downloaded only four public GPT JavaScript files; no ad requests.')

def native(browser,name,controller_path):
 page=browser.new_page();unexpected=[];errors=[];pending=[];bids=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 def route(r):
  u=urlparse(r.request.url)
  if u.netloc=='geo-cmp.test':r.fulfill(status=200,content_type='text/html',body='<!doctype html><body>Offline scope test</body>')
  elif u.netloc=='geo-scope.test' and u.path=='/v1':
   q=parse_qs(u.query);data={'schema':1,'siteId':q['siteId'][0],'pageId':q['pageId'][0],'nonce':q['nonce'][0],'country':'RS','allowed':name!='untrusted-scope','issuedAt':1790985600000,'expiresAt':1790985660000}
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*','Cache-Control':'private, no-store'},body=json.dumps(data))
  elif u.netloc=='readiness-fixture.invalid':
   data=json.loads(parse_qs(u.query)['payload'][0]);bids.append(len(data))
   for b in data:b.update(creativeId='fixture',currency='USD',netRevenue=True,ad='<div>Offline</div>')
   body=json.dumps({'bids':data})
   if name=='late-reject-held-response':pending.append((r,body))
   else:r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=body)
  else:unexpected.append(u.netloc+u.path);r.abort()
 page.route('**/*',route)
 try:
  page.goto('https://geo-cmp.test/')
  page.add_script_tag(content=controller_path.read_text().replace('export function','function').replace('export async function','async function'))
  page.add_script_tag(content=(ROOT/'tests/support/geo-cmp-native-fixture.js').read_text())
  page.evaluate("startController("+('true' if name=='loading-scope-true' else 'undefined')+")")
  adapter=(ROOT/'tests/runtime/full-cache-browser-fixture.js').read_text().replace('code:name,supportedMediaTypes',"code:name,gvlid:name==='pubmatic'?76:69,supportedMediaTypes")
  page.add_script_tag(content=adapter);page.add_script_tag(content=PB.read_text())
  assert not page.evaluate('ask()'),'request before explicit threshold'
  page.evaluate('advanceLoading()')
  if name in ['untrusted-scope','loading-scope-true']:
   assert not page.evaluate('ask()'),'untrusted/conflicting scope started native Prebid'
  else:
   assert page.evaluate('ask()'),'trusted loading fallback did not start'
   page.wait_for_function('__nativeCalls.length===1')
   if name=='late-reject-held-response':
    page.evaluate("emit(decision('reject'))")
    for request,body in pending:request.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=body)
    pending.clear();page.wait_for_function('__done===1')
   else:page.wait_for_function('__done===1')
   if name in ['late-reject','late-true-loading']:
    page.evaluate("emit("+("decision('reject')" if name=='late-reject' else "{gdprApplies:true,cmpStatus:'loading'}")+")")
   if name.startswith('late-'):
    assert not page.evaluate('ask()'),'late scope conflict allowed next native request'
    page.wait_for_timeout(100)
   elif name=='same-page-refresh':
    page.evaluate('__now+=120000');assert page.evaluate('ask()');page.wait_for_function('__done===2')
  data=page.evaluate('nativeReport()');data.update(syntheticNetworkRequests=len(bids),browserErrors=errors,unexpectedNetwork=unexpected)
  assert not errors and not unexpected
  assert data['apiUnchanged'] and data['enabled'],'publisher API or TCF enforcement disabled'
  if name in ['untrusted-scope','loading-scope-true']:assert not data['nativeCalls'] and not data['simulatedDispatches']
  else:
   assert data['nativeMode']=='static'
   assert all(r['gdprApplies'] is False and not r['tcStringPresent'] for r in data['nativeCalls'])
   assert len(data['nativeCalls'])==(2 if name=='same-page-refresh' else 1)
   assert len(data['simulatedDispatches'])==(0 if name=='late-reject-held-response' else 2 if name=='same-page-refresh' else 1)
  return {'case':name,'passed':True,'evidence':data}
 except Exception as error:
  try:data=page.evaluate('nativeReport()')
  except Exception:data={}
  return {'case':name,'passed':False,'error':str(error),'evidence':data,'unexpectedNetwork':unexpected,'browserErrors':errors}
 finally:
  for request,_ in pending:
   try:request.abort()
   except Exception:pass
  page.close()

def gpt(browser,name,folder,manifest,controller_path):
 limited=name.startswith('limited-');mode='limited' if limited else 'standard'
 page=browser.new_page();attempts=[];blocked=[];errors=[];early=name=='early-regional-native-gpt';early_data=None
 page.on('pageerror',lambda e:errors.append(str(e)))
 root=manifest[f'{mode}.js']['url'];impl=manifest[f'{mode}-impl.js']['url']
 def route(r):
  u=urlparse(r.request.url)
  if u.netloc=='geo-gpt.test':r.fulfill(status=200,content_type='text/html',body='<!doctype html><body><div id="ad" style="width:300px;height:250px"></div></body>')
  elif u.netloc=='geo-scope.test':
   q=parse_qs(u.query);r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*','Cache-Control':'private, no-store'},body=json.dumps({'schema':1,'siteId':q['siteId'][0],'pageId':q['pageId'][0],'nonce':q['nonce'][0],'country':'RS','allowed':True,'issuedAt':1790985600000,'expiresAt':1790985660000}))
  elif u.netloc=='readiness-fixture.invalid':
   data=json.loads(parse_qs(u.query)['payload'][0])
   for b in data:b.update(creativeId='fixture',currency='USD',netRevenue=True,ad='<div>Offline</div>')
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'bids':data}))
  elif u._replace(query='',fragment='').geturl() in [root,impl]:r.fulfill(status=200,content_type='application/javascript',body=(folder/(f'{mode}.js' if u._replace(query='',fragment='').geturl()==root else f'{mode}-impl.js')).read_bytes())
  elif u.path.startswith('/gampad/ads'):
   q=parse_qs(u.query);attempts.append({'host':u.netloc,'path':u.path,'gdpr':q.get('gdpr',['absent'])[0],'ltd':q.get('ltd',['absent'])[0],'npa':q.get('npa',['absent'])[0],'tcStringPresent':bool(q.get('gdpr_consent',[''])[0])})
   r.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*'},body='')
  else:blocked.append(u.netloc+u.path);r.abort()
 page.route('**/*',route)
 try:
  page.goto('https://geo-gpt.test/')
  if early:
   page.add_script_tag(content=controller_path.read_text().replace('export function','function').replace('export async function','async function'))
   page.add_script_tag(content=(ROOT/'tests/support/geo-cmp-native-fixture.js').read_text())
   early_data=page.evaluate('''async()=>{
    const geo=await fetchTrustedGeo({endpoint:'https://geo-scope.test/v1',siteId:__site,pageId:__page,nonce:__nonce,now:()=>__now});
    const inputs={geo,siteId:__site,pageId:__page,nonce:__nonce,now:()=>__now,publisherOwnsCmpStartup:true,existingTcfApi:typeof window.__tcfapi==='function',existingPrebidInitialized:!!window.pbjs?.requestBids,existingGptInitialized:!!window.googletag?.apiReady,hasObservedCmp:false};
    window.startPlan=planRegionalStartup(inputs);
    return {route:startPlan.route,existingTcfApi:inputs.existingTcfApi,existingPrebidInitialized:inputs.existingPrebidInitialized,existingGptInitialized:inputs.existingGptInitialized};
   }''')
   assert early_data=={'route':'regional','existingTcfApi':False,'existingPrebidInitialized':False,'existingGptInitialized':False}
   adapter=(ROOT/'tests/runtime/full-cache-browser-fixture.js').read_text().replace('code:name,supportedMediaTypes',"code:name,gvlid:name==='pubmatic'?76:69,supportedMediaTypes")
   page.add_script_tag(content=adapter);page.add_script_tag(content=PB.read_text())
   page.evaluate('''()=>{
    pbjs.setConfig({deviceAccess:false,userSync:{syncEnabled:false},consentManagement:{gdpr:{cmpApi:'static',consentData:{getTCData:startPlan.consentData}}}});
    pbjs.onEvent('bidRequested',r=>__nativeCalls.push({gdprApplies:r.gdprConsent?.gdprApplies,tcStringPresent:!!r.gdprConsent?.consentString}));
    pbjs.requestBids({adUnits:[{code:'Billboard',mediaTypes:{banner:{sizes:[[300,250]]}},bids:[{bidder:'pubmatic',params:{publisherId:'fixture',adSlot:'fixture'}}]}],timeout:1500,bidsBackHandler:()=>{__done++;}});
   }''')
   page.wait_for_function('__done===1')
   early_data.update(page.evaluate('({nativeCalls:__nativeCalls,tcfApiAbsent:typeof window.__tcfapi!=="function",nativeEnabled:pbjs.getConfig("consentManagement").gdpr.enabled!==false})'))
   assert early_data['nativeCalls']==[{'gdprApplies':False,'tcStringPresent':False}] and early_data['tcfApiAbsent'] and early_data['nativeEnabled']
  page.clock.install()
  if name not in ['standard-no-cmp','early-regional-native-gpt']:
   page.evaluate('''name=>{window.cmpCalls=[];window.loadingCallbacks=0;const listeners=[];const data={listenerId:1,cmpId:1,cmpVersion:1,tcfPolicyVersion:4,cmpStatus:name==='standard-ready-false'?'loaded':'loading',eventStatus:name==='standard-ready-false'?'tcloaded':undefined,gdprApplies:name==='standard-ready-false'?false:name.endsWith('true')?true:undefined};const deliver=cb=>{loadingCallbacks++;cb(data,true);};window.__tcfapi=(cmd,v,cb,id)=>{cmpCalls.push(cmd);if(cmd==='addEventListener'){listeners.push(cb);deliver(cb);}else if(cmd==='ping')cb({cmpLoaded:false,cmpStatus:'loading'},true)};if(data.cmpStatus==='loading')setInterval(()=>listeners.forEach(deliver),1000)}''',name)
  page.evaluate('''limited=>{window.googletag={cmd:[()=>{googletag.defineSlot('/6355419/Travel/Europe',[300,250],'ad').addService(googletag.pubads());if(limited)googletag.pubads().setPrivacySettings({limitedAds:true});googletag.enableServices();googletag.display('ad');window.displayInvoked=true;}]}}''',limited)
  page.add_script_tag(url=root);page.wait_for_timeout(500);page.clock.run_for(35000);page.wait_for_timeout(500);assert page.evaluate('window.displayInvoked===true')
  data={'displayInvoked':True,'observationMs':35000,'gptVersion':page.evaluate('googletag.getVersion()'),'cmpCalls':page.evaluate('window.cmpCalls||[]'),'successfulLoadingCallbacks':page.evaluate('window.loadingCallbacks||0'),'earlyRegional':early_data,'requestAttempts':attempts,'blockedOtherRequests':sorted(set(blocked)),'browserErrors':errors,'realNetworkAdRequests':0}
  assert not errors
  expected=name in ['standard-no-cmp','standard-ready-false','early-regional-native-gpt']
  if 'loading' in name:assert data['successfulLoadingCallbacks']>=30,'Perpetual successful loading scenario not exercised'
  assert bool(attempts)==expected,'GPT behavior changed; review current build instead of claiming fallback'
  if name=='standard-ready-false':assert all(r['gdpr']=='0' for r in attempts)
  return {'case':name,'passed':True,'fallbackAdRequestPossible':bool(attempts),'evidence':data}
 except Exception as error:return {'case':name,'passed':False,'error':str(error),'attempts':attempts,'browserErrors':errors,'blockedOtherRequests':blocked}
 finally:page.close()

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--native-only',action='store_true');parser.add_argument('--fetch-gpt-fixtures',action='store_true');parser.add_argument('--gpt-dir',type=Path,default=OUT/'gpt');parser.add_argument('--controller',type=Path,default=ROOT/'tests/support/geo-cmp-fallback-experiment.mjs');args=parser.parse_args()
 if args.fetch_gpt_fixtures:fetch_gpt(args.gpt_dir);return 0
 assert sha(PB.read_bytes())==PB_SHA
 manifest={} if args.native_only else json.loads((args.gpt_dir/'sources.json').read_text())
 for name,item in manifest.items():assert sha((args.gpt_dir/name).read_bytes())==item['sha256']
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
  native_results=[];gpt_results=[]
  for case in ['loading-trusted','untrusted-scope','loading-scope-true','late-reject','late-true-loading','late-reject-held-response','same-page-refresh']:
   r=native(browser,case,args.controller);native_results.append(r);print('NATIVE',case,r['passed'],r.get('error',''),flush=True)
  for case in ([] if args.native_only else ['early-regional-native-gpt','standard-no-cmp','standard-ready-false','standard-loading-unknown','standard-loading-true','limited-loading-unknown','limited-loading-true']):
   r=gpt(browser,case,args.gpt_dir,manifest,args.controller);gpt_results.append(r);print('GPT CHARACTERIZATION',case,r['passed'],'adAttempt',r.get('fallbackAdRequestPossible'),flush=True)
  browser.close()
 results={'nativePrebidSha256':PB_SHA,'gptSources':manifest,'native':native_results,'gptCharacterization':gpt_results,'gptSkipped':args.native_only,'endToEndFallbackReady':False,'blocker':'Stuck CMP still prevents real GPT request attempts; no supported scope override demonstrated.'}
 OUT.mkdir(parents=True,exist_ok=True);(OUT/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print('END-TO-END FALLBACK NOT READY: native success does not release stuck GPT.')
 # Characterization can pass while acceptance remains blocked. Keep that boundary explicit.
 return (0 if all(r['passed'] for r in native_results) else 1) if args.native_only else 1
if __name__=='__main__':raise SystemExit(main())
