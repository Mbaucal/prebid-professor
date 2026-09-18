"""CI only: real packaged scripts/Prebid, synthetic GPT/TCF, loopback with external traffic blocked."""
import json, pathlib, threading, time, urllib.parse, os
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright

root=pathlib.Path('.generated/tanjug-aa/deploy'); manifest=json.loads((root/'release.json').read_text())
config=manifest['config']; checks=[]; page_errors=[]; blocked=set()
mock=pathlib.Path('tests/runtime/mock-ad-libraries.js').read_text()
# Keep synthetic GPT and TCF. Prebid always comes from the actual shipped file.
a=mock.index('  window.pbjs = {');b=mock.index('  window.__tcfapi =',a)
mock=mock[:a]+mock[b:]
mock=mock.replace('const observations = { requests:', 'const observations = { requests:')
mock=mock.replace('sizes: slot.sizes, at: Date.now()', 'sizes: slot.sizes, Variant: slot.getConfig().targeting.Variant, at: Date.now()')
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
   data=('<!doctype html><meta charset="utf-8"><title>A/A fixture</title><script nonce="fixture" src="/mock.js"></script>'+tags+'<body>'+positions+'</body>').encode();typ='text/html'
  elif path=='/mock.js':data=mock.encode()
  elif path=='/prebid.js' and query.get('case')==['delayed']:
   time.sleep(2);data=(root/'prebid.js').read_bytes()
  elif path=='/prebid.js' and query.get('case')==['wrong']:
   data=b'window.pbjs={version:"10.10.0"};'
  elif path=='/prebid.js' and query.get('case')==['failed']:
   self.send_error(404);return
  else:
   candidate=root/path.lstrip('/')
   if candidate.is_file() and root.resolve() in candidate.resolve().parents:data=candidate.read_bytes()
  if data is None:self.send_error(404);return
  self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Access-Control-Allow-Origin','*')
  self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)))
  if path=='/fixture':self.send_header('Content-Security-Policy',"script-src 'nonce-fixture' 'strict-dynamic'; object-src 'none'; base-uri 'none'")
  self.end_headers();self.wfile.write(data)

def check(name,ok):
 assert ok,name
 checks.append({'name':name,'passed':True});print('PASS '+name,flush=True)

server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
origin='http://127.0.0.1:'+str(server.server_port)
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,args=['--no-proxy-server','--disable-quic','--host-resolver-rules=MAP * ~NOTFOUND'])
  try:
   for arm,width,case in [('A',1280,'normal'),('B',390,'normal'),('A',1280,'delayed'),('B',1280,'auto'),('A',1280,'duplicate'),('A',1280,'wrong'),('A',1280,'failed'),('A',1280,'tampered')]:
    context=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
    context.add_init_script("Crypto.prototype.getRandomValues=function(a){a.fill("+('0' if arm=='A' else '4294967295')+");return a;};")
    def route(r):
     if not r.request.url.startswith(origin+'/'):
      blocked.add(urllib.parse.urlsplit(r.request.url).hostname);r.abort();return
     if case=='tampered' and r.request.url.endswith('/A.js'):
      r.fulfill(status=200,headers={'content-type':'application/javascript','access-control-allow-origin':'*'},body='window.BAD_ARM_RAN=true;');return
     r.continue_()
    context.route('**/*',route);page=context.new_page();errors=[];requested=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda r:requested.append(urllib.parse.urlsplit(r.url).path) if r.url.startswith(origin+'/') else None)
    page.goto(origin+'/fixture?case='+case)
    if case in ['wrong','failed','tampered']:
     page.wait_for_function("window.AdVariant?.snapshot().status==='error'",timeout=35000)
     state=page.evaluate('AdVariant.snapshot()')
     check(case+': no runtime/auction after dependency or integrity failure',state['runtimeEntries']==0 and not page.evaluate('Boolean(window.BAD_ARM_RAN)'))
     check(case+': specific diagnostic',state['error']=={'wrong':'prebid-version-mismatch','failed':'prebid-load-error','tampered':'arm-load-error'}[case])
    else:
     page.wait_for_function("window.AdVariant?.snapshot().status==='loaded' && window.AdVariant.snapshot().appliedSlots===19",timeout=35000)
     state=page.evaluate('AdVariant.snapshot()')
     label=arm+' '+str(width)+' '+case
     check(label+': exact packaged runtime once with native Prebid',state['runtimeEntries']==1 and state['variant']==arm and state['prebidVersion']=='11.34.0')
     check(label+': all 19 positions labeled before requests',len(state['slots'])==19 and all(s['Variant']==arm for s in state['slots']))
     arm_paths=[x for x in requested if x.endswith('/A.js') or x.endswith('/B.js')]
     check(label+': only selected arm fetched',arm_paths==['/'+config['arms'][arm]['path']])
     check(label+': one Prebid fetch',len([x for x in requested if x.endswith('/prebid.js')])==1)
     check(label+': fluid and 1x1 retained',page.evaluate("adSlots.InText_1.sizes.some(s=>s==='fluid') && adSlots.InText_1.sizes.some(s=>Array.isArray(s)&&s[0]===1&&s[1]===1)"))
     page.wait_for_function('__testAds.observations.requests.length>0',timeout=15000)
     check(label+': every first request carries Variant',page.evaluate('__testAds.observations.requests.every(r=>r.Variant==='+json.dumps(arm)+')'))
     page.locator('#InText_1').scroll_into_view_if_needed()
     page.wait_for_function("__testAds.observations.requests.some(r=>r.id==='InText_1')",timeout=15000)
     check(label+': lazy request carries Variant',page.evaluate("__testAds.observations.requests.filter(r=>r.id==='InText_1').every(r=>r.Variant==="+json.dumps(arm)+')'))
     page.evaluate('__testAds.service.refresh(Object.values(adSlots))')
     check(label+': refresh keeps labels on all slots',page.evaluate('__testAds.observations.requests.every(r=>r.Variant==='+json.dumps(arm)+')'))
     if case=='duplicate':check('duplicate HTML loader blocked',state['blockedDuplicateLoaders']==1)
     page.evaluate("() => {const s=document.createElement('script');s.src='/ads.js';s.nonce='fixture';document.head.append(s);}")
     page.wait_for_function('AdVariant.snapshot().blockedDuplicateLoaders>='+str(2 if case=='duplicate' else 1))
     check(label+': reinsertion does not switch or launch another arm',page.evaluate('AdVariant.snapshot().runtimeEntries===1 && AdVariant.snapshot().variant==='+json.dumps(arm)))
     page.evaluate("() => {const s=document.createElement('script');s.src=AdVariant.snapshot().script;s.nonce='fixture';document.head.append(s);}")
     page.wait_for_function('AdVariant.snapshot().blockedRuntimeEntries===1')
     check(label+': direct duplicate arm execution blocked',page.evaluate('AdVariant.snapshot().runtimeEntries===1'))
     check(label+': debugger agrees with actual slot targeting',page.evaluate('JSON.stringify(AdVariant.inspect().slots)===JSON.stringify(AdVariant.snapshot().slots)'))
     page_errors+=errors;check(label+': no unhandled JavaScript error',not errors)
    context.close()
  finally:browser.close()
finally:server.shutdown()
report={'scope':'CI loopback Chromium; shipped ZIP scripts + native Prebid, synthetic GPT/TCF; external attempts blocked, no live auction',
 'checks':checks,'passed':len(checks),'failed':0,'pageErrors':page_errors,'blockedExternalHosts':sorted(x for x in blocked if x)}
pathlib.Path('.generated/tanjug-aa/browser-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'passed':len(checks),'failed':0}),flush=True)
