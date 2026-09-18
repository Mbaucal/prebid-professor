"""CI only: real packaged scripts/Prebid, synthetic GPT/TCF, loopback with external traffic blocked."""
import json, pathlib, threading, time, urllib.parse, os
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright

root=pathlib.Path(os.environ.get('TANJUG_PACKAGE_DIR','.generated/tanjug-aa/deploy')); manifest=json.loads((root/'release.json').read_text())
readiness=manifest.get('kind')=='static-aa-readiness-observer'
config=manifest['config']; checks=[]; page_errors=[]; blocked=set()
mock=pathlib.Path('tests/runtime/mock-ad-libraries.js').read_text()
# Keep synthetic GPT and TCF. Prebid always comes from the actual shipped file.
a=mock.index('  window.pbjs = {');b=mock.index('  window.__tcfapi =',a)
mock=mock[:a]+mock[b:]
mock=mock.replace('const observations = { requests:', 'const observations = { requests:')
mock=mock.replace('sizes: slot.sizes, at: Date.now()', 'sizes: slot.sizes, Variant: slot.getConfig().targeting.Variant, at: Date.now()')
if readiness:mock+='\n'+pathlib.Path('tests/runtime/readiness-browser-fixture.js').read_text()
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  path=urllib.parse.urlsplit(self.path).path; query=urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
  data=None;typ='application/javascript'
  if path=='/fixture':
   case=query.get('case',['normal'])[0]
   positions=''.join('<section style="min-height:350px"><div class="wrapperAd lazyAd" id="'+p+'"></div></section>' for p in config['positions'] if p!='Sticky')
   tags='<script nonce="fixture" src="/ads.js" async></script>'
   if case=='duplicate':tags+=tags
   if case not in ['auto','tampered']:
    tags+='<script nonce="fixture" src="/prebid.js?case='+case+'" async></script>'
   data=('<!doctype html><meta charset="utf-8"><title>A/A fixture</title><link rel="stylesheet" href="/min-height.css"><script nonce="fixture" src="/mock.js"></script>'+tags+'<body>'+positions+'</body>').encode();typ='text/html'
  elif path=='/mock.js':data=mock.encode()
  elif path=='/prebid.js' and query.get('case')==['delayed']:
   time.sleep(2);data=(root/'prebid.js').read_bytes()
  elif path=='/prebid.js' and query.get('case')==['wrong']:
   data=b'window.pbjs={version:"10.10.0"};'
  elif path=='/prebid.js' and query.get('case')==['failed']:
   time.sleep(.5)  # Let the loader attach to the parser-created async tag.
   self.send_error(404);return
  else:
   candidate=root/path.lstrip('/')
   if candidate.is_file() and root.resolve() in candidate.resolve().parents:
    data=candidate.read_bytes()
    if path.endswith('.css'):typ='text/css'
  if data is None:self.send_error(404);return
  self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Access-Control-Allow-Origin','*')
  self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)))
  if path=='/fixture':self.send_header('Content-Security-Policy',"script-src 'nonce-fixture' 'strict-dynamic'; object-src 'none'; base-uri 'none'")
  self.end_headers();self.wfile.write(data)

def check(name,ok):
 assert ok,name
 checks.append({'name':name,'passed':True});print('PASS '+name,flush=True)

def wait(page,expression,timeout=30000):
 deadline=time.monotonic()+timeout/1000
 while time.monotonic()<deadline:
  if page.evaluate(expression):return
  time.sleep(.05)
 print(json.dumps({'waitingFor':expression,'state':page.evaluate('window.AdVariant?.snapshot()'),'pageErrors':errors}),flush=True)
 raise AssertionError('Timed out: '+expression)

