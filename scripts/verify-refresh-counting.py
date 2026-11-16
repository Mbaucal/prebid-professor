"""Native Chromium, actual generated scripts, synthetic ad libraries.
All external requests are aborted. No hosted account or paid ad traffic.
"""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/refresh-counting-evidence'
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
html = '<!doctype html><body style="margin:0"><div id="Billboard" class="wrapperAd" style="height:250px;width:300px"></div><div id="Sticky" class="wrapperAd"></div></body>'
setup = r'''
window.__counterRequests=[];window.__counterAuctions=[];
let data={gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'},callbacks=[];
window.__tcfapi=(command,version,callback)=>{
 if(command==='addEventListener'){callbacks.push(callback);callback(data,true);}
 else if(command==='getTCData')callback(data,true);
 else callback(true);
};
window.__counterConsent=ready=>{
 data=ready?{gdprApplies:false,cmpStatus:'loaded',eventStatus:'tcloaded'}:{gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown'};
 callbacks.slice().forEach(callback=>callback(data,true));
};
const actualRefresh=__testAds.service.refresh;
__testAds.service.refresh=function(slots,options){
 for(const slot of slots||[])__counterRequests.push({id:slot.id,at:Date.now(),count:slot.getTargeting('refresh_count')});
 return actualRefresh.call(this,slots,options);
};
const pbListeners=new Map();
pbjs.onEvent=(name,callback)=>{if(!pbListeners.has(name))pbListeners.set(name,new Set());pbListeners.get(name).add(callback);};
pbjs.offEvent=(name,callback)=>pbListeners.get(name)?.delete(callback);
pbjs.requestBids=input=>{
 __counterAuctions.push({at:Date.now(),codes:input.adUnits.map(unit=>unit.code)});
 for(const callback of pbListeners.get('auctionInit')||[])callback({auctionId:input.auctionId});
 setTimeout(()=>input.bidsBackHandler({},false,input.auctionId),200);
};
'''

def require(value, message):
    if not value:
        raise AssertionError(message)

def read(page, target='Billboard'):
    return page.evaluate('''target=>({count:adopsDebug.slot(target).refreshCount,
      requests:__counterRequests.filter(item=>item.id===target),auctions:__counterAuctions})''', target)

