#!/usr/bin/env python3
"""Full generated ads.js/min + native Adform/Prebid; synthetic GPT/CMP and all HTTP intercepted."""
import argparse, hashlib, json, os
from datetime import datetime,timezone,timedelta
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
RUNTIME=Path(os.environ.get('ACCOUNTS_RUNTIME_ROOT',ROOT)).resolve()
OUT=Path(os.environ.get('ACCOUNTS_WRAPPER_ROOT',ROOT/'.generated/accounts-wrapper')).resolve()
NATIVE=Path(os.environ.get('ACCOUNTS_PREBID_ROOT',ROOT/'.generated/accounts-prebid')).resolve()
PINS={'11.11.0':'0f6ba177203d5f63e0a11453ed0c887fcf5efe33','11.34.0':'195e0c6069928ed906bde550cb4e4183d1dc8474','11.45.0':'4bd01c0c587b1047cfffe9da88dd7437d01197d3'}
ORIGIN='https://account-wrapper.invalid'
HTML='<!doctype html><link rel="icon" href="data:,"><body style="margin:0;height:1500px"><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="m.box_1" class="wrapperAd" style="height:250px"></div></body>'
mock=(RUNTIME/'tests/runtime/mock-ad-libraries.js').read_text()
a=mock.index('  window.pbjs = {');b=mock.index('  window.__tcfapi =',a);mock=mock[:a]+mock[b:]
hook=r'''
window.__requests=[];window.__sent=[];window.__pps=null;
window.adsKeywords={category:'Sports',pageType:'Article'};
window.__AD_GEO={version:1,getSnapshot:()=>__country?{version:1,status:'known',source:'cloudflare',country:__country}:{version:1,status:'unknown',country:null}};
const refresh=__testAds.service.refresh;
__testAds.service.refresh=function(slots,options){for(const slot of slots||[])__sent.push({code:slot.id,targeting:JSON.parse(JSON.stringify(slot.targeting)),pps:JSON.parse(JSON.stringify(__pps))});return refresh.call(this,slots,options);};
googletag.apiReady=true;googletag.pubadsReady=true;
const setConfig=googletag.setConfig;
googletag.setConfig=function(config){if(config.pps)__pps=config.pps;return setConfig.apply(this,arguments);};
window.pbjs={que:[function(){
 pbjs.setConfig({ortb2:{site:{name:'Existing publisher FPD',content:{data:[{name:'existing.invalid',ext:{segtax:500},segment:[{id:'keep-existing'}]}]}},source:{ext:{publisherMarker:'keep-source'}}}});
 pbjs.setBidderConfig({bidders:['pubmatic'],config:{gzipEnabled:false}});
 pbjs.onEvent('bidRequested',r=>__requests.push({auctionId:r.auctionId,bidderRequestId:r.bidderRequestId,bidder:r.bidderCode,ortb2:JSON.parse(JSON.stringify(r.ortb2||{})),bids:r.bids.map(b=>({code:b.adUnitCode,bidId:b.bidId,params:b.params,ortb2:JSON.parse(JSON.stringify(b.ortb2||{}))}))}));
}]};
'''
def check(ok,message):
 if not ok:raise AssertionError(message)
