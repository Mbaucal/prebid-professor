"""Content refresh in 3.16.0, 3.16.1 and 3.16.2 side by side (R3-01 inherited visibility
threshold on desktop and mobile, R3-09 schedule steps). Real Chromium with the generated
ads.js/ads.min.js, the repo GPT/TCF mock, a paused virtual clock and an IntersectionObserver
driven by that clock. Every network route is intercepted; there are no ad requests.
Run scripts/prepare-runtime3162-browser-fixtures.mjs first.
"""
import json,re
from datetime import datetime,timedelta,timezone
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
out=root/'.generated/runtime3162-evidence/refresh'
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
VERSIONS=['3.16.0','3.16.1','3.16.2']
SUFFIXES=['.js','.min.js']
# The generated isMobile() is a (max-width: 767px) media query or a Mobi/Android user agent.
DEVICES={
 'desktop':{'viewport':{'width':1440,'height':900}},
 'mobile':{'viewport':{'width':390,'height':844},'is_mobile':True,'has_touch':True,'device_scale_factor':3,
  'user_agent':'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'},
}
# Chromium delivers real IntersectionObserver callbacks in rendering steps that the paused
# virtual clock does not control, so the lazy first display (3.16.0 times its first request
# from it) could land at any virtual time when the machine is busy. The same layout geometry
# is computed here instead (viewport plus rootMargin, the spec's threshold-crossing rule) and
# delivered by a 0 ms virtual timer after observe() and after every __place(), in every version.
IO=r'''(()=>{const observers=new Set();let queued=false;
const margins=(text,w,h)=>{const p=String(text||'0px').trim().split(/\s+/),v=[p[0],p[1]??p[0],p[2]??p[0],p[3]??p[1]??p[0]];
 return v.map((x,i)=>x.endsWith('%')?parseFloat(x)/100*(i%2?w:h):parseFloat(x)||0);};
function entry(o,target){
 const w=document.documentElement.clientWidth,h=document.documentElement.clientHeight,[t,r,b,l]=margins(o.rootMargin,w,h);
 const rootBounds=new DOMRectReadOnly(-l,-t,w+l+r,h+t+b),rect=target.getBoundingClientRect();
 const left=Math.max(rect.left,rootBounds.left),top=Math.max(rect.top,rootBounds.top),right=Math.min(rect.right,rootBounds.right),bottom=Math.min(rect.bottom,rootBounds.bottom);
 const isIntersecting=target.isConnected&&right>=left&&bottom>=top,area=rect.width*rect.height;
 const intersectionRect=isIntersecting?new DOMRectReadOnly(left,top,right-left,bottom-top):new DOMRectReadOnly(0,0,0,0);
 const intersectionRatio=!isIntersecting?0:area?intersectionRect.width*intersectionRect.height/area:1;
 const index=isIntersecting?o.thresholds.filter(x=>x<=intersectionRatio).length:0;
 return {target,time:performance.now(),rootBounds,boundingClientRect:rect,intersectionRect,intersectionRatio,isIntersecting,index};}
function deliver(){queued=false;
 for(const o of [...observers]){const entries=[];
  for(const [target,state] of o._targets){const e=entry(o,target);
   if(e.index!==state.index||e.isIntersecting!==state.isIntersecting){state.index=e.index;state.isIntersecting=e.isIntersecting;delete e.index;entries.push(e);}}
  if(entries.length)try{o._callback.call(o,entries,o);}catch(error){reportError(error);}}}
window.__ioCheck=()=>{if(!queued){queued=true;setTimeout(deliver,0);}};
window.IntersectionObserver=class IntersectionObserver{
 constructor(callback,options={}){const t=options.threshold;if(options.root)reportError(Error('only the viewport root is modelled'));this._callback=callback;this._targets=new Map();this.root=options.root||null;this.rootMargin=options.rootMargin||'0px';
  this.thresholds=(Array.isArray(t)?t:[t==null?0:t]).map(Number).sort((a,b)=>a-b);observers.add(this);}
 // The first notification always follows observe(): the previous index starts at -1.
 observe(target){if(!this._targets.has(target)){this._targets.set(target,{index:-1,isIntersecting:false});__ioCheck();}}
 unobserve(target){this._targets.delete(target);}
 disconnect(){this._targets.clear();}
 takeRecords(){return [];}
};})();'''
HOOK=r'''window.__sent=[];const send=__testAds.service.refresh;
__testAds.service.refresh=function(slots,opts){for(const slot of slots||[])if(slot.id==='P1')__sent.push({at:Date.now(),count:String((slot.targeting||{}).refresh_count||'0')});return send.apply(this,arguments);};
// P1 is 250 px high and full width at the bottom of the viewport: pct% of it is visible.
window.__place=pct=>{document.getElementById('P1').style.top=(innerHeight-2.5*pct)+'px';__ioCheck();};
window.__view=pct=>{__place(pct);
 const slot=__testAds.slots.find(s=>s.id==='P1');if(slot)__testAds.emit('slotVisibilityChanged',{slot,inViewPercentage:pct});};'''
