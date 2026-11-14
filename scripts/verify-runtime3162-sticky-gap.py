"""Empty Sticky retry versus the refresh gap: 3.16.0, 3.16.1 and 3.16.2 side by side.
Real Chromium with the generated ads.js/ads.min.js, synthetic GPT/TCF and a paused
virtual clock. Every network route is intercepted; there are no ad requests.
Run scripts/prepare-runtime3162-browser-fixtures.mjs first.
"""
import json
from datetime import datetime,timedelta,timezone
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/runtime3162-evidence'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
VERSIONS=['3.16.0','3.16.1','3.16.2']
SUFFIXES=['.js','.min.js']
HTML='<!doctype html><body style="height:2000px;margin:0"><div id="ignored" class="wrapperAd"></div><div id="Sticky" class="wrapperAd"></div></body>'
PENDING="{gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown'}"
DECIDED="{gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'}"
# plan(n): is the response to the n-th Sticky request empty?
PLANS={'first':'n===1','second':'n===2','always':'true','never':'false'}
SCENARIOS=[
 # name, settings variant, empty plan, total ms, timed actions, initial CMP data, hidden at load
 # An action is page JavaScript, or 'clock:<ms>' to step Date.now() without running timers.
 ('empty-first','gap','first',400000,[],None,False),
 ('empty-second','gap','second',400000,[],None,False),
 ('always-empty','gap','always',600000,[],None,False),
 ('always-empty-retries','gap-retries','always',600000,[],None,False),
 ('always-empty-cap3','gap-retries-cap3','always',600000,[],None,False),
 ('closed-during-wait','gap','first',400000,[(50000,"document.getElementById('close_sticky_ad').click()")],None,False),
 ('clock-step-back','gap','first',400000,[(50000,'clock:-5')],None,False),
 ('hidden-during-wait','gap','first',400000,[(50000,'__setHidden(true)'),(300000,'__setHidden(false)')],None,False),
 ('hidden-at-load','gap','first',400000,[(200000,'__setHidden(false)')],None,True),
 ('consent-pending-at-load','gap','first',400000,[(200000,'__emitCmp('+DECIDED+')')],PENDING,False),
 ('consent-pending-during-wait','gap','first',400000,[(50000,'__emitCmp('+PENDING+')'),(250000,'__emitCmp('+DECIDED+')')],DECIDED,False),
 ('filled','gap','never',600000,[],None,False),
 ('interval60-empty-second','fixed60','second',400000,[],None,False),
 ('default-empty-first','default','first',400000,[],None,False),
 ('default-empty-second','default','second',400000,[],None,False),
 ('default-always-empty','default','always',400000,[],None,False),
 ('default-filled','default','never',400000,[],None,False),
]
SETUP='''([plan,cmp,hidden])=>{
 window.__sent=[];window.__testOptions={};const decide=new Function('n','return '+plan);
 Object.defineProperty(__testOptions,'allEmpty',{get:()=>decide(__sent.length)});
 window.__setHidden=h=>{
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>h?'hidden':'visible'});
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>h});
  document.dispatchEvent(new Event('visibilitychange'));
 };
 if(hidden)__setHidden(true);
 window.__cmp=cmp;
}'''
AFTER_MOCK='''()=>{
 const original=__testAds.service.refresh;
 __testAds.service.refresh=function(slots){for(const slot of slots||[])if(slot.id==='Sticky')__sent.push({at:Date.now(),hidden:document.visibilityState!=='visible'});return original.apply(this,arguments);};
 if(window.__cmp){
  window.__cmpData=window.__cmp;window.__cmpListeners=[];
  window.__tcfapi=(cmd,version,cb,id)=>{
   if(cmd==='addEventListener'){__cmpListeners.push(cb);cb({...__cmpData,listenerId:1},true);}
   else if(cmd==='removeEventListener')cb(true);
   else if(cmd==='getTCData')cb({...__cmpData},true);
   else if(cmd==='ping')cb({cmpLoaded:true,cmpStatus:'loaded'},true);
   else cb(true);
  };
  window.__emitCmp=data=>{__cmpData=data;for(const cb of [...__cmpListeners])cb({...data,listenerId:1},true);};
 }
}'''
def run(browser,version,suffix,scenario):
 name,variant,plan,total,actions,cmp,hidden=scenario
 page=browser.new_page(viewport={'width':1440,'height':900});errors=[];external=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r:external.append(r.url) if r.url.startswith(('http:','https:')) else None)
 page.route('**/*',lambda r:r.abort())
 page.set_content(HTML)
 now=datetime(2026,10,24,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
 page.evaluate(SETUP,[PLANS[plan],None,hidden])
 page.add_script_tag(content=mock)
 if cmp:page.evaluate('(c)=>{window.__cmp=(new Function("return "+c))();}',cmp)
 page.evaluate(AFTER_MOCK)
 start=page.evaluate('Date.now()')
 page.add_script_tag(content=(out/version/(variant+suffix)).read_text())
 marks=[];elapsed=0
 for at,action in actions:
  page.clock.run_for(at-elapsed);elapsed=at
  if action.startswith('clock:'):
   wall=page.evaluate('Date.now()')+int(action[6:])
   page.clock.set_system_time(datetime.fromtimestamp(wall/1000,timezone.utc).isoformat(timespec='milliseconds'))
  else:page.evaluate('()=>{'+action+'}')
  marks.append({'at':at,'action':action,'sentBefore':page.evaluate('__sent.length')})
 page.clock.run_for(total-elapsed)
 value=page.evaluate('''()=>({requests:__sent,debug:adopsDebug.slot('Sticky'),consent:__tesseraReadiness?__tesseraReadiness.snapshot().consent:null,
   loaded:document.getElementById('Sticky').classList.contains('ad-loaded')})''')
 page.close()
 offsets=[r['at']-start for r in value['requests']]
 return {'version':version,'suffix':suffix,'scenario':name,'variant':variant,'plan':plan,'offsetsMs':offsets,
  'gapsMs':[b-a for a,b in zip(offsets,offsets[1:])],'sentWhileHidden':sum(1 for r in value['requests'] if r['hidden']),
  'marks':marks,'loaded':value['loaded'],'refreshCount':value['debug'].get('refreshCount'),
  'gapRemainingMs':(value['debug'].get('state') or {}).get('gapRemainingMs'),'consentReady':(value['consent'] or {}).get('ready'),
  'errors':errors,'externalRequests':external}
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
 for scenario in SCENARIOS:
  for version in VERSIONS:
   for suffix in SUFFIXES:
    result=run(browser,version,suffix,scenario);results.append(result)
    print(json.dumps({k:result[k] for k in ['scenario','version','suffix','offsetsMs','loaded','refreshCount','sentWhileHidden','errors']}),flush=True)
 browser.close()
(out/'sticky-gap-results.json').write_text(json.dumps(results,indent=1)+'\n')

def get(name,version,suffix='.js'):
 return next(r for r in results if r['scenario']==name and r['version']==version and r['suffix']==suffix)
failures=[]
def check(ok,message):
 if not ok:failures.append(message)
for r in results:
 check(not r['errors'] and not r['externalRequests'],f"{r['scenario']} {r['version']}{r['suffix']}: page errors or network")
for name,*_ in SCENARIOS:
 for version in VERSIONS:
  check(get(name,version,'.js')['offsetsMs']==get(name,version,'.min.js')['offsetsMs'],f'{name} {version}: ads.js and ads.min.js differ')
def near(actual,*seconds):
 # Offsets are measured from script injection; GPT mock renders after 10 ms.
 return len(actual)==len(seconds) and all(abs(a-s*1000)<=100 for a,s in zip(actual,seconds))
for suffix in SUFFIXES:
 f=lambda name:get(name,'3.16.2',suffix)
 old=lambda name:get(name,'3.16.1',suffix)
 # Reviewer reproduction: 3.16.1 stops, 3.16.2 retries exactly at the remaining gap.
 check(near(old('empty-first')['offsetsMs'],0) and not old('empty-first')['loaded'],'3.16.1 empty-first no longer reproduces R2-01')
 check(near(f('empty-first')['offsetsMs'],0,100,200,300) and f('empty-first')['loaded'],f"3.16.2 empty-first {f('empty-first')['offsetsMs']}")
 check(len(old('empty-second')['offsetsMs'])==2 and not old('empty-second')['loaded'],'3.16.1 empty-second no longer reproduces R2-01')
 check(near(f('empty-second')['offsetsMs'],0,100,200,300) and f('empty-second')['loaded'],f"3.16.2 empty-second {f('empty-second')['offsetsMs']}")
 # Date.now() stepping back 5 ms during the deferred wait: the step is deferred again, not lost.
 check(near(old('clock-step-back')['offsetsMs'],0) and not old('clock-step-back')['loaded'],'3.16.1 clock-step-back no longer reproduces R2-01')
 check(near(f('clock-step-back')['offsetsMs'],0,100,200,300) and f('clock-step-back')['loaded'],f"3.16.2 clock-step-back {f('clock-step-back')['offsetsMs']}")
 # The configured retry budget and cap remain; spacing never undercuts the gap.
 check(near(f('always-empty')['offsetsMs'],0,100),f"3.16.2 always-empty {f('always-empty')['offsetsMs']}")
 check(near(f('always-empty-retries')['offsetsMs'],0,100,200,300,400,500),f"3.16.2 always-empty-retries {f('always-empty-retries')['offsetsMs']}")
 check(near(f('always-empty-cap3')['offsetsMs'],0,100,200,300) and f('always-empty-cap3')['refreshCount']==3,f"3.16.2 cap3 {f('always-empty-cap3')['offsetsMs']}")
 for name in ['empty-first','empty-second','clock-step-back','always-empty','always-empty-retries','always-empty-cap3','closed-during-wait','hidden-during-wait','hidden-at-load','consent-pending-at-load','consent-pending-during-wait','filled']:
  check(all(g>=100000 for g in f(name)['gapsMs']),f'3.16.2 {name} undercuts the 100 s gap: {f(name)["gapsMs"]}')
 # User close, hidden page and pending consent each stop dispatch.
 for version in VERSIONS:
  check(not any(t>50000 for t in get('closed-during-wait',version,suffix)['offsetsMs']),f'{version} closed-during-wait sent after close')
 check(near(f('closed-during-wait')['offsetsMs'],0),'3.16.2 closed-during-wait')
 hidden=f('hidden-during-wait')
 check(hidden['sentWhileHidden']==0 and near(hidden['offsetsMs'],0,350),f"3.16.2 hidden-during-wait {hidden['offsetsMs']}")
 check(sum(1 for t in hidden['offsetsMs'] if 300000<=t<400000)==1,'3.16.2 more than one send right after visibility')
 for version in VERSIONS:check(get('hidden-during-wait',version,suffix)['sentWhileHidden']==0,f'{version} sent while hidden')
 load=f('hidden-at-load')
 check(near(load['offsetsMs'],0,200,300) and load['sentWhileHidden']==1,f"3.16.2 hidden-at-load {load['offsetsMs']}")
 for version in VERSIONS:
  pending=get('consent-pending-at-load',version,suffix)
  check(all(t>=200000 for t in pending['offsetsMs']),f'{version} sent before the CMP decision')
  wait=get('consent-pending-during-wait',version,suffix)
  check(not any(50000<t<250000 for t in wait['offsetsMs']),f'{version} sent while consent was pending: {wait["offsetsMs"]}')
 check(near(f('consent-pending-at-load')['offsetsMs'],200,300),f"3.16.2 consent-pending-at-load {f('consent-pending-at-load')['offsetsMs']}")
 check(near(f('consent-pending-during-wait')['offsetsMs'],0,250,350),f"3.16.2 consent-pending-during-wait {f('consent-pending-during-wait')['offsetsMs']}")
 # Filled Sticky keeps the 3.16.1 schedule; default settings are unchanged.
 check(f('filled')['offsetsMs']==old('filled')['offsetsMs'] and near(f('filled')['offsetsMs'],0,100,200,300,400,500),f"filled {f('filled')['offsetsMs']}")
 for name in ['default-empty-first','default-empty-second','default-always-empty','default-filled']:
  check(f(name)['offsetsMs']==old(name)['offsetsMs'],f'{name}: 3.16.2 differs from 3.16.1 ({f(name)["offsetsMs"]} vs {old(name)["offsetsMs"]})')
 # Interval-only variant of the same defect (inherited 60 s schedule, 30 s empty retry).
 check(near(old('interval60-empty-second')['offsetsMs'],0,60) and not old('interval60-empty-second')['loaded'],f"3.16.1 interval60 {old('interval60-empty-second')['offsetsMs']}")
 check(near(f('interval60-empty-second')['offsetsMs'],0,60,120,180,240,300,360) and f('interval60-empty-second')['loaded'],f"3.16.2 interval60 {f('interval60-empty-second')['offsetsMs']}")
if failures:
 print('\n'.join('FAIL '+x for x in failures));raise SystemExit(1)
print(f'3.16.2 Sticky gap matrix passed: {len(results)} runs, no page errors or network.')
