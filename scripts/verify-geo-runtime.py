"""Full generated runtime with synthetic ad libraries; all outbound traffic blocked."""
import json
from pathlib import Path
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/geo-runtime-evidence'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
scenarios=['RS','DE','unknown','timeout','body-timeout','http-error','invalid-json','network-error','unsupported','existing','pending-cmp']
results=[]
setup=r'''(scenario)=>{
 window.adsKeywords={category:'Naslovna',pageType:'home'};
 window.__countryTest={calls:[],resolve:null};
 if(scenario==='existing'){Object.defineProperty(window,'__AD_GEO',{value:{owner:'other'},configurable:false});}
 if(scenario==='unsupported'){window.fetch=undefined;return;}
 window.fetch=function(url,init){
   __countryTest.calls.push({url,credentials:init.credentials,cache:init.cache,redirect:init.redirect,referrerPolicy:init.referrerPolicy});
   if(scenario==='network-error')return Promise.reject(new Error('fixture network failure'));
   if(scenario==='http-error')return Promise.resolve(new Response('{}',{status:503,headers:{'content-type':'application/json'}}));
   if(scenario==='invalid-json')return Promise.resolve(new Response('broken',{headers:{'content-type':'application/json'}}));
   if(scenario==='body-timeout')return Promise.resolve({ok:true,headers:new Headers({'content-type':'application/json'}),text:()=>new Promise(resolve=>{__countryTest.resolve=()=>resolve(JSON.stringify({version:1,status:'known',country:'DE',source:'cloudflare'}));})});
   return new Promise(resolve=>{__countryTest.resolve=()=>resolve(new Response(JSON.stringify({version:1,status:scenario==='unknown'?'unknown':'known',country:scenario==='unknown'?null:scenario==='RS'?'RS':'DE',source:'cloudflare'}),{headers:{'content-type':'application/json'}}));});
 };
}'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
 for suffix in ['.js','.min.js']:
  for width in [1440,390]:
   for variant in ['prebid','gam']:
    for scenario in scenarios:
     page=browser.new_page(viewport={'width':width,'height':900});errors=[];outbound=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.route('**/*',lambda r:(outbound.append(r.request.url),r.abort()))
     page.set_content('<html><body style="margin:0;height:1800px"><div id="P2" class="wrapperAd"></div></body></html>')
     now=datetime(2026,11,9,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
     page.add_script_tag(content=mock);page.evaluate(setup,scenario)
     if scenario=='pending-cmp':page.evaluate("window.__tcfapi=(cmd,v,cb)=>{if(cmd==='addEventListener'||cmd==='getTCData')cb({gdprApplies:true,eventStatus:'cmpuishown',cmpStatus:'loaded',listenerId:1},true)}")
     page.add_script_tag(content=(out/(variant+suffix)).read_text())
     page.clock.run_for(1000)
     initial=page.evaluate('''()=>({requests:__testAds.observations.requests.length,bids:__testAds.observations.bids.flatMap(r=>r.adUnits||[]),snapshot:__AD_GEO.getSnapshot?.(),calls:__countryTest.calls})''')
     if scenario=='pending-cmp':assert initial['requests']==0 and not initial['bids'],initial
     else:assert initial['requests']>0,('Ads waited for GEO',scenario,variant,width,suffix,initial)
     if scenario in ['RS','DE','unknown','timeout','body-timeout','pending-cmp']:assert initial['snapshot']['status']=='pending',initial
     if scenario not in ['timeout','body-timeout','unsupported','existing','http-error','invalid-json','network-error']:page.evaluate('__countryTest.resolve()')
     page.clock.run_for(1000)
     if scenario=='existing':assert page.evaluate('__AD_GEO.owner')=='other'
     else:
      state=page.evaluate('()=>__AD_GEO.getSnapshot()');assert state['status']!='pending',state
      expected=scenario if scenario in ['RS','DE'] else 'DE' if scenario=='pending-cmp' else None
      assert state['country']==expected,(scenario,state)
      if scenario in ['timeout','body-timeout']:
       assert state['reason']=='timeout',state
       page.evaluate('__countryTest.resolve()');page.clock.run_for(100)
       assert page.evaluate('__AD_GEO.getSnapshot()')==state,'Late success replaced terminal unknown'
      assert page.evaluate('()=>__AD_GEO.ready()===__AD_GEO.ready()'),'Consumers need one shared result'
     page.clock.run_for(65000)
     after=page.evaluate('''()=>({requests:__testAds.observations.requests,bids:__testAds.observations.bids.flatMap(r=>r.adUnits||[]),calls:__countryTest.calls,tag:document.getElementById('P2').getAttribute('data-ad-rule-map')})''')
     if scenario=='pending-cmp':assert not after['requests'] and not after['bids'],after
     else:
      assert len(after['requests'])>initial['requests'],('Refresh did not continue',scenario,after)
      assert after['tag']=='1',after
      expected_sizes=[[300,250],[250,250]] if width>=768 else [[300,250],[250,250],[200,200],[300,100],[300,50],[320,100],[320,50]]
      if variant=='prebid':assert after['bids'] and all(b['mediaTypes']['banner']['sizes']==expected_sizes for b in after['bids']),after
     assert len(after['calls'])==(0 if scenario in ['unsupported','existing'] else 1),(scenario,after)
     if after['calls']:assert after['calls'][0]=={'url':'https://prebid-professor-test.mbaucal.workers.dev/geo/v1/country','credentials':'omit','cache':'no-store','redirect':'error','referrerPolicy':'no-referrer'},after
     assert not errors,(scenario,errors)
     assert not outbound,outbound
     results.append({'scenario':scenario,'mode':variant,'width':width,'source':suffix,'passed':True,'countryCalls':len(after['calls']),'initialAdRequests':initial['requests'],'adRequestsAfterRefresh':len(after['requests'])})
     page.close()
 browser.close()
(out/'browser-results.json').write_text(json.dumps({'scope':'Synthetic GEO/GPT/Prebid/CMP; all external network blocked','results':results},indent=2))
print(f'{len(results)}/{len(results)} full-script country/map/consent/refresh scenarios passed.')
