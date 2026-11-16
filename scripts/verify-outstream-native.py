"""Pinned native PubMatic adapter + native renderer, synthetic OpenRTB/cache/vendor sink.
All network is intercepted. This proves dispatch safety, not vendor player lifecycle.
"""
import os,json,hashlib,gzip,sys
from pathlib import Path
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
stable='--stable' in sys.argv
out=root/('.generated/stable-outstream-evidence' if stable else '.generated/outstream-evidence');out.mkdir(parents=True,exist_ok=True)
generated_dir=root/('.generated/stable-revenue-evidence' if stable else '.generated/revenue-evidence')
pbsource=(root/'vendor/prebid/tanjug-11.34.0/prebid.js').read_text()
assert hashlib.sha256(pbsource.encode()).hexdigest()=='384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b','Prebid fixture changed'
puc=(root/'tests/fixtures/prebid-universal-creative-1.17.2/video.js').read_text()
assert hashlib.sha256(puc.encode()).hexdigest()=='b5c6d2ffc72f2df3316a4a29ab6210f1cbb9a74ed20c3b7f8dde559d4502539d','PUC fixture changed'
helpers=(root/'worker/runtime-outstream-v1/browser-functions.mjs').read_text().replace('export function','function')
settings={'format':'banner-outstream','playerSize':[640,360],'minDuration':5,'maxDuration':30,'playbackMethod':2,'placement':3,'plcmt':4,'partner':{'bidder':'pubmatic','adapter':'pubmatic','outstreamAU':'synthetic-renderer','activationConfirmed':True},'cacheUrl':'https://prebid.adnxs.com/pbc/v1/cache'}
html='<html><body><div id="P1" class="wrapperAd" style="width:640px;height:360px"></div><iframe id="creative"></iframe></body></html>'
results=[]
def run(browser,scenario,generated=None):
 page=browser.new_page();requests=[];pending=[];unknown=[];errors=[]
 page.on('console',lambda msg:print('BROWSER',msg.text) if os.environ.get('OUTSTREAM_DEBUG') else None)
 page.on('pageerror',lambda error:errors.append(str(error)))
 def route(r):
  url=r.request.url
  if url=='https://outstream.test/':r.fulfill(status=200,content_type='text/html',body=html.replace('id="P1"','id="Billboard"') if generated else html)
  elif 'cdn.jsdelivr.net/gh/prebid/currency-file' in url:
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'dataAsOf':'2026-10-11','conversions':{'USD':{'USD':1,'EUR':0.9},'EUR':{'USD':1.111111,'EUR':1}}}))
  elif 'pubmatic.com' in url:
   if r.request.method=='OPTIONS':r.fulfill(status=204,headers={'Access-Control-Allow-Origin':'https://outstream.test','Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'*'});return
   raw=r.request.post_data_buffer;data=json.loads(gzip.decompress(raw) if raw[:2]==b'\x1f\x8b' else raw);requests.append(data)
   bids=[{'id':'native-video','impid':imp['id'],'price':2.5,'adm':'<VAST version="3.0"><Ad id="synthetic"></Ad></VAST>','crid':'synthetic','w':imp.get('video',{}).get('w',640),'h':imp.get('video',{}).get('h',360),'mtype':2,'ext':{'prebid':{'type':'video'}}} for imp in data['imp']]
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'https://outstream.test','Access-Control-Allow-Credentials':'true'},body=json.dumps({'id':data['id'],'cur':'USD','seatbid':[{'bid':bids}]}))
  elif 'prebid.adnxs.com/pbc/v1/cache' in url:
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'https://outstream.test','Access-Control-Allow-Credentials':'true'},body=json.dumps({'responses':[{'uuid':'synthetic-cache-id'}]}))
  elif url in ['https://pubmatic.bbvms.com/r/synthetic-renderer.js','https://pubmatic.bbvms.com/r/fixture_renderer.js']:
   script="window.bluebillywig={renderers:[{_id:'pubmatic-synthetic-renderer',bootstrap:function(config,element){window.__played.push({code:config.code,hasVast:!!(config.vastXml||config.vastUrl),elementId:element?.id});}}]};"
   if generated:script=script.replace('pubmatic-synthetic-renderer','pubmatic-fixture_renderer')
   if scenario=='delayed-consent':pending.append((r,script))
   else:r.fulfill(status=200,content_type='application/javascript',body=script)
  else:unknown.append(url);r.abort()
 page.route('**/*',route)
 try:
  page.goto('https://outstream.test/');
  page.clock.install(time=datetime(2026,10,11,12,0,0,tzinfo=timezone.utc))
  page.add_script_tag(content=pbsource);page.add_script_tag(content=helpers)
  if generated:
   page.add_script_tag(content=(root/'tests/runtime/mock-ad-libraries.js').read_text())
   page.evaluate("delete window.pbjs")
   page.add_script_tag(content=pbsource)
   page.evaluate("""() => {
    window.__played=[];window.__bids=[];window.__cmpListeners=[];
    window.__tcfapi=(cmd,version,cb)=>{if(cmd==='addEventListener'){__cmpListeners.push(cb);cb({gdprApplies:false},true);}};
    window.__change=()=>__cmpListeners.forEach(cb=>cb({gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown'},true));
    pbjs.onEvent('bidResponse',bid=>__bids.push(bid));
    const refresh=__testAds.service.refresh;
    __testAds.service.refresh=function(slots,opts){window.__done=true;return refresh.call(this,slots,opts);};
   }""")
   page.add_script_tag(content=generated.read_text())
  else:
   page.evaluate('''settings=>{
    window.__played=[];window.__scope={ready:true,epoch:1};window.__targeted=[];window.__bids=[];
    pbjs.setConfig({debug:false,enableSendAllBids:true,bidderTimeout:1000,consentManagement:{gdpr:{cmpApi:'static',consentData:{getTCData:{gdprApplies:false}}}},cache:{url:settings.cacheUrl},userSync:{syncEnabled:false}});
    installOutstreamRenderGuard(pbjs,{codes:['P1'],consent:()=>__scope,authorized:(code,id)=>__targeted.includes(id)});
    pbjs.onEvent('bidResponse',bid=>__bids.push(bid));
    const unit=applyOutstreamUnit({code:'P1',mediaTypes:{banner:{sizes:[[300,250]]}},bids:[{bidder:'pubmatic',params:{publisherId:'156000',adSlot:'synthetic-display'}}]},settings);
    pbjs.addAdUnits(unit);pbjs.requestBids({bidsBackHandler:()=>window.__done=true});
   }''',settings)
  if scenario=='no-refresh':
   for _ in range(150):
    page.clock.run_for(20);page.wait_for_timeout(10)
    if page.evaluate('window.__done===true'):break
  page.wait_for_function('window.__done===true',timeout=15000)
  if not page.evaluate('__bids.length'):raise AssertionError('No real PubMatic video bid '+str(requests))
  assert page.evaluate('__bids[0].mediaType')=='video'
  assert page.evaluate('__bids[0].netRevenue') is True,'Native bid is not net revenue'
  if generated:
   assert page.evaluate('__bids[0].currency')=='EUR'
   assert abs(page.evaluate('__bids[0].cpm')-2.25)<0.00001,'Native currency conversion did not apply'
  assert page.evaluate('__played.length')==0,'Renderer started before creative selection'
  assert requests[0]['imp'][0].get('video'),'Native request lacks video'
  if generated:assert any(d['id']=='0000199' for d in requests[0]['imp'][0].get('pmp',{}).get('deals',[])),'Managed deal lost in native video request'
  assert bool(requests[0]['imp'][0].get('banner'))==('outstream-only' not in str(generated)),'Wrong native format'
  if scenario=='direct-banner':pass
  else:
   if not generated:page.evaluate("__targeted=[__bids[0].adId]")
   else:assert page.evaluate("adSlots.Billboard.getTargetingKeys().some(k=>k.startsWith('hb_adid')&&adSlots.Billboard.getTargeting(k).includes(__bids[0].adId))"),'Native video ID not dispatched to GPT'
   if scenario=='changed-consent':page.evaluate('__change()' if generated else '__scope={ready:true,epoch:2}')
   if scenario=='expired':page.wait_for_timeout(1);page.evaluate('Date.now=()=>Number.MAX_SAFE_INTEGER')
   # Execute the pinned official PUC in a friendly iframe, as a selected GAM creative.
   frame=page.query_selector('#creative').content_frame();frame.add_script_tag(content=puc)
   ad_id=page.evaluate('__bids[0].adId');frame.evaluate('id=>ucTag.renderAd(document,{adId:id})',ad_id)
   if scenario=='delayed-consent':
    page.wait_for_function("document.querySelector('script[src*=\"pubmatic.bbvms.com\"]')!==null")
    page.evaluate('__change()' if generated else '__scope={ready:false,epoch:2}')
    for r,script in pending:r.fulfill(status=200,content_type='application/javascript',body=script)
    pending.clear()
   if scenario in ['winner','no-refresh']:
    page.wait_for_function('__played.length===1')
    frame.evaluate('id=>ucTag.renderAd(document,{adId:id})',ad_id)
  if scenario=='no-refresh':
   page.clock.run_for(120000);page.wait_for_timeout(50)
   assert page.evaluate('__testAds.observations.requests.filter(r=>r.id==="Billboard").length')==1,'Video position refreshed within120s'
   assert len(requests)==1,'Video position started another native auction'
  page.wait_for_timeout(150)
  played=page.evaluate('__played');assert len(played)==(1 if scenario in ['winner','no-refresh'] else 0),(scenario,played)
  assert not errors,errors
  assert not unknown,unknown
  return {'scenario':scenario,'generated':generated.name if generated else None,'generatedSha256':hashlib.sha256(generated.read_bytes()).hexdigest() if generated else None,'nativeVideoBids':page.evaluate('__bids.length'),'rendererBootstrapCount':len(played),'nativeRequestHasVideo':True,'externalNetwork':0,'passed':True}
 except Exception:
  print('DIAGNOSTIC',errors,unknown,page.evaluate('({bids:window.__bids?.length,ready:window.__tesseraReadiness?.snapshot(),requests:window.__testAds?.observations.requests})'))
  raise
 finally:
  for r,_ in pending:r.abort()
  page.close()
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox'])
 try:
  for scenario in ['winner','direct-banner','changed-consent','expired','delayed-consent']:
   result=run(browser,scenario);results.append(result);print('PASS',scenario)
  for name in ['outstream.js','outstream.min.js','outstream-only.js','outstream-only.min.js']:
   for scenario in ['winner','direct-banner','changed-consent','expired','delayed-consent','no-refresh']:
    result=run(browser,scenario,generated_dir/name);results.append(result);print('PASS',name,scenario)
 finally:
  browser.close();(out/'native-results.json').write_text(json.dumps({'prebidSha256':hashlib.sha256(pbsource.encode()).hexdigest(),'pucSha256':hashlib.sha256(puc.encode()).hexdigest(),'checks':results,'limitation':'Native adapter and renderer code with synthetic vendor bootstrap sink; actual pinned PUC friendly-iframe handoff; no real BlueBillywig player or live GAM selection.'},indent=2))
