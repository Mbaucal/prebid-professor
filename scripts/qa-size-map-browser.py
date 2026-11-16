"""Independent generated-package audit. Synthetic GPT/Prebid/CMP, no paid traffic.

GPT mapping comparison uses the documented largest-fitting width/height contract;
it is not a live Google wire or SSP acceptance test.
"""
import json,sys
from pathlib import Path
from datetime import datetime,timedelta,timezone
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent
version=sys.argv[1] if len(sys.argv)>1 else '319'
out=root/f'.generated/qa-size-map-{version}'
fixtures=json.loads((out/'cases.json').read_text())
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
results=[]
def expected_sizes(rows,width,height):
    ordered=sorted(rows,key=lambda r:tuple(r.get('viewport',r.get('minViewPort'))),reverse=True)
    return next((r['sizes'] for r in ordered if width>=r.get('viewport',r.get('minViewPort'))[0] and height>=r.get('viewport',r.get('minViewPort'))[1]),[])
def fixed(sizes):return [s for s in sizes if isinstance(s,list)]

with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
 for case in fixtures['cases']:
  if not case['generated']:continue
  for suffix in ['ads.js','ads.min.js']:
   page=browser.new_page(viewport={'width':1440,'height':900});errors=[];outbound=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.route('**/*',lambda r:(outbound.append(r.request.url),r.abort()))
   page.set_content('<!doctype html><html><body style="margin:0;height:1800px"><div id="P2" class="wrapperAd"></div><div id="Sticky" class="wrapperAd"></div></body></html>')
   now=datetime(2026,11,9,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
   page.add_style_tag(content=(out/f"{case['name']}.min-height.css").read_text())
   page.add_script_tag(content=mock)
   page.evaluate('''c=>{
     window.adsKeywords=c.keywords;window.__qaBids=[];window.__qaRequests=[];
     window.fetch=()=>c.country==='timeout'?new Promise(()=>{}):Promise.resolve(new Response(JSON.stringify({version:1,status:c.country==='unknown'?'unknown':'known',country:c.country==='unknown'?null:c.country,source:'cloudflare'}),{headers:{'content-type':'application/json'}}));
     const requests=pbjs.requestBids;pbjs.requestBids=function(input){for(const u of input.adUnits||[])__qaBids.push({id:u.code,sizes:u.mediaTypes?.banner?.sizes,at:Date.now(),width:innerWidth,height:innerHeight});return requests(input);};
     const refresh=__testAds.service.refresh;__testAds.service.refresh=function(list){for(const s of list||[]){const ordered=[...(s.mapping||[])].sort((a,b)=>b.viewport[0]-a.viewport[0]||b.viewport[1]-a.viewport[1]);const row=ordered.find(r=>innerWidth>=r.viewport[0]&&innerHeight>=r.viewport[1]);__qaRequests.push({id:s.id,sizes:row?.sizes||[],at:Date.now(),width:innerWidth,height:innerHeight});}return refresh(list);};
     const mapping=googletag.sizeMapping;googletag.sizeMapping=()=>{const builder=mapping();const build=builder.build;builder.build=()=>build().sort((a,b)=>b.viewport[0]-a.viewport[0]||b.viewport[1]-a.viewport[1]);return builder;};
     if(c.pendingCmp){window.__qaConsentCallbacks=[];window.__tcfapi=(command,version,callback)=>{if(command==='addEventListener'||command==='getTCData'){__qaConsentCallbacks.push(callback);callback({gdprApplies:true,eventStatus:'cmpuishown',cmpStatus:'loaded',listenerId:1},true);}};}
   }''',case)
   page.add_script_tag(content=(out/f"{case['name']}.{suffix}").read_text())
   previous_bids=0;previous_requests=0
   phases=[('initial',1440,900,10000)]
   if case.get('pendingCmp'):phases.append(('pending-resize',1440,1100,10000))
   phases.append(('height-resize',1440,1100,35000))
   if case.get('requireResizeStart'):phases.append(('repeat-resize',1430,1100,500))
   phases.append(('mobile-resize',390,900,35000))
   for phase,width,height,duration in phases:
    if phase!='initial':
     page.set_viewport_size({'width':width,'height':height})
     # Let the browser deliver its native resize event before advancing timers.
     page.wait_for_timeout(50)
    if phase=='height-resize':
     if case.get('pendingCmp'):page.evaluate("__qaConsentCallbacks.forEach(cb=>cb({gdprApplies:false,eventStatus:'tcloaded',cmpStatus:'loaded',listenerId:1},true))")
     if case['name'].startswith('category-'):page.evaluate("window.adsKeywords={category:'Changed after definition'}")
    page.clock.run_for(duration)
    data=page.evaluate('''()=>({bids:__qaBids,requests:__qaRequests,slots:__testAds.slots.map(s=>({id:s.id,map:s.mapping})),css:getComputedStyle(document.getElementById('P2')).minHeight,country:window.__AD_GEO?.getSnapshot?.(),tag:document.getElementById('P2').getAttribute('data-ad-rule-map')})''')
    bids=[x for x in data['bids'][previous_bids:] if x['id']==case['code']]
    requests=[x for x in data['requests'][previous_requests:] if x['id']==case['code']]
    previous_bids=len(data['bids']);previous_requests=len(data['requests'])
    wanted=[] if case.get('disabled') else expected_sizes(case['rows'],width,height)
    pending=case.get('pendingCmp') and phase in ['initial','pending-resize']
    findings=[]
    if errors:findings.append('browser error')
    if outbound:findings.append('outbound request attempted')
    if case.get('disabled') and any(s['id']==case['code'] for s in data['slots']):findings.append('disabled slot defined')
    if any(b.get('sizes',[])!=fixed(wanted) for b in bids):findings.append('Prebid sizes differ from fitting map')
    if any(r['sizes']!=wanted for r in requests):findings.append('GPT map differs from fitting map')
    if not wanted and (bids or requests):findings.append('empty/disabled map requested')
    if pending and (bids or requests):findings.append('request while CMP pending')
    if case.get('closeAfterInitial') and (bids or requests):findings.append('closed Sticky requested')
    if phase=='initial' and not pending and fixed(wanted) and not case.get('disabled') and not bids:findings.append('no initial Prebid request for eligible map')
    if phase=='initial' and not pending and wanted and not case.get('disabled') and not requests:findings.append('no initial GPT request for eligible map')
    if case.get('pendingCmp') and phase=='height-resize' and not requests:findings.append('no request after CMP decision')
    if case.get('requireResizeStart') and phase=='height-resize' and not requests:findings.append('eligible position never starts after resize')
    if case.get('requireResizeStart') and phase=='repeat-resize' and (bids or requests):findings.append('resize forced another request after first dispatch')
    if case['code']=='P2' and data['css']!=f"{max([0]+[s[1] for s in fixed(wanted)])}px":findings.append('reserved CSS height differs from fitting map')
    results.append({'case':case['name'],'source':suffix,'phase':phase,'viewport':[width,height],'expected':wanted,'prebid':bids,'gpt':requests,'css':data['css'],'findings':findings,'errors':errors[:],'outbound':outbound[:]})
    if phase=='initial' and case.get('closeAfterInitial'):page.evaluate("document.getElementById('close_sticky_ad').click()")
   page.close()
 browser.close()
(out/'browser-results.json').write_text(json.dumps({'version':version,'runtimeDescriptor':fixtures.get('runtimeDescriptor'),'commit':fixtures['commit'],'scope':'Generated browser scripts, synthetic ad libraries and country data, all external network blocked','results':results},indent=2))
failed=[r for r in results if r['findings']]
print(json.dumps({'checks':len(results),'findings':len(failed),'results':[{'case':r['case'],'source':r['source'],'phase':r['phase'],'expected':r['expected'],'prebidSizes':[b.get('sizes') for b in r['prebid']],'findings':r['findings']} for r in failed]},indent=2))
if '--require-pass' in sys.argv and failed:raise SystemExit(1)