def run(browser, mode, name, before=False):
    page = browser.new_page(viewport={'width':1400,'height':900})
    errors, network = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: network.append(request.url) if request.url.startswith(('http:','https:')) else None)
    page.route('**/*', lambda route: route.abort())
    source = name if name in ['sequence','sticky','wall-gap','sticky-wall-gap'] else 'fixed'
    try:
        page.set_content(html)
        now = datetime(2026,10,24,tzinfo=timezone.utc)
        page.clock.install(time=now)
        page.clock.pause_at(now+timedelta(seconds=1))
        page.add_script_tag(content=mock)
        page.add_script_tag(content=setup)
        filename=f'{mode}-{source}-'+('before' if before else 'after')+'.js'
        page.add_script_tag(content=(out/filename).read_text())
        page.clock.run_for(5000)
        target = 'Sticky' if name.startswith('sticky') else 'Billboard'
        initial = read(page, target)
        require(len(initial['requests']) == 1, 'Expected exactly one initial request: '+json.dumps(initial))
        if name == 'viewport':
            page.set_viewport_size({'width':1200,'height':900})
            page.clock.run_for(100000)
            blocked=read(page,target)
            require(len(blocked['requests'])==1, 'Empty viewport unexpectedly requested an ad')
            if before:
                require(blocked['count']==3, 'Historical counter no longer reproduces three unsent cap steps')
                return {'historicalBadCount':blocked['count'],'requests':len(blocked['requests'])}
            require(blocked['count']==0, 'Unsent attempts consumed refresh cap')
            page.set_viewport_size({'width':1400,'height':900})
            page.clock.run_for(180000)
        elif name == 'batch-resize':
            deadline=page.evaluate('adopsDebug.slot("Billboard").state.dwellDeadline')
            remaining=page.evaluate('deadline=>deadline-Date.now()',deadline)
            require(remaining>0,'The initial dwell timer was not scheduled')
            # Advance100ms past the actual dwell callback, inside its2s batch
            # window. The next dwell deadline proves the callback ran.
            page.clock.run_for(remaining+100)
            require(page.evaluate('adopsDebug.slot("Billboard").state.dwellDeadline')>deadline,'The dwell callback did not run before resizing')
            require(read(page,target)['count']==0 and len(read(page,target)['requests'])==1, 'Attempt before dispatch was already counted or sent')
            page.set_viewport_size({'width':1200,'height':900})
            page.clock.run_for(100000)
            blocked=read(page,target)
            require(blocked['count']==0 and len(blocked['requests'])==1, 'Resize inside batch consumed a count')
            page.set_viewport_size({'width':1400,'height':900})
            page.clock.run_for(180000)
        elif name in ['cmp','wall-gap','sticky-wall-gap']:
            page.evaluate('__counterConsent(false)')
            page.clock.run_for(100000)
            blocked=read(page,target)
            require(blocked['count']==0 and len(blocked['requests'])==1, 'Pending CMP consumed cap or dispatched')
            page.evaluate('__counterConsent(true)')
            page.clock.run_for(400000 if name.endswith('wall-gap') else 180000)
        elif name in ['sequence','sticky']:
            page.clock.run_for(490000)
        else:
            page.clock.run_for(180000)
        data = read(page,target)
        require(data['count']==len(data['requests'])-1, 'Counter differs from actual sends: '+json.dumps(data))
        require(data['count']==(4 if name in ['sequence','sticky'] else 3), 'Wrong cap result: '+json.dumps(data))
        if name.endswith('wall-gap'):
            gaps=[data['requests'][i]['at']-data['requests'][i-1]['at'] for i in range(1,len(data['requests']))]
            require(all(gap>=100000 for gap in gaps),'Explicit100s wall-clock gap violated after CMP release: '+json.dumps({'gaps':gaps,'requests':data['requests']}))
        elif name in ['sequence','sticky']:
            refreshes = data['requests'][1:]
            gaps=[refreshes[i]['at']-refreshes[i-1]['at'] for i in range(1,len(refreshes))]
            for actual,expected in zip(gaps,[60000,120000,240000]):
                require(abs(actual-expected)<1000, 'Sequence step repeated or advanced without send: '+str(gaps))
        else:
            refreshes=data['requests'][1:]
            gaps=[refreshes[i]['at']-refreshes[i-1]['at'] for i in range(1,len(refreshes))]
            if name == 'cmp':
                # Preserve the established attempted-time cadence. A queued
                # refresh released by CMP at105s is followed by the existing
                # next tick near126s; moving lastRefreshAt to send time would
                # incorrectly delay that next request. Later gaps stay30s.
                require(19000<=gaps[0]<=23000 and all(abs(gap-30000)<1000 for gap in gaps[1:]), 'CMP resume changed request cadence: '+str(gaps))
            else:
                require(all(gap>=29000 for gap in gaps), 'Duplicate/short refresh cadence: '+str(gaps))
        require(not errors, 'Browser errors: '+str(errors))
        require(not network, 'Unexpected external network: '+str(network))
        return {'count':data['count'],'requestOffsets':[row['at']-data['requests'][0]['at'] for row in data['requests']], 'externalRequests':0}
    finally:
        page.close()

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    for mode in ['gam','prebid']:
        for name,before in [('viewport',True),('fixed',False),('viewport',False),('batch-resize',False),('cmp',False),('sequence',False),('sticky',False),('wall-gap',False),('sticky-wall-gap',False)]:
            label=mode+'-'+name+('-historical' if before else '')
            selected=os.environ.get('TESSERA_COUNTER_CASES')
            if selected and label not in selected.split(','):
                continue
            try:
                result=run(browser,mode,name,before)
                results.append({'name':label,'passed':True,**result})
                print('PASS',label,flush=True)
            except Exception as error:
                results.append({'name':label,'passed':False,'error':str(error)})
                print('FAIL',label,str(error),flush=True)
    browser.close()
report={'scope':'Native Chromium; generated code, synthetic GPT/Prebid/CMP, blocked network; no hosted or paid traffic',
        'passed':sum(item['passed'] for item in results),'failed':sum(not item['passed'] for item in results),'results':results}
(out/'browser-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
raise SystemExit(0 if report['failed']==0 else 1)
