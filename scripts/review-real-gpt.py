import json, os, sys, urllib.request
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
out=root/'.generated/real-gpt-review';out.mkdir(exist_ok=True)
results=[]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 for version in ['3.21.0','3.21.2']:
  page=b.new_page(viewport={'width':1440,'height':900}); wire=[]; scripts=[]; logs=[]
  page.on('console',lambda m: logs.append(m.text))
  def route(r):
   u=urlsplit(r.request.url)
   if u.hostname=='gpt-review.invalid':r.fulfill(content_type='text/html',body='<!doctype html><html><body><div id="Billboard"></div><div id="P1"></div><a href="/next">Next</a></body></html>');return
   if u.hostname in ['securepubads.g.doubleclick.net','pagead2.googlesyndication.com'] and (u.path.endswith('/gpt.js') or '/pagead/managed/js/gpt/' in u.path) and '.js' in u.path:
    try:
     data=urllib.request.urlopen(r.request.url,timeout=20).read();scripts.append(r.request.url);r.fulfill(content_type='application/javascript',body=data,headers={'Access-Control-Allow-Origin':'*'});return
    except Exception as e: logs.append(str(e))
   if '/gampad/' in u.path:wire.append({'url':r.request.url,'post':r.request.post_data,'query':parse_qs(u.query)})
   r.abort()
  page.route('**/*',route);page.goto('https://gpt-review.invalid/')
  page.evaluate('''() => {window.googletag={cmd:[]};window.__flow=[];window.__callbacks=[];window.__tcfapi=(c,v,cb)=>{if(c==='ping')cb({gdprApplies:false,cmpLoaded:true,cmpStatus:'loaded'},true);else if(c==='addEventListener')__callbacks.push(cb);else if(c==='getTCData')cb({},false);};window.__emit=()=>__callbacks.forEach(cb=>cb({gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded',tcString:'',listenerId:1},true));window.adsKeywords={category:'Sport'};}''')
  page.add_script_tag(url='https://securepubads.g.doubleclick.net/tag/js/gpt.js')
  page.wait_for_function('window.googletag.apiReady',timeout=30000)
  page.evaluate('''() => {const wrap=(o,n,label)=>{const f=o[n];o[n]=function(...a){__flow.push(label+':'+(typeof a[0]==='string'?a[0]:''));return f.apply(this,a)}};['defineSlot','defineOutOfPageSlot','enableServices','display'].forEach(n=>wrap(googletag,n,n));wrap(googletag.pubads(),'refresh','refresh');}''')
  page.add_script_tag(content=(root/f'.generated/boot3212-browser/{version}-gam-5.js').read_text())
  page.wait_for_timeout(700)
  pending=page.evaluate('''() => ({flow:__flow.slice(),slots:googletag.pubads().getSlots().map(s=>s.getAdUnitPath()),state:takeOverDebug.state()})''')
  if version=='3.21.2':
   assert not any(x.startswith(('enableServices:','display:','refresh:','defineOutOfPageSlot:')) for x in pending['flow']),pending
   assert len(pending['slots'])==2,pending
   assert len(wire)==0,wire
  page.evaluate('window.__emit()');page.wait_for_timeout(1600)
  after=page.evaluate('''() => ({flow:__flow,slots:googletag.pubads().getSlots().map(s=>({path:s.getAdUnitPath(),id:s.getSlotElementId()})),state:takeOverDebug.state(),target:Object.fromEntries(googletag.pubads().getTargetingKeys().map(k=>[k,googletag.pubads().getTargeting(k)])),html:document.documentElement.getAttribute('data-google-interstitial')})''')
  (out/(version+'-raw.json')).write_text(json.dumps({'pending':pending,'after':after,'wire':wire,'logs':logs,'scripts':scripts},indent=2))
  assert any(x.startswith('enableServices:') for x in after['flow']),after
  assert wire,{'after':after,'logs':logs,'scripts':scripts}
  results.append({'version':version,'pending':pending,'after':after,'wire':wire,'logs':logs,'scripts':scripts})
  (out/'result.json').write_text(json.dumps(results,indent=2))
  print(json.dumps({'version':version,'flow':after['flow'],'wire':[{'iu':x['query'].get('iu'),'iu_parts':x['query'].get('iu_parts'),'enc_prev_ius':x['query'].get('enc_prev_ius'),'cust_params':x['query'].get('cust_params')} for x in wire],'guard':after['state'].get('guardStatus'),'scripts':len(scripts)}),flush=True)
  page.close()
 b.close()

