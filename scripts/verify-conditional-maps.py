"""Actual generated readable/minified scripts in Chromium; all network blocked.
Synthetic GPT, Prebid and CMP. Verifies map/request parity, not SSP acceptance.
"""
import json
from pathlib import Path
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/conditional-maps-evidence'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
HOME={'category':'Naslovna','pageType':'home'}
ARTICLE={'category':'Kultura','pageType':'article'}
MOBILE=[[300,250],[250,250],[200,200],[300,100],[300,50],[320,100],[320,50]]
BASE=[[300,600],[300,300],[300,250],[250,250],[160,600],[120,600]]
HOME_SIZES=[[300,250],[250,250]]
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
 for suffix in ['.js','.min.js']:
  for width in [1440,390]:
   for name,variant,keywords,pending in [
      ('home','prebid',HOME,False),('article','prebid',ARTICLE,False),('missing','prebid',{},False),
      ('gam-home','gam',HOME,False),('disabled','disabled',HOME,False),('sticky','sticky',HOME,False),
      ('lazy','lazy',HOME,False),('empty-breakpoint','empty',HOME,False),('pending-cmp','prebid',HOME,True)]:
    page=browser.new_page(viewport={'width':width,'height':900});errors=[];attempts=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.route('**/*',lambda route: (attempts.append(route.request.url),route.abort()))
    page.set_content('<!doctype html><html><head></head><body style="margin:0;height:2000px"><div id="P2" class="wrapperAd"></div><div id="Sticky" class="wrapperAd"></div></body></html>')
    now=datetime(2026,11,9,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
    page.evaluate('(keywords)=>{window.adsKeywords=keywords;}',keywords)
    page.add_style_tag(content=(out/(variant+'.css')).read_text())
    page.add_script_tag(content=mock)
    if pending:
     page.evaluate('''()=>{window.__tcfapi=(cmd,v,cb)=>{if(cmd==='addEventListener'||cmd==='getTCData')cb({gdprApplies:true,eventStatus:'cmpuishown',cmpStatus:'loaded',listenerId:1},true);};}''')
    page.add_script_tag(content=(out/(variant+suffix)).read_text())
    page.clock.run_for(15000)
    data=page.evaluate('''()=>({slots:__testAds.slots.map(s=>({id:s.id,map:s.mapping})),requests:__testAds.observations.requests,
      bids:__testAds.observations.bids.flatMap(r=>r.adUnits||[]).map(u=>({id:u.code,sizes:u.mediaTypes?.banner?.sizes})),
      height:getComputedStyle(document.getElementById('P2')).minHeight,tag:document.getElementById('P2').getAttribute('data-ad-rule-map')})''')
    expected=HOME_SIZES if width>=768 and keywords==HOME else BASE if width>=768 else MOBILE
    if variant=='empty':expected=[[300,250]] if width>=768 else []
    disabled=variant=='disabled'
    slots=[s for s in data['slots'] if s['id']=='P2']
    assert not errors,(name,width,suffix,errors)
    assert not attempts,(name,width,suffix,attempts)
    if disabled:
     assert not slots and not data['requests'] and not data['bids'],(name,width,suffix,data)
     assert data['height']=='0px',data
    else:
     assert len(slots)==1,(name,width,suffix,data)
     row=next(r for r in sorted(slots[0]['map'],key=lambda r:r['viewport'][0],reverse=True) if width>=r['viewport'][0])
     assert row['sizes']==expected,(name,width,suffix,row,expected)
     if pending or not expected:
      assert not data['requests'] and not data['bids'],(name,width,suffix,data)
     else:
      assert any(r['id']=='P2' for r in data['requests']),(name,width,suffix,data)
      if variant!='gam':
       bids=[b for b in data['bids'] if b['id']=='P2'];assert bids,(name,width,suffix,data)
       assert all(b['sizes']==expected for b in bids),(name,width,suffix,bids,expected)
      assert data['height']==str(max(s[1] for s in expected))+'px',(name,width,suffix,data)
     # Keyword changes after definition cannot change the Prebid map behind GPT.
     page.evaluate('window.adsKeywords={category:"Other",pageType:"article"}')
     page.clock.run_for(1000)
     assert page.evaluate('document.getElementById("P2").getAttribute("data-ad-rule-map")')==data['tag']
    if variant=='sticky':
     sticky=[s for s in data['slots'] if s['id']=='Sticky'];assert len(sticky)==1,data
     sticky_bids=[b for b in data['bids'] if b['id']=='Sticky'];assert sticky_bids,data
     assert all(b['sizes']==expected for b in sticky_bids),data
    results.append({'scenario':name,'width':width,'source':suffix,'passed':True,'gptRequests':len(data['requests']),'prebidUnits':len(data['bids'])})
    if name=='home':page.screenshot(path=str(out/f'home-{width}-{suffix[1:]}.png'))
    page.close()
 browser.close()
(out/'browser-results.json').write_text(json.dumps({'scope':'Full generated scripts with synthetic ad libraries; all network blocked','results':results},indent=2))
print(f'{len(results)}/{len(results)} browser cases passed; zero outbound requests.')