TO30=(5000,30);TO60=(60000,60);TO55=(5000,55);BACK65=(70000,65)
SCENARIOS=[
 # name, fixture, device, initial visible %, timed visibility changes, total ms
 ('seq-30-90-45','seq-30-90-45','desktop',100,[],400000),
 ('seq-30-90-45-prebid','seq-30-90-45-prebid','desktop',100,[],400000),
 ('first60-next30','first60-next30','desktop',100,[],400000),
 ('fixed30','fixed30','desktop',100,[],400000),
 ('pct30-50','pct30-50','desktop',100,[],400000),
 ('none@60','view-none','desktop',60,[],120000),
 ('none@30','view-none','desktop',60,[TO30],120000),
 ('none@30then60','view-none','desktop',60,[TO30,TO60],120000),
 ('explicit0@30','view-explicit0','desktop',60,[TO30],120000),
 ('explicit50@60','view-explicit50','desktop',60,[],120000),
 ('explicit50@30','view-explicit50','desktop',60,[TO30],120000),
 ('explicit50@30then60','view-explicit50','desktop',60,[TO30,TO60],120000),
 ('atf-only@60','view-atf-only','desktop',60,[],120000),
 ('none@30','view-none','mobile',60,[TO30],120000),
]
for device in DEVICES:
 SCENARIOS+=[
  # ATF-only site (45 s, 60%, no Default refresh): P1 is BTF and saves no percentage.
  ('atf-only@55','view-atf-only',device,55,[],120000),
  ('atf-only@65','view-atf-only',device,65,[],120000),
  ('atf-only@65to55to65','view-atf-only',device,65,[TO55,BACK65],160000),
  ('atf-only-p1-60@65to55to65','view-atf-only-p1-60',device,65,[TO55,BACK65],160000),
  # Default saves 0: entry is the device default (desktop 50%, mobile 40%), no refresh-time check.
  ('explicit0@45','view-explicit0',device,45,[],120000),
  ('none@55','view-none',device,55,[],120000),
 ]
def is_mobile_source(version):
 """The generated isMobile() function, evaluated in the page as a debug hook."""
 found=set(re.findall(r'function isMobile\(\)\{try\{return [^}]*\}catch\(_\)\{return false\}\}',(out/version/'view-none.min.js').read_text()))
 assert len(found)==1,found
 return found.pop()
def run(browser,version,suffix,scenario):
 name,fixture,device,initial,actions,total=scenario
 context=browser.new_context(**DEVICES[device]);page=context.new_page();errors=[];external=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r:external.append(r.url) if r.url.startswith(('http:','https:')) else None)
 page.route('**/*',lambda r:r.abort())
 page.set_content('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;height:3000px"><div id="P1" class="wrapperAd" style="position:absolute;left:0;width:100%;height:250px;top:0"></div></body>')
 now=datetime(2026,10,25,tzinfo=timezone.utc);page.clock.install(time=now);page.clock.pause_at(now+timedelta(seconds=1))
 page.evaluate('()=>{window.__testOptions={};}')
 page.add_script_tag(content=IO);page.add_script_tag(content=mock);page.add_script_tag(content=HOOK);page.evaluate(f'__place({initial})')
 mobile=page.evaluate('(()=>{'+is_mobile_source(version)+'\nreturn isMobile();})()')
 start=page.evaluate('Date.now()')
 page.add_script_tag(content=(out/version/(fixture+suffix)).read_text())
 elapsed=0
 for at,pct in actions:
  page.clock.run_for(at-elapsed);elapsed=at;page.evaluate(f'__view({pct})')
 page.clock.run_for(total-elapsed)
 sent=page.evaluate('__sent');context.close()
 # The initial (lazy) request carries refresh_count 0; automatic refreshes carry 1, 2, ...
 # in every version.
 initial=[s['at']-start for s in sent if s['count']=='0'];refresh=[s['at']-start for s in sent if s['count']!='0']
 return {'version':version,'suffix':suffix,'scenario':name,'device':device,'isMobile':mobile,'initialMs':initial,'refreshMs':refresh,'counts':[s['count'] for s in sent if s['count']!='0'],
  'gapsMs':[b-a for a,b in zip(refresh,refresh[1:])],'errors':errors,'externalRequests':external}
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
 for scenario in SCENARIOS:
  for version in VERSIONS:
   for suffix in SUFFIXES:
    result=run(browser,version,suffix,scenario);results.append(result)
    print(json.dumps({k:result[k] for k in ['scenario','device','version','suffix','refreshMs','gapsMs','errors']}),flush=True)
 browser.close()
