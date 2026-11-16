"""Full generated 3.22 wrapper + native locked Prebid; synthetic adapters/GPT/CMP only."""
import argparse,hashlib,json,os
from datetime import datetime,timezone,timedelta
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'.generated/bidder-rules-native'
manifest=json.loads((OUT/'manifest.json').read_text())
mock=(ROOT/'tests/runtime/mock-ad-libraries.js').read_text()
a=mock.index('  window.pbjs = {');b=mock.index('  window.__tcfapi =',a)
mock=mock[:a]+mock[b:]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--version',choices=['11.11.0','11.34.0'])
args=parser.parse_args()
version=args.version or '11.34.0'
if args.version:
 native_manifest=json.loads((Path(os.environ.get('CONTEXTUAL_PREBID_ROOT',ROOT/'.generated/contextual-prebid'))/version/'manifest.json').read_text())
 expected_commit={'11.11.0':'0f6ba177203d5f63e0a11453ed0c887fcf5efe33','11.34.0':'195e0c6069928ed906bde550cb4e4183d1dc8474'}[version]
 assert native_manifest['sourceCommit']==expected_commit
 native=Path(native_manifest['buildPath']).read_bytes()
 prebid_sha=native_manifest['buildSha256']
else:
 native=(ROOT/'vendor/prebid/tanjug-11.34.0/prebid.js').read_bytes()
 prebid_sha=manifest['prebidSha256']
assert hashlib.sha256(native).hexdigest()==prebid_sha
ORIGIN='https://bidder-rule-fixture.invalid'
HTML='<!doctype html><link rel="icon" href="data:,"><body style="margin:0;height:1500px"><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div></body>'
hook=r'''
window.__wire=[];window.__rounds={};window.__sent=[];window.__auctions=[];
window.__AD_GEO={version:1,getSnapshot:()=>__country?{version:1,status:'known',source:'cloudflare',country:__country}:{version:1,status:'pending',country:null}};
const refresh=__testAds.service.refresh;
__testAds.service.refresh=function(slots,options){for(const slot of slots||[])__sent.push({code:slot.id,targeting:JSON.parse(JSON.stringify(slot.targeting)),at:Date.now()});return refresh.call(this,slots,options);};
googletag.apiReady=true;googletag.pubadsReady=true;
window.pbjs={que:[function(){
 pbjs.setConfig({useBidCache:true});
 for(const name of ['pubmatic','openx'])pbjs.registerBidAdapter(null,name,{
  code:name,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
  buildRequests(bids){return {method:'GET',url:'https://bidder-rule-fixture.invalid/bid',data:{payload:JSON.stringify(bids.map(b=>{
   const key=name+':'+b.adUnitCode,round=(__rounds[key]||0)+1;__rounds[key]=round;
   __wire.push({code:b.adUnitCode,bidder:name,round,auctionId:b.auctionId,schain:b.ortb2?.source?.schain||b.ortb2?.source?.ext?.schain,at:Date.now()});
   const size=(b.mediaTypes?.banner?.sizes||b.sizes||[]).find(s=>Array.isArray(s)&&s.length===2&&s.every(n=>Number.isFinite(n)&&n>0));
   if(!size)throw Error('Synthetic banner request has no numeric size: '+b.adUnitCode);
   return {requestId:b.bidId,cpm:name==='pubmatic'?10:1,ttl:300,currency:'EUR',netRevenue:true,creativeId:name+'-'+round,
    ad:'<div>Synthetic</div>',width:size[0],height:size[1]};
  }))},options:{withCredentials:false}};},interpretResponse:r=>r.body.bids
 });
 pbjs.onEvent('auctionInit',a=>__auctions.push({id:a.auctionId,codes:a.adUnitCodes,at:Date.now()}));
}]};
'''
results=[]
def scalar(value):return value[0] if isinstance(value,list) else value
def settle(page,until):
 for i in range(80):
  page.clock.run_for(100);page.wait_for_timeout(10)
  if page.evaluate(until):return
 raise AssertionError('Bounded native auction wait expired')
