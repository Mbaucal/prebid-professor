"""MAIN reporting packages: native Prebid and offline real-GPT wire verification.

The canonical QA-only loader actually selects A (fresh-only) or B (cache) and
applies slot Variant labels. Google and SSP HTTP never leave the fixture. The
native GPT layer proves real query serialization, not server acceptance/revenue.
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT/'.generated/runtime325-browser'
MANIFEST=json.loads((OUT/'manifest.json').read_text())
GPT_ROOT=ROOT/'vendor/gpt/m202611120201'
for name,digest in MANIFEST['files'].items():
    assert hashlib.sha256((OUT/name).read_bytes()).hexdigest()==digest,('Changed package',name)
GPT={entry['url']:GPT_ROOT/entry['file'] for entry in MANIFEST['gpt']['files']}
for entry in MANIFEST['gpt']['files']:
    assert hashlib.sha256((GPT_ROOT/entry['file']).read_bytes()).hexdigest()==entry['sha256']
MOCK=(ROOT/'tests/runtime/mock-ad-libraries.js').read_text()
MOCK=MOCK[:MOCK.index('  window.pbjs = {')]+MOCK[MOCK.index('  window.__testAds ='):]
ORIGIN='https://reporting.example.invalid'
PAGE=ORIGIN+'/fixture'
BID=ORIGIN+'/synthetic-bid'
NOW=datetime(2026,11,17,12,tzinfo=timezone.utc)
KEYS=['aq_bid_origin','aq_first_request','aq_consent_wait']

SETUP=r'''
(()=>{
 const options=%OPTIONS%;window.__qaOptions=options;
 let randomSeed=424;Math.random=()=>{randomSeed=(randomSeed*16807)%2147483647;return (randomSeed-1)/2147483646;};
 window.__inflight=0;window.__wire=[];window.__dispatch=[];window.__sequence=[];window.__rounds={};window.__tcListeners=[];
 const nativeFetch=window.fetch.bind(window);window.fetch=(...args)=>{__inflight++;return nativeFetch(...args).finally(()=>__inflight--);};
 const xhrSend=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(...args){__inflight++;this.addEventListener('loadend',()=>__inflight--,{once:true});return xhrSend.apply(this,args);};
 window.__country='RS';window.__pageTargeting={};window.__cmpReady=options.delay===0;
 window.__AD_GEO={version:1,getSnapshot:()=>({version:1,status:'known',country:'RS',source:'cloudflare'}),ready:()=>Promise.resolve(__AD_GEO.getSnapshot())};
 window.adsKeywords={publisher_key:'preserved',aq_bid_origin:'forged',aq_first_request:'forged',aq_consent_wait:'forged'};
 const random=crypto.getRandomValues.bind(crypto);
 crypto.getRandomValues=function(values){
  if(values instanceof Uint32Array&&values.length===1&&document.currentScript?.src.includes('/loader/')){values[0]=options.arm==='A'?0:4294967295;return values;}
  return random(values);
 };
 window.__tcfapi=(command,version,callback)=>{
  const data=()=>__cmpReady?{gdprApplies:false,listenerId:1,eventStatus:'tcloaded',cmpStatus:'loaded'}:
   {gdprApplies:true,listenerId:1,eventStatus:'cmpuishown',cmpStatus:'loaded'};
  if(command==='addEventListener'){__tcListeners.push(callback);callback(data(),true);}
  else if(command==='getTCData')callback(data(),true);
  else if(command==='ping')callback({cmpLoaded:true,gdprApplies:__cmpReady?false:true,cmpStatus:'loaded'},true);
  else callback(true);
 };
 window.__releaseConsent=()=>{__cmpReady=true;window.__consentReleasedAt=performance.now();for(const cb of __tcListeners)cb({gdprApplies:false,listenerId:1,eventStatus:'useractioncomplete',cmpStatus:'loaded'},true);};
 window.__revokeConsent=()=>{__cmpReady=false;window.__consentRevokedAt=performance.now();for(const cb of __tcListeners)cb({gdprApplies:true,listenerId:1,eventStatus:'cmpuishown',cmpStatus:'loaded'},true);};
 window.__readyUpdate=()=>{window.__consentUpdatedAt=performance.now();for(const cb of __tcListeners)cb({gdprApplies:false,listenerId:1,eventStatus:'useractioncomplete',cmpStatus:'loaded',tcString:'synthetic-new-decision'},true);};
 window.__observers=[];
 const NativeIO=window.IntersectionObserver;
 window.IntersectionObserver=class{
  constructor(callback,config){this.callback=callback;this.options=config||{};__observers.push(this);}
  observe(target){this.target=target;}unobserve(){}disconnect(){}
  fire(){this.callback([{target:this.target,isIntersecting:true,intersectionRatio:1}],this);}
 };
 window.__fireLazy=()=>{for(const observer of __observers)if(observer.target?.id==='P1')observer.fire();};
 window.__recordGpt=()=>{
  const service=googletag.pubads();
  if(options.gpt==='mock'){
   service.getTargeting=key=>__pageTargeting[key]===undefined?[]:[].concat(__pageTargeting[key]);
   service.getTargetingKeys=()=>Object.keys(__pageTargeting).filter(key=>__pageTargeting[key]!==null);
   service.setTargeting=(key,value)=>{__pageTargeting[key]=value;return service;};
   service.clearTargeting=key=>{delete __pageTargeting[key];return service;};
   googletag.setConfig=value=>Object.assign(__pageTargeting,value.targeting||{});
  }
  if(options.scenario==='page-primary'||options.scenario==='page-shadowed'){
   service.setTargeting('hb_adid','foreign-page-primary');service.setTargeting('hb_bidder','foreign-page-bidder');
  }
  const refresh=service.refresh;
  service.refresh=function(slots,settings){
   const pageKeys=Object.fromEntries((service.getTargetingKeys?.()||[]).map(key=>[key,service.getTargeting(key)]));
   const events=window.pbjs?.getEvents?.()||[];
   const received=events.filter(event=>event.eventType==='bidResponse').map(event=>event.args);
   const auctionIds=events.filter(event=>event.eventType==='auctionInit').map(event=>event.args.auctionId);
   const bid=id=>{const item=received.find(row=>row.adId===id);return item?{bidder:item.bidderCode,cpm:item.cpm,code:item.adUnitCode,auction:auctionIds.indexOf(item.auctionId)}:null;};
   const rows=(slots||[]).map(slot=>{
    const keys=Object.fromEntries(slot.getTargetingKeys().filter(key=>slot.getTargeting(key).length).map(key=>[key,slot.getTargeting(key)]));
    return {code:slot.getSlotElementId(),keys,bids:Object.fromEntries(Object.entries(keys).filter(([key])=>key==='hb_adid'||key.startsWith('hb_adid_')).map(([key,value])=>[key,bid(value[0])]))};
   });
   __sequence.push({type:'gam',codes:rows.map(row=>row.code)});
   __dispatch.push({at:performance.now(),page:pageKeys,slots:rows});
   return refresh.call(this,slots,settings);
  };
 };
 if(!window.googletag)window.googletag={cmd:[]};
 googletag.cmd.push(__recordGpt);
 if(options.kind==='gam'||options.scenario==='library-unavailable'){window.pbjs={version:'v'+options.prebidVersion,que:[]};return;}
 window.pbjs={que:[()=>{
  if(options.scenario==='activity-denied')pbjs.setConfig({allowActivities:{fetchBids:{rules:[{condition:()=>true,allow:false}]}}});
  for(const base of ['pubmatic','openx'])pbjs.registerBidAdapter(null,base,{
   code:base,gvlid:base==='pubmatic'?76:69,supportedMediaTypes:['banner'],isBidRequestValid:()=>true,
   buildRequests(bids,request){
    const payload=[];
    for(const bid of bids){
     const account=request.bidderCode,key=account+':'+bid.adUnitCode,round=(__rounds[key]||0)+1;__rounds[key]=round;
     __wire.push({bidder:account,code:bid.adUnitCode,round,auction:request.auctionId});
     __sequence.push({type:'ssp',bidder:account,code:bid.adUnitCode,round});
     let cpms=round===1?(account==='pubmatic'?[10,4]:account==='pm_ag'?[8,3]:[.5]):[];
     if(options.scenario==='primary-fresh'&&round===2&&account==='pubmatic')cpms=[9];
     if(options.scenario==='alias-primary')cpms=round===1?(account==='pm_ag'?[10,4]:account==='pubmatic'?[8,3]:[.5]):[];
     if(options.scenario==='mixed-batch'&&bid.adUnitCode==='P1')cpms=[];
     if(options.scenario==='no-bids'||options.scenario==='page-primary')cpms=[];
     for(const cpm of cpms)payload.push({requestId:bid.bidId,cpm,width:300,height:250,ttl:120,currency:'EUR',netRevenue:true,
      creativeId:'synthetic',ad:'<div>Local reporting QA only</div>',meta:{advertiserDomains:['example.invalid']}});
    }
    return {method:'GET',url:'%BID%',options:{withCredentials:false},data:{payload:JSON.stringify(payload),codes:JSON.stringify([...new Set(bids.map(bid=>bid.adUnitCode))])}};
   },interpretResponse:response=>response.body.bids,
  });
 }]};
})();
'''.replace('%BID%',BID)

def bucket(ms):
    for limit,value in [(500,'lt_500'),(1000,'500_999'),(1500,'1000_1499'),(2000,'1500_1999'),(3000,'2000_2999')]:
        if ms<limit:return value
    return '3000_plus'

def decode_gam(url):
    query=parse_qs(urlsplit(url).query)
    ids=query.get('dids',[''])[0].split('~')
    fields=query.get('prev_scp',[''])[0].split('|')
    return {'page':parse_qs(query.get('cust_params',[''])[0]),
      'slots':{ids[index]:parse_qs(values) for index,values in enumerate(fields) if index<len(ids)},'sra':query.get('sc')}

def advance(page,ms):
    remaining=ms
    while remaining>0:
        step=min(remaining,250);page.clock.run_for(step);remaining-=step
        pending=getattr(page,'_qa_pending_bids',[])
        if pending:
            now=page.evaluate('performance.now()')
            for due,request,payload in pending[:]:
                if now>=due:
                    request.fulfill(content_type='application/json',body=json.dumps({'bids':payload}));pending.remove((due,request,payload))
        page.wait_for_timeout(2)
        if not getattr(page,'_qa_pending_bids',[]):
            for _ in range(500):
                if page.evaluate('window.__inflight||0')==0:break
                page.wait_for_timeout(2)

def run(browser,version,options):
    context=browser.new_context(viewport={'width':options['width'],'height':900},timezone_id='UTC',service_workers='block')
    page=context.new_page();errors=[];blocked=[];gam_wire=[];served=[];held_loader=[]
    page._qa_pending_bids=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    folder=OUT/version/options['kind']
    if version=='3.25.0':
        # A conditional CDP breakpoint observes the actual gate-entry call without
        # editing the generated/SRI bytes or pausing execution. Virtual time does
        # not advance while DevTools evaluates this side-effect-only condition.
        source=(folder/'arms'/options['arm']/options['program']).read_text()
        entries=list(re.finditer(r'function enter\(ready(?:,\s*epoch)?\)\s*\{',source));assert len(entries)==1
        offset=entries[0].end()
        while source[offset].isspace():offset+=1
        before=source[:offset];line=before.count('\n');column=len(before.rsplit('\n',1)[-1])
        cdp=context.new_cdp_session(page);cdp.send('Debugger.enable')
        cdp.send('Debugger.setBreakpointByUrl',{'url':ORIGIN+f'/arms/{options["arm"]}/{options["program"]}',
          'lineNumber':line,'columnNumber':column,
          'condition':'window.__qaGate === undefined && (window.__qaGate={at:performance.now(),ready:ready}); false'})
    def route(request):
        url=request.request.url;path=urlsplit(url).path
        if url==PAGE:
            html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">'
            if options['gpt']=='real':html+='<script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>'
            if options['kind']!='gam' and options['scenario']!='library-unavailable':html+='<script src="/prebid.js"></script>'
            html+=f'<script defer src="/loader/{options["program"]}"></script></head><body style="margin:0">'
            if options['kind']!='lazy':html+='<div id="Billboard" class="wrapperAd" style="height:250px"></div>'
            html+='<div id="P1" class="wrapperAd'+(' lazyAd' if 'lazy' in options['kind'] else '')+'" style="height:250px"></div>'
            request.fulfill(content_type='text/html',body=html+'<main style="height:2000px"></main></body></html>')
        elif url==ORIGIN+'/prebid.js':request.fulfill(content_type='application/javascript',body=(folder/'prebid.js').read_bytes())
        elif url.startswith(ORIGIN+'/loader/') or url.startswith(ORIGIN+'/arms/'):
            relative=path.lstrip('/');served.append(relative)
            if options['scenario']=='late-script' and '/loader/' in url:held_loader.append((request,relative))
            else:request.fulfill(content_type='application/javascript',body=(folder/relative).read_bytes())
        elif url.startswith(BID+'?'):
            query=parse_qs(urlsplit(url).query);payload=json.loads(query['payload'][0]);codes=json.loads(query['codes'][0])
            # Explicit synthetic response ordering makes the paired comparison
            # deterministic despite independent initial slot auctions. It does
            # not change either generated runtime's scheduler or request count.
            delay=(200 if 'P1' in codes else 0)+(500 if options['scenario']=='ssp-slow' else 2200 if options['kind']=='revoke-first' else 0)
            if delay:page._qa_pending_bids.append((page.evaluate('performance.now()')+delay,request,payload))
            else:request.fulfill(content_type='application/json',body=json.dumps({'bids':payload}))
        elif url in GPT:request.fulfill(content_type='application/javascript',body=GPT[url].read_bytes())
        elif '/gampad/ads?' in url:
            gam_wire.append(decode_gam(url));request.fulfill(status=204,body='')
        elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
            request.fulfill(content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'USD':1,'EUR':1}}}))
        else:
            blocked.append(url);request.abort()
    context.route('**/*',route)
    page.clock.install(time=NOW);page.clock.pause_at(NOW+timedelta(seconds=1))
    setup=SETUP.replace('%OPTIONS%',json.dumps({**options,'prebidVersion':MANIFEST['prebid']['version']}))
    page.add_init_script((MOCK+'\n' if options['gpt']=='mock' else '')+setup)
    page.goto(PAGE,wait_until='commit' if options['scenario']=='late-script' else 'load')
    if options['scenario']=='late-script':
        for _ in range(500):
            if held_loader:break
            page.wait_for_timeout(2)
        assert held_loader,'The delayed loader request never arrived'
        advance(page,2000)
        for request,relative in held_loader:request.fulfill(content_type='application/javascript',body=(folder/relative).read_bytes())
    # Allow local static scripts/microtasks to finish without advancing virtual time.
    page.wait_for_function('window.AdVariant?.snapshot().status==="loaded"',timeout=15000)
    advance(page,1)
    if options['delay']:
        if version=='3.25.0':
            for _ in range(160):
                if page.evaluate('window.__qaGate!==undefined'):break
                advance(page,25)
            gate=page.evaluate('window.__qaGate');assert gate is not None,('No existing consent gate entry',options)
            assert not gate['ready'],gate
            release_at=gate['at']+options['delay']
        else:release_at=options.get('forcedReleaseAt',options['delay'])
        remaining=release_at-page.evaluate('performance.now()')
        if remaining>0:advance(page,remaining)
        assert page.evaluate('__dispatch.length')==0,('Pending CMP sent GAM',options)
        assert page.evaluate('__wire.length')==0,('Pending CMP sent SSP',options)
        page.evaluate('__releaseConsent()')
    if options['kind']=='revoke-first':
        for _ in range(160):
            if page.evaluate('__wire.length>0'):break
            advance(page,25)
        assert page.evaluate('__wire.length>0'),'Synthetic SSP wait did not start'
        advance(page,2000)
        assert page.evaluate('__dispatch.length')==0,'The synthetic response hold must precede the first GAM request'
        if options['scenario']=='revoke-before-first':
            page.evaluate('__revokeConsent()');advance(page,100)
            assert page.evaluate('__dispatch.length')==0,'Revocation let the first GAM request through before a new valid decision'
            page.evaluate('__releaseConsent()')
        else:page.evaluate('__readyUpdate()')
    if options['kind']=='lazy':
        advance(page,3001)
        assert page.evaluate('__dispatch.length')==0,'Lazy slot sent while not visible'
        page.evaluate('__fireLazy()')
    advance(page,1500)
    if options['kind']=='late-lazy':
        initial=page.evaluate('__dispatch.length');assert initial>0
        advance(page,3000);page.evaluate('__fireLazy()');advance(page,1500)
    if options.get('refresh',True) and options['kind'] not in ['lazy','late-lazy']:
        advance(page,68000)
    state=page.evaluate('''()=>({dispatch:__dispatch,wire:__wire,sequence:__sequence,assignment:AdVariant.snapshot(),
      cache:window.__tesseraBidCache?.snapshot(),consentReleasedAt:window.__consentReleasedAt,
      readiness:window.__tesseraReadiness?.snapshot(),gate:window.__qaGate,
      consentRevokedAt:window.__consentRevokedAt,consentUpdatedAt:window.__consentUpdatedAt})''')
    context.close()
    return {**options,'version':version,**state,'gamWire':gam_wire,'errors':errors,'blocked':blocked,'served':served,
      'runtimeNetworkPassedThrough':0}

def scalar(values):
    return values[0] if isinstance(values,list) and values else values

def validate(result):
    assert not result['errors'],result['errors']
    assert result['assignment']['variant']==result['arm'] and result['assignment']['runtimeEntries']==1,result['assignment']
    assert result['assignment']['prebidVersion']==MANIFEST['prebid']['version'],result['assignment']
    assert result['assignment']['targetingFailures']==0,result['assignment']
    expected_path=f'arms/{result["arm"]}/{result["program"]}'
    assert expected_path in result['served'] and not any(f'arms/{"B" if result["arm"]=="A" else "A"}/' in name for name in result['served'])
    sent=result['dispatch'];assert sent,('No GAM dispatch',result)
    if result['version']=='3.24.0':return
    page=sent[0]['page'];assert scalar(page.get('aq_first_request'))==bucket(sent[0]['at']),(result['scenario'],sent[0])
    expected_wait='timeout' if result['kind']=='timeout' and result['delay']>=1000 else bucket(result['delay'])
    assert scalar(page.get('aq_consent_wait'))==expected_wait,(result['scenario'],page,expected_wait)
    for batch in sent:
        assert batch['page'].get('aq_first_request')==page.get('aq_first_request') and batch['page'].get('aq_consent_wait')==page.get('aq_consent_wait')
        assert not batch['page'].get('aq_bid_origin'),'Slot origin leaked as page default'
        for row in batch['slots']:
            assert row['keys'].get('Variant')==[result['arm']],row
            assert not row['keys'].get('aq_first_request') and not row['keys'].get('aq_consent_wait'),'Page metrics leaked as slot overrides'
            origin=scalar(row['keys'].get('aq_bid_origin'))
            if result['kind'] in ['gam','empty-bidders'] or result['kind']=='mixed-gam' and row['code']=='P1':assert origin is None,row
            elif not row['keys'].get('hb_adid'):
                if result['scenario'] in ['page-primary','page-shadowed']:assert origin is None,row
                else:assert origin=='none',row
            else:
                primary=row['bids']['hb_adid'];assert primary,row
                assert origin in ['fresh','cached'],row
    if result['scenario'] in ['standard','alias-primary'] and result['kind']=='standard' and result.get('refresh',True):
        for code in ['Billboard','P1']:
            rows=[row for batch in sent for row in batch['slots'] if row['code']==code]
            assert len(rows)>=3,(result['gpt'],result['arm'],code,len(rows),sent)
            expected=['fresh','cached' if result['arm']=='B' else 'none','none']
            assert [scalar(row['keys'].get('aq_bid_origin')) for row in rows[:3]]==expected,(result['arm'],code,rows)
            if result['scenario']=='alias-primary':assert rows[0]['bids']['hb_adid']['bidder']=='pm_ag'
    if result['scenario']=='primary-fresh' and result['arm']=='B':
        for code in ['Billboard','P1']:
            rows=[row for batch in sent for row in batch['slots'] if row['code']==code]
            assert scalar(rows[1]['keys'].get('aq_bid_origin'))=='fresh',rows[1]
            assert rows[1]['bids']['hb_adid']['bidder']=='pubmatic' and rows[1]['bids'].get('hb_adid_pm_ag'),rows[1]
            assert rows[1]['bids']['hb_adid_pm_ag']['auction']<rows[1]['bids']['hb_adid']['auction'],'Missing cached secondary positive control'
    if result['scenario']=='page-shadowed':
        for code in ['Billboard','P1']:
            rows=[row for batch in sent for row in batch['slots'] if row['code']==code]
            assert [scalar(row['keys'].get('aq_bid_origin')) for row in rows[:3]]==['fresh','cached' if result['arm']=='B' else None,None],rows
    if result['gpt']=='real':
        assert result['gamWire'],('No genuine outgoing GPT request',result)
        requests=[row for batch in sent for row in batch['slots']]
        outgoing=[(batch['page'],code,fields) for batch in result['gamWire'] for code,fields in batch['slots'].items()]
        assert len(outgoing)==len(requests),(len(outgoing),len(requests),result['gamWire'])
        for (_,code,wire),row in zip(outgoing,requests):
            assert code==row['code'],(code,row)
            for key in ['Variant','hb_adid','hb_adid_pm_ag','hb_size','refresh_count','refresh_bucket','aq_bid_origin']:
                assert wire.get(key)==row['keys'].get(key),(key,wire,row)
        for wire in result['gamWire']:
            for key in ['aq_first_request','aq_consent_wait']:assert wire['page'].get(key)==page.get(key),(wire,page)
            assert not wire['page'].get('aq_bid_origin'),wire
            if result['scenario'] in ['page-primary','page-shadowed']:
                assert wire['page'].get('hb_adid')==['foreign-page-primary'] and wire['page'].get('hb_bidder')==['foreign-page-bidder'],wire

def behavior(result):
    def clean(row):
        keys={key:value for key,value in row['keys'].items() if key not in KEYS and not key.startswith('hb_adid')}
        return {'code':row['code'],'keys':keys,'bids':row['bids']}
    # Prebid intentionally randomizes bidders, and real GPT may consume the
    # shared random source. Compare SSP membership/count within one contiguous
    # SSP block; retain every GAM barrier, batch order and slot/round identity.
    sequence=[];pending=[]
    def flush():
        if pending:
            sequence.extend(sorted(pending,key=lambda row:(row['code'],row['round'],row['bidder'])));pending.clear()
    for item in result['sequence']:
        if item['type']=='ssp':pending.append(item)
        else:flush();sequence.append(item)
    flush()
    return {'sequence':sequence,'slots':[[clean(row) for row in batch['slots']] for batch in result['dispatch']],
      'page':[{key:value for key,value in batch['page'].items() if key not in KEYS} for batch in result['dispatch']]}

def main():
    results=[]
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'))
        programs=['ads.js','ads.min.js'];widths=[1440,390]
        options=[]
        for gpt in ['mock','real']:
            for arm in ['A','B']:
                for program in programs:
                    for width in widths:
                        options.append(dict(gpt=gpt,arm=arm,program=program,width=width,kind='standard',scenario='standard',delay=0))
        for arm in ['A','B']:
            for kind,scenario in [('standard','primary-fresh'),('standard','alias-primary'),('standard','no-bids'),('standard','activity-denied'),('standard','library-unavailable'),('standard','ssp-slow'),('mixed-gam','mixed-batch'),('gam','gam'),('empty-bidders','empty-bidders'),('lazy','lazy'),('late-lazy','late-lazy'),('timeout','timeout')]:
                options.append(dict(gpt='real',arm=arm,program='ads.min.js',width=390,kind=kind,scenario=scenario,delay=1500 if kind=='timeout' else 0))
            options.append(dict(gpt='real',arm=arm,program='ads.js',width=1440,kind='standard',scenario='late-script',delay=0,refresh=False))
            for scenario in ['revoke-before-first','ready-update-before-first']:
                options.append(dict(gpt='real',arm=arm,program='ads.min.js',width=390,kind='revoke-first',scenario=scenario,delay=0,refresh=False))
            for scenario in ['page-primary','page-shadowed']:
                options.append(dict(gpt='real',arm=arm,program='ads.min.js',width=390,kind='standard',scenario=scenario,delay=0))
            for delay in [499,500,999,1000,1499,1500,1999,2000,2999,3000]:
                options.append(dict(gpt='real',arm=arm,program='ads.js',width=1440,kind='standard',scenario='cmp-'+str(delay),delay=delay,refresh=False))
        if os.environ.get('RUNTIME325_QA_SMOKE'):
            options=options[:1]+[dict(gpt='real',arm='B',program='ads.min.js',width=390,kind='standard',scenario='standard',delay=0)]
        versions=sorted(MANIFEST['versions'],reverse=True)
        for item in options:
            pair=[]
            for version in versions:
                current={**item}
                if version=='3.24.0' and pair and pair[0].get('consentReleasedAt') is not None:current['forcedReleaseAt']=pair[0]['consentReleasedAt']
                try:
                    result=run(browser,version,current);validate(result)
                except Exception as error:
                    (OUT/'browser-results.json').write_text(json.dumps({'passed':len(results),'failed':1,'failedCase':{**current,'version':version},'error':str(error),'results':results},indent=2)+'\n')
                    raise
                results.append(result);pair.append(result)
                print('PASS',version,item['gpt'],item['arm'],item['program'],item['width'],item['scenario'],len(result['dispatch']),'dispatch',len(result['gamWire']),'genuine GPT queries',flush=True)
            if len(pair)==2:assert behavior(pair[0])==behavior(pair[1]),('Reporting changed existing SSP/GAM order/count/targeting',item,behavior(pair[0]),behavior(pair[1]))
        browser_version=browser.version;browser.close()
    report={'passed':len(results),'failed':0,'genuineGptQueries':sum(len(row['gamWire']) for row in results),'nativePrebid':MANIFEST['prebid']['version'],
      'browser':browser_version,'fixtureManifestSha256':hashlib.sha256((OUT/'manifest.json').read_bytes()).hexdigest(),
      'runtimeSourceHashes':{version:sorted({row['runtime']['codeSha256'] for row in MANIFEST['packages'] if row['version']==version}) for version in MANIFEST['versions']},
      'scope':'Generated MAIN programs, canonical QA A/B assignment, native Prebid, and real offline GPT. No request is passed to an ad server/SSP. Not server acceptance or revenue.',
      'controls':'Synthetic CMP and adapter responses; controlled IntersectionObserver delivery. The real-GPT layer uses exact pinned Google bytes, with every GAM response fulfilled locally as204.',
      'comparison':'Exact GAM barriers/batch order, per-slot rounds, SSP membership/count and preexisting targeting; only randomized SSP permutation inside one contiguous SSP block is normalized.',
      'results':results}
    (OUT/'browser-results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:value for key,value in report.items() if key!='results'}))

if __name__=='__main__':main()
