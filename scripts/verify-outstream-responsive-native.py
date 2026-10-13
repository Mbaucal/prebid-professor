"""Generated preview.3 + pinned native Prebid/PUC, all network intercepted.
The vendor bootstrap sink verifies dispatch, not real BlueBillywig player layout.
"""
import os,json,hashlib,gzip
from pathlib import Path
from datetime import datetime,timezone
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/outstream-responsive-evidence';out.mkdir(parents=True,exist_ok=True)
pbsource=(root/'vendor/prebid/tanjug-11.34.0/prebid.js').read_text()
puc=(root/'tests/fixtures/prebid-universal-creative-1.17.2/video.js').read_text()
assert hashlib.sha256(pbsource.encode()).hexdigest()=='384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b'
assert hashlib.sha256(puc.encode()).hexdigest()=='b5c6d2ffc72f2df3316a4a29ab6210f1cbb9a74ed20c3b7f8dde559d4502539d'
checks=[]

def run(browser,name,scenario):
 width=1440 if scenario in ['desktop','page-type'] else 1920 if scenario=='disabled' else 390
 page=browser.new_page(viewport={'width':width,'height':900})
 requests=[];errors=[];unknown=[];pending=[]
 page.on('pageerror',lambda error:errors.append(str(error)))
 def route(r):
  url=r.request.url
  if url=='https://responsive-outstream.test/':
   spacer='<div style="height:6000px"></div>' if scenario=='lazy-resize' else ''
   r.fulfill(status=200,content_type='text/html',body='<html><body>'+spacer+'<div id="Billboard" class="wrapperAd lazyAd" style="min-height:250px"></div><iframe id="creative"></iframe></body></html>')
  elif 'pubmatic.com' in url:
   if r.request.method=='OPTIONS':r.fulfill(status=204,headers={'Access-Control-Allow-Origin':'https://responsive-outstream.test','Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'*'});return
   raw=r.request.post_data_buffer;data=json.loads(gzip.decompress(raw) if raw[:2]==b'\x1f\x8b' else raw);requests.append(data)
   bids=[{'id':'responsive-video','impid':imp['id'],'price':2.5,'adm':'<VAST version="3.0"><Ad id="synthetic"></Ad></VAST>','crid':'synthetic','w':imp['video']['w'],'h':imp['video']['h'],'mtype':2,'ext':{'prebid':{'type':'video'}}} for imp in data['imp']]
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'https://responsive-outstream.test','Access-Control-Allow-Credentials':'true'},body=json.dumps({'id':data['id'],'cur':'USD','seatbid':[{'bid':bids}]}))
  elif 'prebid.adnxs.com/pbc/v1/cache' in url:
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'https://responsive-outstream.test','Access-Control-Allow-Credentials':'true'},body=json.dumps({'responses':[{'uuid':'synthetic-responsive-cache'}]}))
  elif url=='https://pubmatic.bbvms.com/r/fixture_renderer.js':
   script="""window.bluebillywig={renderers:[{_id:'pubmatic-fixture_renderer',bootstrap:function(config,element){
    var bid=window.__bids.find(function(b){return b.adUnitCode===config.code;});
    window.__played.push({code:config.code,hasVast:!!(config.vastXml||config.vastUrl),elementId:element&&element.id,
      bidSize:[bid.width,bid.height],playerSize:[bid.playerWidth,bid.playerHeight]});
   }}]};"""
   if scenario in ['delayed-render-resize','delayed-consent']:pending.append((r,script))
   else:r.fulfill(status=200,content_type='application/javascript',body=script)
  elif 'cdn.jsdelivr.net/gh/prebid/currency-file' in url:
   r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'dataAsOf':'2026-10-14','conversions':{'USD':{'USD':1,'EUR':0.9},'EUR':{'USD':1.111111,'EUR':1}}}))
  else:unknown.append(url);r.abort()
 page.route('**/*',route)
 try:
  page.goto('https://responsive-outstream.test/')
  if scenario=='no-refresh':page.clock.install(time=datetime(2026,10,14,1,0,0,tzinfo=timezone.utc))
  page.add_script_tag(content=(root/'tests/runtime/mock-ad-libraries.js').read_text())
  page.evaluate('delete window.pbjs');page.add_script_tag(content=pbsource)
  page.evaluate('''scenario=>{
   window.__played=[];window.__bids=[];window.__requests=[];window.__cmpListeners=[];
   window.__tcfapi=(cmd,version,cb)=>{if(cmd==='addEventListener'){__cmpListeners.push(cb);if(!scenario.startsWith('consent-'))cb({gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'},true);}};
   window.__consent=()=>__cmpListeners.forEach(cb=>cb({gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'},true));
   window.__changeConsent=()=>__cmpListeners.forEach(cb=>cb({gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown'},true));
   if(scenario==='page-type')window.adsKeywords={pageType:'article'};
   pbjs.onEvent('bidRequested',r=>__requests.push(r.bids.map(b=>({code:b.adUnitCode,mediaTypes:b.mediaTypes}))));
   pbjs.onEvent('bidResponse',b=>__bids.push(b));
   __testAds.service.addEventListener('slotRenderEnded',()=>window.__done=true);
  }''',scenario)
  generated=out/name;page.add_script_tag(content=generated.read_text())
  if scenario in ['consent-resize','consent-disabled','lazy-resize']:
   page.wait_for_timeout(150);assert not requests,'Auction ran before consent/lazy entry'
   page.set_viewport_size({'width':1920 if scenario=='consent-disabled' else 1440,'height':900})
   if scenario=='lazy-resize':page.evaluate('document.getElementById("Billboard").scrollIntoView()')
   else:page.evaluate('__consent()')
  if scenario in ['disabled','consent-disabled']:
   page.wait_for_timeout(900)
   assert not requests,'Disabled breakpoint sent a native auction'
   assert page.evaluate('__testAds.observations.requests.length')==0,'Disabled breakpoint sent a GAM request'
   expected=None
  else:
   if scenario=='no-refresh':
    for _ in range(180):
     page.clock.run_for(20);page.wait_for_timeout(10)
     if page.evaluate('window.__done===true&&window.__bids.length>0'):break
   page.wait_for_function('window.__done===true&&window.__bids.length>0',timeout=15000)
   expected=[800,450] if scenario=='page-type' else [640,360] if scenario in ['desktop','consent-resize','lazy-resize'] else [300,250]
   assert len(requests)==1,requests
   video=requests[0]['imp'][0]['video'];assert [video['w'],video['h']]==expected,(scenario,video)
   assert page.evaluate('__requests[0][0].mediaTypes.video.playerSize')==[expected],'Actual native bidder input has wrong playerSize'
   assert page.evaluate('[__bids[0].width,__bids[0].height]')==expected,'Native bid size differs from map choice'
   assert page.evaluate('[__bids[0].playerWidth,__bids[0].playerHeight]')==expected,'Native player dimensions differ from request'
   if name.startswith('responsive-only'):assert 'banner' not in requests[0]['imp'][0]
   else:
    banner=requests[0]['imp'][0]['banner'];native={(item['w'],item['h']) for item in banner.get('format',[])}
    if banner.get('w') and banner.get('h'):native.add((banner['w'],banner['h']))
    wanted={(800,450)} if scenario=='page-type' else {(728,90),(640,360),(800,450)} if expected==[640,360] else {(300,250)}
    assert native==wanted,('Banner dimensions changed',native,wanted)
   assert page.evaluate('__played.length')==0,'Native renderer ran before creative selection'
   assert page.evaluate('adSlots.Billboard.getTargetingKeys().some(k=>k.startsWith("hb_adid")&&adSlots.Billboard.getTargeting(k).includes(__bids[0].adId))'),'Native returned ID not targeted to GAM'
   if scenario=='changed-consent':page.evaluate('__changeConsent()')
   if scenario=='expired':page.evaluate('Date.now=()=>Number.MAX_SAFE_INTEGER')
   if scenario=='pending-resize':page.set_viewport_size({'width':1440,'height':900})
   frame=page.query_selector('#creative').content_frame();frame.add_script_tag(content=puc)
   frame.evaluate('id=>ucTag.renderAd(document,{adId:id})',page.evaluate('__bids[0].adId'))
   if scenario in ['delayed-render-resize','delayed-consent']:
    page.wait_for_function('document.querySelector("script[src*=\\"pubmatic.bbvms.com\\"]")!==null')
    if scenario=='delayed-consent':page.evaluate('__changeConsent()')
    else:page.set_viewport_size({'width':1440,'height':900})
    for r,script in pending:r.fulfill(status=200,content_type='application/javascript',body=script)
    pending.clear()
   if scenario in ['pending-resize','delayed-render-resize','changed-consent','delayed-consent','expired']:
    page.wait_for_timeout(200);assert page.evaluate('__played.length')==0,'Old-size video rendered after the map choice changed'
   else:
    page.wait_for_function('__played.length===1')
    played=page.evaluate('__played[0]');assert played['bidSize']==expected and played['playerSize']==expected
    assert played['code']=='Billboard' and played['hasVast'] and played['elementId'],'Native renderer did not receive its creative target'
    frame.evaluate('id=>ucTag.renderAd(document,{adId:id})',page.evaluate('__bids[0].adId'))
    page.wait_for_timeout(60);assert page.evaluate('__played.length')==1,'Duplicate native video rendered'
  if scenario=='no-refresh':
   page.clock.run_for(120000);page.wait_for_timeout(50)
   assert len(requests)==1 and page.evaluate('__testAds.observations.requests.length')==1,'Responsive video position refreshed'
  assert not errors,errors
  assert not unknown,unknown
  return {'file':name,'sha256':hashlib.sha256(generated.read_bytes()).hexdigest(),'scenario':scenario,'videoSize':expected,'nativeAuctions':len(requests),'rendererCalls':page.evaluate('__played.length'),'externalNetwork':0,'passed':True}
 except Exception:
  print('DIAGNOSTIC',name,scenario,errors,unknown,page.evaluate('({bids:window.__bids?.length,ready:window.__tesseraReadiness?.snapshot(),requests:window.__testAds?.observations.requests})'))
  raise
 finally:
  for r,_ in pending:r.abort()
  page.close()

with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox'])
 try:
  for suffix in ['.js','.min.js']:
   for scenario in ['mobile','desktop','page-type','disabled','consent-resize','consent-disabled','pending-resize','delayed-render-resize','changed-consent','delayed-consent','expired','no-refresh']:
    result=run(browser,'responsive'+suffix,scenario);checks.append(result);print('PASS',result['file'],scenario)
   for scenario in ['mobile','desktop']:
    result=run(browser,'responsive-only'+suffix,scenario);checks.append(result);print('PASS',result['file'],scenario)
   result=run(browser,'responsive-lazy'+suffix,'lazy-resize');checks.append(result);print('PASS',result['file'],'lazy-resize')
 finally:
  browser.close();(out/'native-results.json').write_text(json.dumps({'checks':checks,'limitation':'Pinned native Prebid and PUC with synthetic GPT delivery and vendor bootstrap sink. Actual BlueBillywig layout/lifecycle and live GAM competition still require hosted partner verification.'},indent=2))