def chain(ortb):return ortb.get('source',{}).get('schain') or ortb.get('source',{}).get('ext',{}).get('schain')
def validate(data,wire,case,version,errors,external):
 check(not errors,'Uncaught browser errors: '+str(errors));check(not external,'Unexpected external requests blocked: '+str(external))
 check(data['version'].lstrip('v')==version,'Wrong Prebid version')
 prefix='pm_' if case=='pubmatic-deal' else 'adf_'
 expected={'adf_ag','adf_custom'} if case in ['de','unknown'] else {'adf_smn','adf_ag','adf_custom'}
 expected={code.replace('adf_',prefix) for code in expected}
 check({r['bidder'] for r in data['requests']}==expected,'Wrong exact alias eligibility: '+str(data['requests']))
 check(len(data['sent'])==2,'Both positions must reach GAM fallback exactly once')
 positions={'Billboard','m.box_1'} if case in ['punctuated-position','position-rule','pubmatic-deal'] else {'Billboard','P1'}
 check({s['code'] for s in data['sent']}==positions,'Wrong GAM positions')
 for sent in data['sent']:check(sent.get('pps',{}).get('taxonomies',{}).get('IAB_CONTENT_2_2',{}).get('values')==['483'],'GAM PPS not bound to context')
 expected_chains={'adf_smn':{'ver':'1.0','complete':1,'nodes':[{'asi':'seller.invalid','sid':'site-seller','hp':1}]},'adf_ag':None,'adf_custom':{'ver':'1.0','complete':1,'nodes':[{'asi':'seller.invalid','sid':'custom-seller','hp':1}]}}
 expected_context={'adf_smn':(6,'483'),'adf_custom':(7,'VK7KD0')}
 expected_chains={code.replace('adf_',prefix):value for code,value in expected_chains.items()}
 expected_context={code.replace('adf_',prefix):value for code,value in expected_context.items()}
 def inspect(code,ortb):
  check(chain(ortb)==expected_chains[code],f'{code}: incorrect SChain {chain(ortb)}')
  content=ortb.get('site',{}).get('content',{}).get('data',[])
  check(any(x.get('name')=='existing.invalid' for x in content),f'{code}: existing publisher context lost')
  managed=[x for x in content if x.get('name')=='example.invalid']
  if code in expected_context:
   taxonomy,category=expected_context[code]
   check(managed==[{'name':'example.invalid','ext':{'segtax':taxonomy},'segment':[{'id':category}]}],f'{code}: alias PPS mismatch {managed}')
  else:check(not managed,f'{code}: PPS leaked from another alias')
 for request in data['requests']:
  inspect(request['bidder'],request['ortb2'])
  check({b['code'] for b in request['bids']} <= positions,'Unexpected position in native request')
  for bid in request['bids']:
   inspect(request['bidder'],bid['ortb2'])
   if case=='pubmatic-deal': check(bid['params'].get('deals',[])==(['qa-deal-1234'] if request['bidder']=='pm_ag' and bid['code']=='m.box_1' else []),'Deal leaked to wrong alias/position or was lost')
 for code in expected:
  actual_positions=[b['code'] for r in data['requests'] if r['bidder']==code for b in r['bids']]
  expected_positions=['Billboard'] if case=='position-rule' and code=='adf_smn' else sorted(positions)
  check(sorted(actual_positions)==expected_positions,f'{code}: missing, duplicate or excluded position')
 by_mid={'999991':'adf_smn','999992':'adf_ag','999993':'adf_custom'}
 by_mid={key:code.replace('adf_',prefix) for key,code in by_mid.items()}
 check(len(wire)==len(data['requests']),'Unexpected real Adform request count: '+str(len(wire)))
 seen=set()
 for body in wire:
  code=by_mid.get(str(body.get('site',{}).get('publisher',{}).get('id') if case=='pubmatic-deal' else body.get('imp',[{}])[0].get('tagid')));check(code in expected,'Wrong Adform placement');seen.add(code)
  inspect(code,body)
  request=next((r for r in data['requests'] if r['bidder']==code and (r['bidderRequestId']==body.get('id') or {b['bidId'] for b in r['bids']}=={str(imp.get('id')) for imp in body.get('imp',[])})),None)
  check(request is not None and len(body.get('imp',[]))==len(request['bids']),'SSP payload does not match its exact native bidder request')
  if case=='pubmatic-deal':
   for imp in body.get('imp',[]):
    bid=next((b for b in request['bids'] if str(imp.get('id'))==b['bidId']),None)
    check(bid is not None,'PubMatic impression does not map to a bid')
    check(imp.get('pmp',{}).get('deals',[])==([{'id':'qa-deal-1234'}] if code=='pm_ag' and bid['code']=='m.box_1' else []),'Wire PMP deal lost or leaked across alias/position')
 check(seen==expected,'Missing Adform account request')
 check(all(a['status']=='configured' for a in data['accounts']['accounts']),'An account was not configured')