out.joinpath('refresh-results.json').write_text(json.dumps(results,indent=1)+'\n')
def get(name,version,suffix='.js',device='desktop'):
 return next(r for r in results if r['scenario']==name and r['version']==version and r['suffix']==suffix and r['device']==device)
failures=[]
def check(ok,message):
 if not ok:failures.append(message)
for r in results:
 where=f"{r['scenario']} {r['device']} {r['version']}{r['suffix']}"
 check(not r['errors'] and not r['externalRequests'],f'{where}: page errors or network')
 check(len(r['initialMs'])<=1 and r['counts']==[str(i+1) for i in range(len(r['counts']))],f'{where}: unexpected request counts')
 check(r['isMobile']==(r['device']=='mobile'),f"{where}: generated isMobile() is {r['isMobile']}")
for name,_,device,initial,*_ in SCENARIOS:
 for version in VERSIONS:
  js,minified=get(name,version,'.js',device),get(name,version,'.min.js',device)
  check((js['initialMs'],js['refreshMs'])==(minified['initialMs'],minified['refreshMs']),f'{name} {device} {version}: ads.js and ads.min.js differ')
 # The lazy first display (50% in view) is the one initial request, at the same time in every
 # version, so a request with count 0 is never one the dwell timer made instead.
 if initial>=50:
  first=[get(name,version,'.js',device)['initialMs'] for version in VERSIONS]
  check(first[0]==first[1]==first[2] and len(first[0])==1 and first[0][0]<30000,f'{name} {device}: initial requests {first}')
