"""Independent loader race proof with real loopback bandwidth and frozen native arms.

Uses real classic-script/SRI/CORS/CSP execution. All ad demand is synthetic and
every nonfixture request is fulfilled locally or aborted. No live/paid GAM calls.
"""
import hashlib,io,json,os,sys,threading,time,urllib.parse,zipfile
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from importlib.metadata import version as package_version
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(sys.argv[1] if len(sys.argv)>1 else ROOT/'.generated/ab-loader111-transport-qa').resolve()
MODE=sys.argv[2] if len(sys.argv)>2 else '--full'
assert MODE in ['--full','--ci','--quick'],MODE
INPUT=json.loads((OUT/'inputs.json').read_text())
FIXTURES=Path(INPUT['fixtures'])
sha=lambda value:hashlib.sha256(value).hexdigest()
archive=(FIXTURES/'bundles/ab/bundle.zip').read_bytes()
assert sha(archive)==INPUT['bundleSha256']
record=json.loads((FIXTURES/'bundles/ab/record.json').read_text())
assert sha((FIXTURES/'bundles/ab/record.json').read_bytes())==INPUT['recordSha256']
with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
 FILES={item.filename:bundle.read(item) for item in bundle.infolist()}
for entry in record['bundle']['files']:
 assert len(FILES[entry['path']])==entry['bytes'] and sha(FILES[entry['path']])==entry['sha256']
for side,arm in INPUT['arms'].items():assert sha(FILES[arm['path']])==arm['sha256']
assert sha(FILES['prebid.js'])==INPUT['prebid']['sha256']
for version,loader in INPUT['loaders'].items():assert sha((OUT/('loader-'+version+'.js')).read_bytes())==loader['entrySha256']

mock=(ROOT/'tests/runtime/mock-gpt-page-targeting.js').read_text()
GPT=mock[:mock.index('  window.pbjs = {')]+mock[mock.index('  window.__testAds ='):]
INIT=(ROOT/'tests/runtime/ab-loader111-native-init.js').read_text()
BID='https://bids.example.invalid/__synthetic-bid'
BIDS={'pubmatic':[[10,4],[1],[2],[12]],'openx':[[0.5],[0.5],[0.5],[0.5]]}
SLOTS='<div id="Billboard" class="wrapperAd" style="min-height:250px"></div><div id="P1" class="wrapperAd" style="min-height:250px"></div><main style="height:2000px"></main><div id="P2" class="wrapperAd lazyAd" style="min-height:250px"></div>'
COLLECT='''() => ({loader:window.__tesseraAbLoader?.snapshot?.()||null,measurement:window.__tesseraAbLoader?.measurement?.()||null,
 started:!!window.__TESSERA_RUNTIME_STARTED,requests:window.__testAds?.observations?.requests||[],gptErrors:window.__testAds?.observations?.commandErrors||[],
 nativeBidRequests:(window.pbjs?.getEvents?.()||[]).filter(row=>row.eventType==='bidRequested').length,
 activeLoaderTimers:(window.__loaderTimers||[]).filter(row=>row.active).length,
 prebid:window.pbjs?.version||null,storage:{local:localStorage.length,session:sessionStorage.length,cookie:document.cookie},
 arms:[...document.scripts].filter(s=>s.src.includes('/r/')).map(s=>({src:s.src,integrity:s.integrity,crossOrigin:s.crossOrigin,nonce:s.nonce}))})'''

class Origin:
 def __init__(self,rate=0,delays=None):
  self.rate,self.delays,self.files,self.headers,self.log,self.epoch=rate,delays or {},{},[],[],time.monotonic()
  origin=self
  class Handler(BaseHTTPRequestHandler):
   def do_GET(self):
    path=urllib.parse.urlsplit(self.path).path;body=origin.files.get(path,b'Not found')
    row={'path':path,'status':200 if path in origin.files else 404,'bytes':len(body),'requestedMs':round((time.monotonic()-origin.epoch)*1000,3)};origin.log.append(row)
    time.sleep(origin.delays.get(path,0))
    self.send_response(row['status'])
    kind='application/javascript; charset=utf-8' if path.endswith('.js') else 'text/html; charset=utf-8'
    for key,value in [('Content-Type',kind),('Content-Length',str(len(body))),('Cache-Control','no-store'),('Access-Control-Allow-Origin','*')]+origin.headers:self.send_header(key,value)
    self.end_headers();rate=origin.rate if path.startswith('/r/') else 0
    row['rateBytesPerSecond']=rate;start=time.monotonic()
    try:
     if not rate:self.wfile.write(body);self.wfile.flush()
     else:
      for offset in range(0,len(body),1024):
       wait=start+offset/rate-time.monotonic()
       if wait>0:time.sleep(wait)
       self.wfile.write(body[offset:offset+1024]);self.wfile.flush()
     row['completedMs']=round((time.monotonic()-origin.epoch)*1000,3)
    except (BrokenPipeError,ConnectionResetError):row['clientDisconnectedMs']=round((time.monotonic()-origin.epoch)*1000,3)
   def log_message(self,*args):pass
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True
  self.url='http://127.0.0.1:'+str(self.server.server_port)
  threading.Thread(target=self.server.serve_forever,daemon=True).start()
 def close(self):self.server.shutdown();self.server.server_close()

