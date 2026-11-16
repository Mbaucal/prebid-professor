"""Full 3.19 output, intercepted GEO and synthetic GPT/Prebid. No paid traffic."""
import json
from pathlib import Path
from datetime import datetime,timedelta,timezone
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent;out=root/'.generated/country-rules-evidence'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text();results=[]
setup=r'''({country,cmp,takeover})=>{
 window.adsKeywords={category:'Naslovna',geo_country:'US'};
 window.__testOptions={takeoverResult:takeover};
 window.__geoTest={calls:0,resolve:null,targeting:{geo_country:['GB']},wire:[],cmpListeners:[]};
 window.fetch=()=>{__geoTest.calls++;return new Promise(resolve=>__geoTest.resolve=()=>resolve(new Response(JSON.stringify({version:1,status:country==='unknown'?'unknown':'known',country:country==='unknown'?null:country,source:'cloudflare'}),{headers:{'content-type':'application/json'}})));};
}'''
observe=r'''()=>({requests:__testAds.observations.requests,bids:__testAds.observations.bids.flatMap(b=>b.adUnits||[]),wire:__geoTest.wire,calls:__geoTest.calls,targeting:__geoTest.targeting,tags:Object.fromEntries(['P2','P3','P4'].map(id=>[id,document.getElementById(id)?.getAttribute('data-ad-rule-map')])),slots:__testAds.slots.map(s=>({id:s.id,mapping:s.mapping})),htmlBlock:document.documentElement.getAttribute('data-google-interstitial')})'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
 for suffix in ['.js','.min.js']:
  for width in [1440,390]:
   cases=[(mode,c,'ready','empty') for mode in ['gam','prebid'] for c in ['RS','DE','unknown','timeout']]
   cases += [('fallback',c,cmp,result) for c,cmp,result in [('RS','ready','empty'),('DE','ready','empty'),('unknown','ready','empty'),('timeout','ready','empty'),('RS','pending','empty'),('RS','ready','filled')]]
   cases += [('sticky','RS','ready','empty'),('sticky','DE','ready','empty'),('lazy','DE','ready','empty'),('prebid','RS','pending','empty')]
   for mode,country,cmp,result in cases:
    page=browser.new_page(viewport={'width':width,'height':900});errors=[];external=[]
    page.on('pageerror',lambda e:errors.append(str(e)));page.route('**/*',lambda r:(external.append(r.request.url),r.abort()))
    page.set_content('<html><body style="margin:0;height:3000px">'+''.join('<div class="wrapperAd" id="'+c+'" style="min-height:10px"></div>' for c in ['P1','P2','P3','P4','Billboard'])+'</body></html>')
    now=datetime(2026,11,9,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
    page.evaluate(setup,{'country':country,'cmp':cmp,'takeover':result});page.add_script_tag(content=mock)
    page.evaluate(r'''(pending)=>{
     googletag.setConfig=c=>Object.entries(c.targeting||{}).forEach(([k,v])=>{if(v===null)delete __geoTest.targeting[k];else __geoTest.targeting[k]=v;});
     __testAds.service.setTargeting=(k,v)=>__geoTest.targeting[k]=v;
     __testAds.service.clearTargeting=k=>delete __geoTest.targeting[k];
     __testAds.service.getTargeting=k=>[].concat(__geoTest.targeting[k]||[]);
     const refresh=__testAds.service.refresh;
     __testAds.service.refresh=function(list,options){for(const slot of list||[])__geoTest.wire.push({id:slot.id,targeting:{...__geoTest.targeting},at:Date.now()});return refresh.call(this,list,options);};
     if(pending)window.__tcfapi=(cmd,v,cb)=>{if(cmd==='addEventListener'||cmd==='getTCData'){__geoTest.cmpListeners.push(cb);cb({gdprApplies:true,eventStatus:'cmpuishown',cmpStatus:'loaded',listenerId:1},true);}else cb(true);};
    }''',cmp=='pending')
    page.add_script_tag(content=(out/(mode+suffix)).read_text());page.wait_for_timeout(40);page.clock.run_for(600)
    before=page.evaluate(observe)
    if cmp=='pending':assert not before['requests'] and not before['bids'],before
    else:
     assert before['requests'],('unrestricted positions waited',mode,country,before)
     if mode!='fallback':assert all(r['id'] not in ['P2','P3'] for r in before['requests']),before
     assert not any(r['id']=='interstitial-guard' for r in before['requests']),before
    assert all('geo_country' not in r['targeting'] for r in before['wire']),before
    if country!='timeout':page.evaluate('__geoTest.resolve()')
    page.clock.run_for(1200);page.wait_for_timeout(60);page.clock.run_for(50);after=page.evaluate(observe)
    expected=country if country in ['RS','DE'] else None
    assert after['targeting'].get('geo_country')==expected,(mode,country,after)
    if cmp=='pending':
     assert not after['requests'] and not after['bids'],after
     page.evaluate("__geoTest.cmpListeners.forEach(cb=>cb({gdprApplies:false,eventStatus:'tcloaded',cmpStatus:'loaded',listenerId:1},true))");page.clock.run_for(1200);page.wait_for_timeout(60);page.clock.run_for(50);after=page.evaluate(observe)
    if country=='timeout':
     page.evaluate('__geoTest.resolve()');page.clock.run_for(100);assert page.evaluate(observe)['targeting'].get('geo_country') is None
    if mode=='fallback':
     fallback=[r for r in after['requests'] if r['id']=='interstitial-guard']
     assert len(fallback)==(1 if expected=='RS' and result=='empty' else 0),(mode,country,cmp,result,after)
     if expected!='RS' or result=='filled':assert after['htmlBlock']=='false',after
    else:
     ids=[r['id'] for r in after['requests']];assert 'P2' in ids,(mode,country,after)
     assert ('P3' in ids)==(expected=='RS'),after
     assert after['tags']['P2']==('1' if expected=='DE' else '0'),after
     assert after['tags']['P4']=='1',after
     p2=[b for b in after['bids'] if b['code']=='P2']
     if mode=='prebid':
      sizes=[[300,250],[250,250]] if expected=='DE' and width>=768 else [[300,600],[300,300],[300,250],[250,250],[160,600],[120,600]] if width>=768 else [[300,250],[250,250],[200,200],[300,100],[300,50],[320,100],[320,50]]
      assert p2 and all(b['mediaTypes']['banner']['sizes']==sizes for b in p2),(mode,country,p2)
     # Country completion itself must not refresh unaffected positions.
     if cmp=='ready':assert sum(r['id']=='P1' for r in after['requests'])==sum(r['id']=='P1' for r in before['requests']),after
     page.evaluate('window.scrollTo(0,600)');page.clock.run_for(100)
     if mode=='sticky':assert any(r['id']=='Sticky' for r in page.evaluate(observe)['requests'])==(expected=='RS')
     page.clock.run_for(65000);later=page.evaluate(observe)
     assert later['calls']==1,later
     assert later['tags']==after['tags'],later
     assert not any(r['id']=='P3' for r in later['requests']) if expected!='RS' else True
     for r in later['wire']:
      assert r['targeting'].get('geo_country') in [None,expected],r
    assert after['calls']==1;assert not errors,(mode,country,errors);assert not external,external
    results.append({'mode':mode,'country':country,'consent':cmp,'takeover':result,'width':width,'source':suffix,'pass':True})
    page.close()
 browser.close()
(out/'browser-results.json').write_text(json.dumps(results,indent=2));print(f'{len(results)}/{len(results)} full-script country rules/targeting/consent/fallback checks passed.')