for suffix in SUFFIXES:
 g=lambda name,version='3.16.2',device='desktop':get(name,version,suffix,device)
 # R3-09: a shorter later step is requested at the 3.16.0 times; 3.16.1 repeats the longer step.
 for name in ['seq-30-90-45','seq-30-90-45-prebid','first60-next30']:
  check(g(name)['gapsMs']==g(name,'3.16.0')['gapsMs'],f"R3-09 {name}{suffix}: 3.16.2 {g(name)['gapsMs'][:4]} vs 3.16.0 {g(name,'3.16.0')['gapsMs'][:4]}")
 check(g('seq-30-90-45')['gapsMs'][:4]==[90000,45000,45000,45000],f"R3-09 seq-30-90-45{suffix}: {g('seq-30-90-45')['gapsMs'][:4]}")
 check(g('seq-30-90-45','3.16.1')['gapsMs'][:3]==[90000,90000,45000],'3.16.1 no longer reproduces R3-09')
 for name in ['fixed30','pct30-50']:
  check(g(name)['refreshMs']==g(name,'3.16.1')['refreshMs'],f'{name}{suffix}: non-decreasing schedule changed')
 # R3-01: no saved minViewPct means the inherited threshold (here 50%) at refresh time; saved values are kept.
 for device in DEVICES:
  check(len(g('none@30','3.16.1',device)['refreshMs'])>=2,f'{device}: 3.16.1 no longer reproduces R3-01')
  check(g('none@30','3.16.2',device)['refreshMs']==[],f"R3-01 none@30 {device}{suffix}: 3.16.2 refreshed below 50%: {g('none@30','3.16.2',device)['refreshMs']}")
 check(g('none@60')['refreshMs']==g('none@60','3.16.1')['refreshMs'] and len(g('none@60')['refreshMs'])>=2,f"none@60{suffix}: {g('none@60')['refreshMs']}")
 check(g('none@30then60')['refreshMs']==g('explicit50@30then60')['refreshMs'],f"none@30then60{suffix}: differs from an explicit 50%")
 check(g('explicit0@30')['refreshMs']==g('explicit0@30','3.16.1')['refreshMs'] and len(g('explicit0@30')['refreshMs'])>=2,f'explicit0@30{suffix}: explicit 0 changed')
 for name in ['explicit50@60','explicit50@30','explicit50@30then60']:
  check(g(name)['refreshMs']==g(name,'3.16.1')['refreshMs']==g(name,'3.16.0')['refreshMs'],f'{name}{suffix}: explicit 50% changed')
 check(g('atf-only@60')['refreshMs']==g('atf-only@60','3.16.1')['refreshMs']==g('atf-only@60','3.16.0')['refreshMs'],f"atf-only@60{suffix}: inherited interval changed {g('atf-only@60')['refreshMs']}")
 for device in DEVICES:
  d=lambda name,version='3.16.2':g(name,version,device)
  at=f'{device}{suffix}'
  # ATF-only: P1 enters at the ATF 60% in every version, so 55% never starts refresh and 65% does, at the same times.
  for version in VERSIONS:
   check(d('atf-only@55',version)['refreshMs']==[] and len(d('atf-only@55',version)['initialMs'])==1,f"atf-only@55 {at} {version}: {d('atf-only@55',version)['initialMs']} {d('atf-only@55',version)['refreshMs']}")
  check(d('atf-only@65')['refreshMs']==d('atf-only@65','3.16.1')['refreshMs']==d('atf-only@65','3.16.0')['refreshMs'] and len(d('atf-only@65')['refreshMs'])>=2,f"atf-only@65 {at}: {[d('atf-only@65',v)['refreshMs'] for v in VERSIONS]}")
  # Entered at 65%, then 55%: earlier versions keep refreshing; 3.16.2 applies the inherited 60% until P1 is back at 65%.
  for version in ['3.16.0','3.16.1']:
   check(any(t<70000 for t in d('atf-only@65to55to65',version)['refreshMs']),f"atf-only@65to55to65 {at} {version} no longer refreshes at 55%: {d('atf-only@65to55to65',version)['refreshMs']}")
  moved=d('atf-only@65to55to65')['refreshMs']
  check(moved and all(t>=70000 for t in moved) and moved[0]<80000 and len(moved)>=2,f'atf-only@65to55to65 {at}: 3.16.2 {moved}')
  for version in ['3.16.1','3.16.2']:
   check(moved==d('atf-only-p1-60@65to55to65',version)['refreshMs'],f"atf-only@65to55to65 {at}: 3.16.2 {moved} differs from 60% saved on P1 in {version} {d('atf-only-p1-60@65to55to65',version)['refreshMs']}")
  # Default saves 0: no refresh-time check in any version; desktop never enters at 45%, mobile does.
  # The lazy first display needs 50%, so on mobile the dwell timer makes the first request (count 0).
  timeline=[sorted(d('explicit0@45',v)['initialMs']+d('explicit0@45',v)['refreshMs']) for v in VERSIONS]
  check(timeline[0]==timeline[1]==timeline[2] and (timeline[2]==[] if device=='desktop' else len(timeline[2])>=3 and timeline[2][0]>=30000),f'explicit0@45 {at}: {timeline}')
  # No Unit rules: 55% is above the inherited 50%, so 3.16.2 refreshes like 3.16.1 (3.16.0 keeps its global switch off).
  check(d('none@55')['refreshMs']==d('none@55','3.16.1')['refreshMs'] and len(d('none@55')['refreshMs'])>=2 and d('none@55','3.16.0')['refreshMs']==[],f"none@55 {at}: {[d('none@55',v)['refreshMs'] for v in VERSIONS]}")
if failures:
 print('\n'.join('FAIL '+x for x in failures));raise SystemExit(1)
print(f'3.16.2 refresh matrix passed: {len(results)} runs (desktop and mobile), no page errors or network.')
