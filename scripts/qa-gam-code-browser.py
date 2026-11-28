"""Actual generated packages; synthetic GPT/Prebid/CMP/GEO; block all network."""
import csv
import io
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
out=Path(sys.argv[2] if len(sys.argv)>2 else '.generated/qa-gam-codes').resolve()
cases=[case for case in json.loads((out/'cases.json').read_text()) if case['pass']]
assert cases, 'No generated packages to test'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
 for case in cases:
  for width in [1440,390]:
   for name in ['ads.js','ads.min.js']:
    context=browser.new_context(viewport={'width':width,'height':900})
    page=context.new_page();errors=[];external=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',lambda route:(external.append(route.request.url),route.abort()))
    try:
     pkg=out/case['name'];html=(pkg/'implementation.html').read_text()
     # Execute exact exported containers; omit only external library/script tags.
     html=re.sub(r'<script\b[^>]*>[\s\S]*?</script\s*>','',html,flags=re.I)
     html=re.sub(r'<link\b[^>]*>','',html,flags=re.I)
     page.set_content(html)
     page.evaluate('''()=>{document.body.style.minHeight='3000px';window.adsKeywords={category:'Naslovna'};
      window.fetch=()=>Promise.resolve(new Response(JSON.stringify({version:1,status:'known',country:'RS',source:'cloudflare'}),{headers:{'content-type':'application/json'}}));}''')
     now=datetime(2026,11,9,23,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
     page.add_style_tag(content=(pkg/'min-height.css').read_text())
     page.add_script_tag(content=mock)
     if case['kind']=='lazy':
      page.evaluate('''()=>{window.__codeIntersections=[];const Native=window.IntersectionObserver;
       window.IntersectionObserver=class extends Native{constructor(callback,options){super((entries,observer)=>{
        window.__codeIntersections.push(...entries.map(entry=>({id:entry.target.id,visible:entry.isIntersecting})));callback(entries,observer);
       },options);}};}''')
     page.add_script_tag(content=(pkg/name).read_text())
     if case['kind']=='lazy':
      for turn in range(40):
       page.clock.run_for(100);page.wait_for_timeout(25)
       if page.evaluate('codes=>codes.every(code=>__codeIntersections.some(entry=>entry.id===code&&entry.visible))',case['codes']):break
      assert page.evaluate('codes=>codes.every(code=>__codeIntersections.some(entry=>entry.id===code&&entry.visible))',case['codes']),('Native observer did not discover exact lazy IDs',case['codes'])
     page.clock.run_for(15000);page.evaluate('window.scrollTo(0,600)');page.clock.run_for(1000);page.wait_for_timeout(50);page.clock.run_for(100)
     actual=page.evaluate('''()=>({requests:__testAds.observations.requests,bids:__testAds.observations.bids.flatMap(r=>r.adUnits||[]),
      slots:__testAds.slots.map(s=>({id:s.id,path:s.path})),protos:{object:Object.getPrototypeOf({})===Object.prototype,array:Object.getPrototypeOf([])===Array.prototype},ids:[...document.querySelectorAll('[id]')].map(x=>x.id)})''')
     assert not errors,errors
     assert not external,external
     assert actual['protos']=={'object':True,'array':True},actual['protos']
     for code in case['codes']+([case['overlay']] if case['kind']=='legacy' else []):
      slot=next((slot for slot in actual['slots'] if slot['path']=='/123/test/'+code),None)
      assert slot,('Exact GPT path missing',code,actual['slots'])
      if code!=case.get('overlay'):assert slot['id']==code,('GAM element ID changed',code,slot)
      assert any(request['path']=='/123/test/'+code for request in actual['requests']),('Request missing',code,actual)
      if case['mode']=='prebid' and not (case['kind']=='legacy' and code==case.get('overlay')):
       bid=next((bid for bid in actual['bids'] if bid['code']==code),None)
       assert bid,('Exact Prebid code missing',code,actual['bids'])
       if case['kind']=='banner':assert bid['bids'][0]['params']['siteId']=='exact-'+code,('Exact override lost',code,bid)
      if code!=case.get('overlay'):
       state=page.evaluate('''code=>{const node=document.getElementById(code);return node&&{id:node.id,height:getComputedStyle(node).minHeight,position:getComputedStyle(node).position,extra:node.getAttributeNames().filter(name=>name.startsWith('on'))};}''',code)
       assert state,('Exact container missing',code)
       assert not state['extra'],('Unexpected event attribute',code,state)
       if code!=case.get('sticky'):assert state['height']==('100px' if code==case.get('home') else '250px'),('CSS selector wrong/no position',code,state)
       else:assert state['position']=='fixed',('Sticky CSS mismatch',code,state)
     # Parse exported CSV and its HTML through the browser, not a string-only assertion.
     for row in csv.DictReader(io.StringIO((pkg/'div-export.csv').read_text())):
      code=row['ad_unit'];node=page.evaluate('''html=>{const template=document.createElement('template');template.innerHTML=html;const nodes=template.content.children;return {count:nodes.length,id:nodes[0]?.id,tag:nodes[0]?.tagName,attrs:[...(nodes[0]?.attributes||[])].map(a=>a.name)};}''',row['html'])
      assert node=={'count':1,'id':code,'tag':'DIV','attrs':['id','class']},('CSV HTML did not preserve exact safe container',row,node)
     results.append({'name':case['name'],'width':width,'source':name,'passed':True,'requests':len(actual['requests']),'bids':len(actual['bids'])})
    except Exception as error:
     results.append({'name':case['name'],'width':width,'source':name,'passed':False,'error':str(error),'browserErrors':errors,'external':external})
    finally:context.close()
 browser.close()
report={'scope':'Full emitted package JS/HTML/CSS; synthetic ad libraries; blocked network','results':results}
(out/'browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
raise SystemExit(1 if any(not result['passed'] for result in results) else 0)