def settle(page):
 for _ in range(100):
  page.clock.run_for(100);page.wait_for_timeout(10)
  if page.evaluate('window.__sent.length>=2'):return
 raise AssertionError('Bounded wrapper/GAM wait expired')
def run(pw,version):
 manifest=json.loads((OUT/'manifest.json').read_text());native_manifest=json.loads((NATIVE/version/'manifest.json').read_text())
 check(native_manifest['sourceCommit']==PINS[version],'Unpinned native version')
 native=Path(native_manifest['buildPath']).read_bytes();check(hashlib.sha256(native).hexdigest()==native_manifest['buildSha256'],'Changed native build')
 results=[];report={'prebidVersion':version,'prebidSha256':native_manifest['buildSha256'],'descriptor':manifest['descriptor'],'checks':results,'scope':'Full generated3.22.1 ads.js andads.min.js with real Prebid core and Adformadapter, synthetic GPT/CMP, allHTTPintercepted. Not realGAM/SSPacceptance.'}
 try:
  browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox']);report['browserVersion']=browser.version
  for case in manifest['cases']:
   for extension,artifact in case['files'].items():
    source=(OUT/artifact['file']).read_text();check(hashlib.sha256(source.encode()).hexdigest()==artifact['sha256'],'Changed wrapper fixture')
    context=browser.new_context(viewport={'width':1280,'height':900},service_workers='block');page=context.new_page();errors=[];external=[];wire=[];data=None
    page.on('pageerror',lambda e:errors.append(str(e)))
    def route(r):
     req=r.request;url=urlsplit(req.url)
     if req.url==ORIGIN+'/fixture':r.fulfill(content_type='text/html',body=HTML)
     elif url.hostname in ['adx.adform.net','hbopenbid.pubmatic.com']:
      if req.method=='POST':wire.append(json.loads(req.post_data))
      r.fulfill(status=204,headers={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST,OPTIONS'},body='')
     else:external.append(req.url);r.abort()
    context.route('**/*',route)
    try:
     now=datetime(2026,11,15,12,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
     page.goto(ORIGIN+'/fixture');page.evaluate('window.__testOptions={}');page.add_script_tag(content=mock)
     page.evaluate('(v)=>window.__country=v','RS' if case['name'] in ['rs','punctuated-position','pubmatic-deal'] else None if case['name']=='unknown' else 'DE')
     page.add_script_tag(content=hook);page.add_script_tag(content=native.decode());page.add_script_tag(content=source)
     settle(page)
     data=page.evaluate('({requests:__requests,sent:__sent,accounts:__AD_BIDDER_ACCOUNTS.snapshot(),context:__AD_CONTEXT.snapshot(),rules:__AD_BIDDER_RULES.snapshot(),version:pbjs.version})')
     validate(data,wire,case['name'],version,errors,external)
     results.append({'case':case['name'],'file':extension,'passed':True,'observation':data,'wire':wire});print('PASS wrapper',version,case['name'],extension,flush=True)
    except Exception as e:
     results.append({'case':case['name'],'file':extension,'passed':False,'error':str(e),'observation':data,'wire':wire,'pageErrors':errors,'external':external});print('FAIL wrapper',version,case['name'],extension,str(e)[:1000],flush=True)
    finally:context.close()
  browser.close()
 except Exception as e:report['setupError']=str(e);print('BLOCKED wrapper',version,str(e).splitlines()[0],flush=True)
 report['passed']=len(results)==len(manifest['cases'])*2 and all(r['passed'] for r in results)
 (OUT/('browser-results-'+version+'.json')).write_text(json.dumps(report,indent=2)+'\n');return report['passed']
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--version',choices=PINS);args=parser.parse_args()
 with sync_playwright() as pw:outcomes=[run(pw,v) for v in ([args.version] if args.version else PINS)]
 raise SystemExit(0 if all(outcomes) else 1)