results=[]
def exercise(browser,version,assigned,rate=0,kind='normal'):
 armB='/'+INPUT['arms']['B']['path']
 delays={armB:11} if kind=='control-wins' else {armB:1} if kind=='keyword-accessor' else {}
 site,cdn=Origin(),Origin(rate,delays)
 context=browser.new_context(viewport={'width':1280,'height':900},service_workers='block')
 page=context.new_page();errors=[];console=[];outbound=[];answered=[]
 page.on('pageerror',lambda error:errors.append(str(error)))
 page.on('console',lambda message:console.append(message.text) if message.type=='error' else None)
 cdn.files={'/'+path:body for path,body in FILES.items() if path!='_headers'}
 cdn.files['/ads.js']=(OUT/('loader-'+version+'.js')).read_bytes()
 if kind=='sri-error':cdn.files[armB]=cdn.files[armB]+b'\n/* Integrity mismatch intentionally introduced by QA. */'
 nonce='transport-nonce' if kind=='trusted-types' else ''
 attr=' nonce="'+nonce+'"' if nonce else ''
 head='<script'+attr+' src="'+cdn.url+'/prebid.js"></script><script'+attr+' defer src="'+cdn.url+'/ads.js"></script>'
 site.files['/']=('<!doctype html><html><head><meta charset="utf-8">'+head+'</head><body style="margin:0">'+SLOTS+'</body></html>').encode()
 if nonce:site.headers=[('Content-Security-Policy',"script-src 'nonce-transport-nonce' 'strict-dynamic'; object-src 'none'; require-trusted-types-for 'script'; trusted-types default tessera-ab-loader")]
 def route(request):
  url=request.request.url
  if url.startswith(BID+'?'):
   rows=json.loads(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['payload'][0]);answered.extend(rows)
   bids=[{**row,'mediaType':'banner','creativeId':'synthetic','currency':'EUR','netRevenue':True,'ad':'<div>Synthetic QA creative</div>','meta':{'advertiserDomains':['example.invalid']}} for row in rows]
   request.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'bids':bids}))
  elif url=='https://prebid-professor.mbaucal.workers.dev/geo/v1/country':request.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'known':True,'country':'RS','source':'cloudflare'}))
  elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):request.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'USD':1,'EUR':1}}}))
  elif url.startswith(site.url+'/') or url.startswith(cdn.url+'/'):request.continue_()
  else:outbound.append(url);request.abort()
 page.route('**/*',route)
 init=INIT.replace('%DRAW%','0' if assigned=='A' else '4294967295').replace('%CMP%',json.dumps('pending' if kind=='cmp-pending' else 'granted')).replace('%SCRIPT%',json.dumps(BIDS)).replace('%LOADER%',cdn.url+'/ads.js').replace('%TC%','synthetic-loader-qa-tc').replace('%BID%',BID)
 if nonce:init="trustedTypes.createPolicy('default',{createHTML:html=>html});\n"+init
 page.add_init_script(init+'\n'+GPT)
 timeline=[];last=None;first=None;epoch=time.monotonic();site.epoch=cdn.epoch=epoch
 budget=32 if rate else 13 if kind=='control-wins' else 4
 if kind=='cmp-pending':budget=24
 try:
  page.goto(site.url+'/',wait_until='domcontentloaded',timeout=20000)
  if kind=='keyword-accessor':
   page.evaluate("""() => {let reads=0;Object.defineProperty(window,'adsKeywords',{configurable:true,get(){return ++reads===2?{Variant:'publisher'}:{}}});}""")
  granted=False
  while time.monotonic()-epoch<budget:
   elapsed=round((time.monotonic()-epoch)*1000,3)
   value=page.evaluate('({loader:window.__tesseraAbLoader?.snapshot?.()||null,started:!!window.__TESSERA_RUNTIME_STARTED,gam:window.__testAds?.observations?.requests?.length||0,nativeBids:(window.pbjs?.getEvents?.()||[]).filter(e=>e.eventType==="bidRequested").length})')
   signature=json.dumps(value,sort_keys=True)
   if signature!=last:timeline.append({'elapsedMs':elapsed,**value});last=signature
   if value['gam'] and first is None:first=elapsed
   if kind=='cmp-pending' and elapsed>=21500 and not granted:
    assert value['started'] and value['gam']==0 and value['nativeBids']==0,'Timeout must not grant consent'
    page.evaluate('window.__fixtureGrantCmp()');granted=True
   page.wait_for_timeout(100)
  final=page.evaluate(COLLECT)
  assert not errors,errors
  assert not outbound,outbound
  assert not final['gptErrors'],final['gptErrors']
  assert final['loader']['loader']==version and final['loader']['originalVariant']==assigned
  assert final['prebid'].lstrip('v')=='11.34.0'
  expected_failure=version=='1.1.0' and rate>0 and assigned=='B'
  if expected_failure:
   assert not final['started'] and len(final['requests'])==0,'Frozen1.1.0 reproducer unexpectedly changed'
  else:
   assert final['started'] and len(final['requests'])==2,('Expected exactly one native initial request per visible slot',final)
   assert final['nativeBidRequests']==4 and len(answered)==6,'Both visible slots must keep exactly one native fresh auction, without a second runtime auction'
   execution='A' if kind in ['control-wins','sri-error'] else assigned
   assert final['loader']['executionArm']==execution,(kind,final['loader'])
   assert final['loader']['fallback']==(assigned=='B' and execution=='A')
   for request in final['requests']:
    if kind=='keyword-accessor':assert not request['page'].get('Variant') and not request['page'].get('TestId'),request
    else:assert request['page']['Variant']==[assigned] and request['page']['TestId']==['loader_transport_qa'],request
   if kind=='keyword-accessor':assert final['loader']['exclusionReason']=='excluded-key-conflict'
   if kind=='trusted-types':assert all(arm['nonce']==nonce for arm in final['arms'])
   assert final['activeLoaderTimers']==0
   assert final['measurement']['schemaVersion']==2
   assert sum(event['type']=='runtime-started' for event in final['measurement']['events'])==1
  assert final['storage']=={'local':0,'session':0,'cookie':''}
  if kind=='sri-error':assert console and all('integrity' in message and 'blocked' in message for message in console),console
  else:assert not console,console
  result={'version':version,'assigned':assigned,'rateBytesPerSecond':rate,'case':kind,'passed':True,'firstGamObservedMs':first,
   'timeline':timeline,'final':final,'server':cdn.log,'errors':errors,'console':console,'unexpectedOutbound':outbound,'syntheticBidResponses':len(answered)}
  results.append(result)
  (OUT/'results.json').write_text(json.dumps({'passed':True,'results':results,'inputs':INPUT,'toolchain':{'playwright':package_version('playwright'),'chromium':browser.version},
   'limits':['Real uncompressed sustained per-response bandwidth on loopback; not measured publisher impact or compressed production throughput.','Native pinnedPrebid11.34 and frozen3.25.1 arms; syntheticGPT/CMP/bidders only.','Independent page contexts; about100ms first-request polling resolution.','Technical fixture entries do not change any saved experiment/ZIP or activate a publisher.']},indent=2)+'\n')
  print(json.dumps({'passed':True,'version':version,'assigned':assigned,'rate':rate,'case':kind,'firstGamMs':first,'gamRequests':len(final['requests']),'execution':final['loader'].get('executionArm'),'fallback':final['loader'].get('fallback')}),flush=True)
 except Exception as error:
  (OUT/'failure.json').write_text(json.dumps({'error':str(error),'version':version,'assigned':assigned,'rate':rate,'case':kind,'timeline':timeline,'server':cdn.log,'errors':errors,'console':console,'outbound':outbound},indent=2)+'\n');raise
 finally:context.close();site.close();cdn.close()

with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
 try:
  if MODE=='--ci':
   exercise(browser,'1.1.1','B',15*1024)
   exercise(browser,'1.1.1','A',10*1024)
  elif MODE=='--quick':
   exercise(browser,'1.1.1','B')
   for kind in ['sri-error','trusted-types','keyword-accessor']:exercise(browser,'1.1.1','B',kind=kind)
  else:
   exercise(browser,'1.1.0','B',15*1024)
   for rate in [0,15*1024,10*1024]:
    for assigned in ['A','B']:exercise(browser,'1.1.1',assigned,rate)
   for kind in ['control-wins','sri-error','trusted-types','keyword-accessor']:exercise(browser,'1.1.1','B',kind=kind)
   exercise(browser,'1.1.1','B',15*1024,kind='cmp-pending')
 finally:browser.close()
print(json.dumps({'passed':True,'cases':len(results),'evidence':str(OUT)}))