with sync_playwright() as pw:
 try:
  browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
 except Exception as error:
  (OUT/('browser-results-'+version+'.json')).write_text(json.dumps({'passed':False,'prebidVersion':version,'prebidSha256':prebid_sha,'setupError':str(error),'checks':[]},indent=2)+'\n')
  raise SystemExit('BLOCKED native browser launch: '+str(error).splitlines()[0])
 for case in manifest['cases']:
  for extension,artifact in case['files'].items():
   source=(OUT/artifact['file']).read_text();assert hashlib.sha256(source.encode()).hexdigest()==artifact['sha256']
   context=browser.new_context(viewport={'width':1280,'height':900},service_workers='block');page=context.new_page()
   errors=[];external=[];page.on('pageerror',lambda e:errors.append(str(e)))
   def route(r):
    url=urlsplit(r.request.url)
    if r.request.url==ORIGIN+'/fixture':r.fulfill(content_type='text/html',body=HTML)
    elif r.request.url.startswith(ORIGIN+'/bid'):
     r.fulfill(content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'bids':json.loads(parse_qs(url.query)['payload'][0])}))
    elif r.request.url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
     r.fulfill(content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'USD':1,'EUR':1}}}))
    else:external.append(r.request.url);r.abort()
   context.route('**/*',route)
   data=None
   try:
    now=datetime(2026,11,12,12,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
    page.goto(ORIGIN+'/fixture');page.evaluate('window.__testOptions={}');page.add_script_tag(content=mock)
    country=None if case['name'].startswith('unknown-') else 'DE' if case['name']in ['all-skipped','disabled'] else 'RS'
    page.evaluate('(v)=>window.__country=v',country);page.add_script_tag(content=hook);page.add_script_tag(content=native.decode());page.add_script_tag(content=source)
    settle(page,'__sent.length>=2')
    # The inherited wrapper defaults cache off. Enable it through the native
    # public API after configuration to test coexistence on the next auction.
    page.evaluate('pbjs.setConfig({useBidCache:true})')
    first=page.evaluate('({wire:__wire.slice(),sent:__sent.slice(),cache:pbjs.getConfig("useBidCache")})')
    expected={'openx'} if case['name']=='unknown-skip' else set() if case['name']=='all-skipped' else {'pubmatic','openx'}
    assert {w['bidder'] for w in first['wire']}==expected,first
    assert len(first['sent'])==2,first
    for row in first['wire']:assert row['schain']['nodes'][0]['sid']=='fixture-seller',row
    if case['name']=='all-skipped':assert all(not scalar(s['targeting'].get('hb_adid')) and s['targeting'].get('aq_bid_count')is None for s in first['sent']),first
    if case['name'] in ['country-refresh','layout-refresh']:
     assert all(scalar(s['targeting'].get('hb_bidder'))=='pubmatic' for s in first['sent']),first
     page.evaluate('window.__phaseAt=Date.now()')
     if case['name']=='country-refresh':page.evaluate('window.__country="DE"')
     else:page.set_viewport_size({'width':390,'height':900});page.wait_for_timeout(30)
     page.clock.run_for(32000);settle(page,'__sent.length>=4')
     second=page.evaluate('({wire:__wire.filter(w=>w.at>__phaseAt),sent:__sent.slice(2)})')
     assert second['wire'] and {w['bidder'] for w in second['wire']}=={'openx'},second
     for sent in second['sent']:
      assert scalar(sent['targeting'].get('hb_bidder'))=='openx',sent
      assert not scalar(sent['targeting'].get('hb_adid_pubmatic')),sent
      assert not scalar(sent['targeting'].get('hb_pb_pubmatic')),sent
    data=page.evaluate('({wire:__wire,sent:__sent,debug:__AD_BIDDER_RULES.snapshot(),cache:pbjs.getConfig("useBidCache"),prebidVersion:pbjs.version,auctions:__auctions})')
    assert data['prebidVersion'].lstrip('v')==version,data['prebidVersion']
    assert data['cache'] is True,'Fixture must test native cache enabled'
    assert not errors,errors;assert not external,external
    results.append({'case':case['name'],'file':extension,'passed':True,'observation':data})
    print('PASS',case['name'],extension,flush=True)
   except Exception as e:
    data=page.evaluate('({wire:window.__wire,sent:window.__sent,debug:window.__AD_BIDDER_RULES?.snapshot(),readiness:window.__tesseraReadiness?.snapshot(),events:window.pbjs?.getEvents()})')
    results.append({'case':case['name'],'file':extension,'passed':False,'error':str(e),'pageErrors':errors,'external':external,'observation':data})
    print('FAIL',case['name'],extension,str(e)[:1000],flush=True)
   finally:context.close()
 browser.close()
report={'scope':'Full generated 3.22 ads.js and ads.min.js; native Prebid core/cache with synthetic adapters, GPT and CMP; all HTTP intercepted. No SSP receipt or live demand claim.','prebidVersion':version,'prebidSha256':prebid_sha,'descriptor':manifest['descriptor'],'passed':all(r['passed']for r in results),'checks':results}
(OUT/('browser-results-'+version+'.json')).write_text(json.dumps(report,indent=2)+'\n')
raise SystemExit(0 if report['passed'] else 1)