server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
origin='http://127.0.0.1:'+str(server.server_port)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,args=['--no-proxy-server','--disable-quic','--host-resolver-rules=EXCLUDE 127.0.0.1, MAP * ~NOTFOUND'])
  try:
   for arm,width,case in [('A',1280,'normal'),('B',390,'normal'),('A',1280,'delayed'),('B',1280,'auto'),('A',1280,'duplicate'),('A',1280,'wrong'),('A',1280,'failed'),('A',1280,'tampered')]:
    context=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
    # Force the loader's one-word allocation draw only. Native Prebid UUID/bid-ID
    # entropy must remain intact or different ad units can acquire the same ID.
    context.add_init_script("{const original=Crypto.prototype.getRandomValues;let assigned=false;Crypto.prototype.getRandomValues=function(a){if(!assigned && a instanceof Uint32Array && a.length===1){assigned=true;a[0]="+('0' if arm=='A' else '4294967295')+";return a;}return original.call(this,a);};}")
    def route(r):
     if not r.request.url.startswith(origin+'/'):
      blocked.add(urllib.parse.urlsplit(r.request.url).hostname)
      if readiness and r.request.url.startswith('https://readiness-fixture.invalid/bid?'):
       rows=json.loads(urllib.parse.parse_qs(urllib.parse.urlsplit(r.request.url).query)['payload'][0])
       rows=[{**x,'creativeId':'synthetic','currency':'EUR','netRevenue':True,'ad':'<div>Synthetic readiness test</div>','meta':{'advertiserDomains':['example.invalid']}} for x in rows]
       r.fulfill(status=200,headers={'content-type':'application/json','access-control-allow-origin':origin},body=json.dumps({'bids':rows}));return
      if r.request.resource_type in ['fetch','xhr']:
       # Native user-ID modules receive an empty synthetic result, not a rejected
       # fetch Promise. No user IDs, bids, or real network response are supplied.
       body={'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'USD':1,'EUR':1}}} if r.request.url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json') else {}
       r.fulfill(status=200,headers={'content-type':'application/json','access-control-allow-origin':origin,'access-control-allow-credentials':'true'},body=json.dumps(body))
      else:r.abort()
      return
     if case=='tampered' and r.request.url.endswith('/A.js'):
      r.fulfill(status=200,headers={'content-type':'application/javascript','access-control-allow-origin':'*'},body='window.BAD_ARM_RAN=true;');return
     r.continue_()
    context.route('**/*',route);page=context.new_page();errors=[];requested=[]
    def page_error(e):
     errors.append(str(e));print(json.dumps({'case':case,'arm':arm,'pageError':str(e),'stack':e.stack}),flush=True)
    page.on('pageerror',page_error)
    page.on('request',lambda r:requested.append(urllib.parse.urlsplit(r.url).path) if r.url.startswith(origin+'/') else None)
    page.goto(origin+'/fixture?case='+case)
    if case in ['wrong','failed','tampered']:
     wait(page,"window.AdVariant?.snapshot().status==='error'",timeout=35000)
     state=page.evaluate('AdVariant.snapshot()')
     check(case+': no runtime/auction after dependency or integrity failure',state['runtimeEntries']==0 and not page.evaluate('Boolean(window.BAD_ARM_RAN)'))
     # An already-failed async HTML tag cannot replay its error event. The frozen
     # loader then reaches its bounded dependency timeout; neither path enters an arm.
     expected={'wrong':['prebid-version-mismatch'],'failed':['prebid-load-error','prebid-timeout'],'tampered':['arm-load-error']}
     check(case+': specific diagnostic',state['error'] in expected[case])
    else:
     wait(page,"window.AdVariant?.snapshot().status==='loaded' && window.AdVariant.snapshot().appliedSlots===19",timeout=35000)
     state=page.evaluate('AdVariant.snapshot()')
     label=arm+' '+str(width)+' '+case
     check(label+': exact packaged runtime once with native Prebid',state['runtimeEntries']==1 and state['variant']==arm and state['prebidVersion']=='11.34.0')
     check(label+': all 19 positions labeled before requests',len(state['slots'])==19 and all(s['Variant']==arm for s in state['slots']))
     arm_paths=[x for x in requested if x.endswith('/A.js') or x.endswith('/B.js')]
     check(label+': only selected arm fetched',arm_paths==['/'+config['arms'][arm]['path']])
     check(label+': one Prebid fetch',len([x for x in requested if x.endswith('/prebid.js')])==1)
     check(label+': fluid and 1x1 retained',page.evaluate("adSlots.InText_1.sizes.some(s=>s==='fluid') && adSlots.InText_1.sizes.some(s=>Array.isArray(s)&&s[0]===1&&s[1]===1)"))
     wait(page,'__testAds.observations.requests.length>0',timeout=15000)
     check(label+': every first request carries Variant',page.evaluate('__testAds.observations.requests.every(r=>r.Variant==='+json.dumps(arm)+')'))
     if readiness:
      wait(page,"window.AdBidReadiness?.snapshot().rows.find(r=>r.position==='Billboard')?.counters.received>=2",timeout=15000)
      check(label+': full-slot readiness observer initialized',page.evaluate('AdBidReadiness.snapshot().rows.length===19 && AdBidReadiness.snapshot().rows.every(r=>r.registered)'))
      check(label+': actual native losing bid passes screening and targeted winner is excluded',page.evaluate("(() => {const r=AdBidReadiness.snapshot().rows.find(r=>r.position==='Billboard');return r.candidates===1 && r.counters.submitted===1 && r.rejected['already-used']===1;})()"))
      check(label+': inspection leaves native bids/config and GAM requests unchanged',page.evaluate("(() => {const read=()=>JSON.stringify([pbjs.getBidResponsesForAdUnitCode('Billboard'),pbjs.getConfig(),__testAds.observations.requests]);const before=read();AdBidReadiness.inspect();AdVariant.inspect();return before===read();})()"))
      check(label+': cache and refresh remain unchanged',page.evaluate("AdBidReadiness.snapshot().cacheEnabled===false && AdBidReadiness.snapshot().mode==='observe-only' && AdVariant.snapshot().bidReadiness.nativeSelectionVerified===false"))
     page.locator('#InText_1').scroll_into_view_if_needed()
     wait(page,"__testAds.observations.requests.some(r=>r.id==='InText_1')",timeout=15000)
     check(label+': lazy request carries Variant',page.evaluate("__testAds.observations.requests.filter(r=>r.id==='InText_1').every(r=>r.Variant==="+json.dumps(arm)+')'))
     page.evaluate('__testAds.service.refresh(Object.values(adSlots))')
     check(label+': refresh keeps labels on all slots',page.evaluate('__testAds.observations.requests.every(r=>r.Variant==='+json.dumps(arm)+')'))
     if case=='duplicate':check('duplicate HTML loader blocked',state['blockedDuplicateLoaders']==1)
     page.evaluate("() => {const s=document.createElement('script');s.src='/ads.js';s.nonce='fixture';document.head.append(s);}")
     wait(page,'AdVariant.snapshot().blockedDuplicateLoaders>='+str(2 if case=='duplicate' else 1))
     check(label+': reinsertion does not switch or launch another arm',page.evaluate('AdVariant.snapshot().runtimeEntries===1 && AdVariant.snapshot().variant==='+json.dumps(arm)))
     page.evaluate("() => {const s=document.createElement('script');s.src=AdVariant.snapshot().script;s.nonce='fixture';document.head.append(s);}")
     wait(page,'AdVariant.snapshot().blockedRuntimeEntries===1')
     check(label+': direct duplicate arm execution blocked',page.evaluate('AdVariant.snapshot().runtimeEntries===1'))
     check(label+': debugger agrees with actual slot targeting',page.evaluate('JSON.stringify(AdVariant.inspect().slots)===JSON.stringify(AdVariant.snapshot().slots)'))
     page_errors.extend({'case':label,'error':e} for e in errors)
    context.close()
   check('No unhandled JavaScript error in any successful delivery case',not page_errors)
  finally:browser.close()
finally:server.shutdown()
report={'scope':'CI loopback Chromium; shipped ZIP scripts + native Prebid, synthetic GPT/TCF; external attempts blocked, no live auction',
 'checks':checks,'passed':len(checks),'failed':0,'pageErrors':page_errors,'blockedExternalHosts':sorted(x for x in blocked if x)}
(root.parent/'browser-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'passed':len(checks),'failed':0}),flush=True)
