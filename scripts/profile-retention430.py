"""Controlled MBA-430 profiles: frozen 3.25.1, pinned native Prebid, no live traffic.

This script changes only test-page pbjs settings. It does not recommend or install
a production policy. Raw heap/CPU profiles stay in the local output directory.
"""
import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.parse
from playwright.sync_api import sync_playwright
from retention430_metrics import heap_objects, cpu_samples, matched_pair

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = 'https://retention430.example.invalid'
NOW = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
POLICIES = {
    'default': {},
    'events-only': {'eventHistoryTTL': 120},
    'bids-only': {'minBidCacheTTL': 0, 'minTargetedBidCacheTTL': 0},
    'bounded': {'minBidCacheTTL': 0, 'minTargetedBidCacheTTL': 0, 'eventHistoryTTL': 120},
}
COLLECT = """()=>{
 const p=__retention430,events=pbjs.getEvents();
 return {at:Date.now(),counts:{...p.counts},rounds:{...p.rounds},pendingRenders:p.pendingRenders,
  dispatches:p.dispatches.splice(0),wire:p.wire.splice(0),renders:p.renders.splice(0),
  nativePool:Object.fromEntries(['Billboard','P1'].map(code=>[code,pbjs.getBidResponsesForAdUnitCode(code).bids.length])),
  eventCount:events.length,eventTypes:events.reduce((counts,event)=>(counts[event.eventType]=(counts[event.eventType]||0)+1,counts),{}),
  cache:window.__tesseraBidCache?.snapshot?.()||null,
  settings:Object.fromEntries(['minBidCacheTTL','minTargetedBidCacheTTL','eventHistoryTTL','ttlBuffer','auctionOptions'].map(key=>[key,pbjs.getConfig(key)??null]))};
}"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def settle(page):
    for _ in range(300):
        if page.evaluate('__inflight430') == 0:
            page.wait_for_timeout(3)
            if page.evaluate('__inflight430') == 0:
                return
        page.wait_for_timeout(5)
    raise AssertionError('Synthetic transport did not settle')


def tick(page, milliseconds):
    if milliseconds > 0:
        page.clock.run_for(milliseconds)
    settle(page)


def wait_count(page, key, expected):
    # The first dwell begins after the frozen loader's delayed refresh setup
    # and geometry fallback, not at the first GAM request. Keep 100-ms steps
    # through that initial offset so native HTTP settles before its deadline.
    for _ in range(150):
        actual = page.evaluate(f'__retention430.counts.{key}')
        if actual >= expected:
            assert actual == expected, (key, actual, expected)
            return
        tick(page, 100)
    raise AssertionError(('Missing opportunity/render', key, expected, page.evaluate(COLLECT)))


def rendered_dom(page):
    return page.evaluate("""()=>{
      function count(doc,depth){
       if(!doc||depth>5)return 0;let n=doc.querySelectorAll('[data-retention430-creative]').length;
       for(const frame of doc.querySelectorAll('iframe'))try{n+=count(frame.contentDocument,depth+1);}catch(_){}
       return n;
      }return count(document,0);
    }""")


def open_page(browser, manifest, fixtures, version, label, policy, *, idle=False, auto=True,
              ttl=120, buffer=None, suppressed=None):
    context = browser.new_context(viewport={'width':1440,'height':1000}, service_workers='block', timezone_id='UTC')
    page = context.new_page()
    errors, escaped = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    folder = fixtures / version / label
    def route(request):
        url = request.request.url
        if url == ORIGIN + '/page':
            slots = '' if idle else '<div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div>'
            request.fulfill(content_type='text/html', body='<!doctype html><html><head><script src="/prebid.js"></script><script defer src="/ads.min.js"></script></head><body>'+slots+'</body></html>')
        elif url in (ORIGIN+'/prebid.js', ORIGIN+'/ads.min.js'):
            request.fulfill(content_type='application/javascript', body=(folder / url.rsplit('/',1)[1]).read_bytes())
        elif url.startswith(ORIGIN + '/bid?'):
            rows = json.loads(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['payload'][0])
            bids = [{**row,'mediaType':'banner','creativeId':'synthetic','currency':'EUR','netRevenue':True,
                     'ad':'<div data-retention430-creative>Retention430 synthetic creative</div>',
                     'meta':{'advertiserDomains':['example.invalid']}} for row in rows]
            request.fulfill(content_type='application/json', body=json.dumps({'bids':bids}))
        elif url == 'https://prebid-professor.mbaucal.workers.dev/geo/v1/country':
            request.fulfill(content_type='application/json', headers={'access-control-allow-origin':'*'},body=json.dumps({'known':True,'country':'RS','source':'synthetic'}))
        elif url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
            request.fulfill(content_type='application/json', headers={'access-control-allow-origin':'*'},body=json.dumps({'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'EUR':1,'USD':1}}}))
        else:
            escaped.append(url)
            request.abort()
    context.route('**/*', route)
    options = {'policy':policy,'bidTTL':ttl,'ttlBuffer':buffer,'suppressExpiredRender':suppressed,
               'autoRender':auto,'renderDelayMs':8000,'bidUrl':ORIGIN+'/bid'}
    fixture = (ROOT/'tests/runtime/retention430-browser-fixture.js').read_text()
    page.clock.install(time=NOW)
    page.clock.pause_at(NOW+timedelta(seconds=1))
    page.add_init_script('window.__retention430Options='+json.dumps(options)+';\n'+fixture)
    page.goto(ORIGIN+'/page')
    client = context.new_cdp_session(page)
    client.send('Performance.enable')
    if not idle:
        wait_count(page,'gam',2)
        if auto:
            delay = page.evaluate('__retention430.lastDispatchAt+8050-Date.now()')
            tick(page,max(0,delay))
            for _ in range(100):
                if page.evaluate('__retention430.counts.rendered') == 2:
                    break
                page.wait_for_timeout(10)
            assert page.evaluate('__retention430.counts.rendered') == 2, page.evaluate(COLLECT)
    else:
        tick(page,1000)
    assert page.evaluate('pbjs.version') == 'v'+version
    for key,value in policy.items():
        assert page.evaluate('(key)=>pbjs.getConfig(key)',key) == value, ('Policy was overwritten',key)
    return context,page,client,errors,escaped


def next_opportunity(page, number):
    # Advance mostly through idle time, then let the real network callback settle
    # before the native 800-ms auction deadline. Never synthesize a GPT dispatch.
    wait = page.evaluate('__retention430.lastDispatchAt+30000-Date.now()-500')
    tick(page,max(0,wait))
    wait_count(page,'gam',number*2)
    delay = page.evaluate('__retention430.lastDispatchAt+8050-Date.now()')
    tick(page,max(0,delay))
    for _ in range(100):
        if page.evaluate('__retention430.counts.rendered') == number*2:
            return
        page.wait_for_timeout(10)
    raise AssertionError(('Native creative did not render',number,page.evaluate(COLLECT)))


def heap_snapshot(client, path):
    chunks = []
    callback = lambda message: chunks.append(message['chunk'])
    client.on('HeapProfiler.addHeapSnapshotChunk', callback)
    client.send('HeapProfiler.takeHeapSnapshot', {'reportProgress':False,'captureNumericValue':True})
    client.remove_listener('HeapProfiler.addHeapSnapshotChunk', callback)
    path.write_text(''.join(chunks))
    return heap_objects(json.loads(path.read_text()))


def run_profile(browser, manifest, fixtures, out, version, cache, policy_name, pacing, repeat, opportunities, warmup):
    idle = pacing == 'idle'
    label = ('long' if idle or pacing=='steady' else pacing)+'-'+('on' if cache else 'off')
    policy = POLICIES[policy_name]
    case = f'{version}-{pacing}-{policy_name}-'+('on' if cache else 'off')+f'-r{repeat}'
    context,page,client,errors,escaped = open_page(browser,manifest,fixtures,version,label,policy,idle=idle)
    gam_ids, wire_ids, bid_ids = set(),set(),set()
    dispatches, wire_counts, snapshots = Counter(),Counter(),[]
    primary_cpms={code:[] for code in ['Billboard','P1']}
    peak_queue, cpu_start, cpu = 0,None,None
    def sample(index, detailed=None):
        nonlocal peak_queue
        observation = page.evaluate(COLLECT)
        peak_queue = max(peak_queue,len(observation['dispatches'])+len(observation['wire'])+len(observation['renders']))
        for row in observation.pop('dispatches'):
            identity = (row['code'],row['at'])
            assert identity not in gam_ids, ('Duplicate GAM opportunity',identity)
            gam_ids.add(identity);dispatches[row['code']] += 1
            assert row['bidId'] and row['bidCode'] == row['code'], ('Unowned/missing primary',row)
            primary_cpms[row['code']].append(row['cpm'])
            unique = {value for values in row['targets'].values() for value in values}
            for value in unique:
                assert (row['code'],value) not in bid_ids, ('Previously submitted bid resent',row['code'],value)
                bid_ids.add((row['code'],value))
        for row in observation.pop('wire'):
            identity = (row['bidder'],row['code'],row['round'])
            assert identity not in wire_ids, ('Duplicate bidder opportunity',identity)
            wire_ids.add(identity);wire_counts[row['bidder']+':'+row['code']] += 1
        renders = observation.pop('renders')
        assert not [row for row in renders if row['kind'] in ['expiredRender','adRenderFailed']], renders
        if cache and not idle:
            assert observation['cache']['status'] == 'active', observation['cache']
            assert observation['cache']['trackedAuctions'] <= 64
            assert observation['cache']['trackedBids'] <= 512
        # No browser-side observation object survives the sample except scalar
        # counters. Full rows/IDs are retained only in the Python process.
        client.send('HeapProfiler.collectGarbage')
        observation.update(index=index,dispatchesByCode=dict(dispatches),wireByCode=dict(wire_counts),
            heapAfterGC=client.send('Runtime.getHeapUsage'),dom=client.send('Memory.getDOMCounters'),
            performance={row['name']:row['value'] for row in client.send('Performance.getMetrics')['metrics']
                         if row['name'] in ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration']})
        if detailed:
            observation['heapObjects'] = heap_snapshot(client,out/(case+f'-{detailed}.heapsnapshot'))
        snapshots.append(observation)
        return observation
    try:
        initial = sample(0)
        target = min(opportunities,21) if pacing == 'cap20' else opportunities
        profile_start=min(target,warmup)
        if idle:
            tick(page,warmup*30000);start=sample(warmup,'warmup')
        else:
            for number in range(2,min(target,warmup)+1):
                next_opportunity(page,number)
                if number % 10 == 0:sample(number)
            start=sample(profile_start,'warmup')
        client.send('Profiler.enable');client.send('Profiler.setSamplingInterval',{'interval':1000});client.send('Profiler.start')
        cpu_start=time.monotonic()
        if idle:
            tick(page,(opportunities-warmup)*30000)
        else:
            for number in range(profile_start+1,target+1):
                next_opportunity(page,number)
                if number % 20 == 0:sample(number)
            if pacing == 'cap20':
                # Same document duration after reaching the unchanged 20-refresh cap.
                tick(page,max(0,opportunities*30000-page.evaluate('Date.now()')+int(NOW.timestamp()*1000)))
        cpu=client.send('Profiler.stop')['profile'];wall=time.monotonic()-cpu_start
        write_json(out/(case+'.cpuprofile'),cpu)
        final=sample(target if not idle else opportunities,'final')
        if idle:assert final['counts']['gam'] == 0 and final['counts']['auctions'] == 0
        else:
            assert final['counts']['gam'] == target*2
            assert final['counts']['rendered'] == target*2
            assert final['counts']['renderFailed'] == 0 and final['counts']['expired'] == 0
            assert all(count == target for count in wire_counts.values()) and len(wire_counts) == 4
            cycle=[10,4,2,12] if cache else [10,1,2,12]
            expected=[cycle[index%4] for index in range(target)]
            assert all(cpms==expected for cpms in primary_cpms.values()),('Cache competition differs from synthetic demand',primary_cpms)
        assert not errors,errors
        assert not escaped,escaped
        source = manifest['versions'][version]['packages'][label]
        result = {'case':case,'prebidVersion':version,'cache':cache,'policy':policy_name,'testOnlySettings':policy,
                  'pacing':pacing,'repeat':repeat,'opportunities':target,'warmupOpportunities':profile_start,
                  'inputWithoutCacheSha256':source['inputWithoutCacheSha256'],'programSha256':source['adsSha256'],
                  'initial':initial,'afterWarmup':start,'final':final,'samples':snapshots,
                  'cpu':cpu_samples(cpu),'measuredWallSeconds':wall,'fixturePeakQueuedScalarRows':peak_queue,
                  'primaryCpmSequence':primary_cpms,'virtualElapsedMs':final['at']-initial['at'],
                  'noDuplicateGam':True,'noDuplicateBidderRequests':True,'noResentSubmittedBid':True,
                  'errors':errors,'blockedUnexpectedRequests':escaped}
        write_json(out/(case+'.json'),result)
        print(json.dumps({'case':case,'gam':final['counts']['gam'],'pool':final['nativePool'],'events':final['eventCount'],
                          'heap':final['heapAfterGC']['usedSize'],'bidShaped':final['heapObjects']['bidShapedObjects']}),flush=True)
        return result
    finally:
        context.close()


def run_late(browser, manifest, fixtures, out, version, name, policy, delay, ttl, buffer, suppressed):
    context,page,client,errors,escaped=open_page(browser,manifest,fixtures,version,'static-on',policy,auto=False,
        ttl=ttl,buffer=buffer,suppressed=suppressed)
    try:
        first=page.evaluate('__retention430.dispatches.find(row=>row.code==="Billboard")')
        before=page.evaluate('(id)=>{const b=pbjs.getBidResponseByAdId(id);return {id:b.adId,ttl:b.ttl,responseAt:b.responseTimestamp,buffer:b.ttlBuffer??pbjs.getConfig("ttlBuffer")};}',first['bidId'])
        tick(page,max(0,before['responseAt']+delay*1000-page.evaluate('Date.now()')))
        page.evaluate('(id)=>__retention430.render(id,"Billboard")',first['bidId'])
        for _ in range(100):
            if page.evaluate('__retention430.counts.expired' if suppressed else '__retention430.counts.rendered+__retention430.counts.renderFailed'):
                page.wait_for_timeout(50);break
            page.wait_for_timeout(10)
        state=page.evaluate(COLLECT)
        dom=rendered_dom(page)
        attempts=[row for row in state['renders'] if row['kind']=='attempt']
        assert len(attempts)==1 and attempts[0]['ttl'] in [ttl,None]
        assert not errors,errors
        assert not escaped,escaped
        # Preserve the bidder's original TTL; never make it larger to pass a render.
        assert before['ttl']==ttl
        if delay < ttl-buffer:
            assert state['counts']['rendered']==1 and state['counts']['expired']==0 and dom>0,state
        elif suppressed:
            assert state['counts']['expired']==1 and state['counts']['rendered']==0 and dom==0,state
        elif attempts[0]['found']:
            assert state['counts']['expired']==1 and state['counts']['rendered']==1 and dom>0,state
        else:
            assert state['counts']['renderFailed']==1 and state['counts']['rendered']==0 and dom==0,state
        result={'case':name,'prebidVersion':version,'delaySeconds':delay,'originalBidTTLSeconds':ttl,'ttlBufferSeconds':buffer,
                'testOnlyPolicy':policy,'testOnlySuppressExpiredRender':suppressed,'before':before,
                'renderedCreativeElements':dom,'state':state,'passed':True}
        write_json(out/(version+'-'+name+'.json'),result)
        print(json.dumps({'late':name,'prebid':version,'counts':state['counts'],'found':attempts[0]['found']}),flush=True)
        return result
    finally:context.close()


def run_buffer(browser,manifest,fixtures,out,version):
    context,page,client,errors,escaped=open_page(browser,manifest,fixtures,version,'long-on',{},auto=False,ttl=40,buffer=10)
    try:
        cached=page.evaluate('()=>Object.fromEntries(["Billboard","P1"].map(code=>{const bid=pbjs.getBidResponsesForAdUnitCode(code).bids.find(b=>b.cpm===4);return [code,{responseAt:bid.responseTimestamp,ttl:bid.ttl}];}))')
        tick(page,max(0,page.evaluate('__retention430.lastDispatchAt+30000-Date.now()-500')))
        wait_count(page,'gam',4)
        state=page.evaluate(COLLECT)
        ages={}
        for code in ['Billboard','P1']:
            rows=[row for row in state['dispatches'] if row['code']==code]
            assert len(rows)==2 and [row['cpm'] for row in rows]==[10,1],rows
            assert all(row['ttl']==40 for row in rows)
            assert rows[0]['bidAuction']!=rows[1]['bidAuction']
            ages[code]=(rows[1]['at']-cached[code]['responseAt'])/1000
            assert 30<=ages[code]<cached[code]['ttl']==40,('Buffer probe must be inside original SSPTTL',code,ages[code])
        assert state['settings']['ttlBuffer']==10
        assert not errors and not escaped,(errors,escaped)
        result={'case':'ttl-buffer-10-selection','prebidVersion':version,'passed':True,'state':state,
                'cachedResponseAgeSecondsAtNextTarget':ages,
                'meaning':'TTL40 minus native buffer10 excludes cached4 before original TTL40 at the nominal30s-dwell refresh; fresh1 wins. First dwell includes loader setup.'}
        write_json(out/(version+'-ttl-buffer-10-selection.json'),result)
        return result
    finally:context.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixtures',type=Path)
    parser.add_argument('--out',type=Path,default=ROOT/'.generated/retention430-profile')
    parser.add_argument('--opportunities',type=int,default=120)
    parser.add_argument('--warmup',type=int,default=20)
    parser.add_argument('--repetitions',type=int,default=2)
    parser.add_argument('--versions',nargs='+',default=['11.11.0','11.34.0'])
    parser.add_argument('--quick',action='store_true',help='One short baseline pair, one version; not long-page evidence.')
    parser.add_argument('--phase',choices=['all','profile','late'],default='all')
    parser.add_argument('--measurement-context',default='Shared host; timing is diagnostic, not a controlled CPU comparison.')
    args=parser.parse_args()
    assert not (args.quick and args.phase=='late'),'Choose the quick cache pair or the late-render phase.'
    assert importlib.metadata.version('playwright')=='1.55.0','Use pinned Playwright1.55.0 for comparable evidence.'
    if args.quick:args.opportunities,args.warmup,args.repetitions,args.versions=8,3,1,[args.versions[0]]
    assert 1<=args.warmup<args.opportunities<=150 and 1<=args.repetitions<=3
    fixtures=args.fixtures.resolve();out=args.out.resolve()
    assert not out.exists() or not any(out.iterdir()),'Use an empty output directory to prevent mixed receipts.'
    out.mkdir(parents=True,exist_ok=True)
    harness_names=['scripts/prepare-retention430-fixtures.mjs','scripts/profile-retention430.py',
                   'scripts/retention430_metrics.py','tests/runtime/retention430-browser-fixture.js']
    harness_hashes={name:digest((ROOT/name).read_bytes()) for name in harness_names}
    environment={'startedAtUTC':datetime.now(timezone.utc).isoformat(),'hostLoadAtStart':list(os.getloadavg()),
                 'logicalCPUs':os.cpu_count(),'context':args.measurement_context,
                 'instrumentation':'CDP sampling, per-20-opportunity GC, two detailed heap snapshots, synthetic clock.'}
    manifest=json.loads((fixtures/'manifest.json').read_text())
    for name,expected in manifest['files'].items():assert digest((fixtures/name).read_bytes())==expected,('Changed package',name)
    runs,late,pairs=[],[],[]
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
        assert browser.version=='140.0.7339.16',('Unexpected pinned Chromium',browser.version)
        environment.update(playwrightVersion=importlib.metadata.version('playwright'),chromiumVersion=browser.version)
        try:
            for version in args.versions:
                for repeat in ([] if args.phase=='late' else range(1,args.repetitions+1)):
                    for policy in (['default'] if args.quick else ['default','bounded']):
                        cache_order=[False,True] if repeat%2 else [True,False]
                        current={}
                        for cache in cache_order:
                            row=run_profile(browser,manifest,fixtures,out,version,cache,policy,'long',repeat,args.opportunities,args.warmup)
                            runs.append(row);current[cache]=row
                        pairs.append(matched_pair(current[False],current[True]))
                if not args.quick and args.phase!='late':
                    runs.append(run_profile(browser,manifest,fixtures,out,version,False,'default','idle',1,args.opportunities,args.warmup))
                    for policy in ['events-only','bids-only']:
                        runs.append(run_profile(browser,manifest,fixtures,out,version,True,policy,'long',1,args.opportunities,args.warmup))
                    controls={}
                    for cache in [False,True]:
                        controls[cache]=run_profile(browser,manifest,fixtures,out,version,cache,'default','cap20',1,args.opportunities,args.warmup)
                        runs.append(controls[cache])
                    pairs.append(matched_pair(controls[False],controls[True]))
                    steady={}
                    for cache in [False,True]:
                        steady[cache]=run_profile(browser,manifest,fixtures,out,version,cache,'bounded','steady',1,150,120)
                        runs.append(steady[cache])
                    pairs.append(matched_pair(steady[False],steady[True]))
                if not args.quick and args.phase!='profile':
                    late.append(run_buffer(browser,manifest,fixtures,out,version))
                    cases=[
                        ('valid-108-default',{},108,120,10,None),('valid-108-bounded',POLICIES['bounded'],108,120,10,None),
                        ('within-original-ttl-115-default',{},115,120,10,None),
                        ('within-original-ttl-115-bounded',POLICIES['bounded'],115,120,10,None),
                        ('buffered-expiry-115-suppressed',POLICIES['bounded'],115,120,10,True),
                        ('expired-130-default',{},130,120,10,None),('expired-130-bounded',POLICIES['bounded'],130,120,10,None),
                        ('expired-130-default-suppressed',{},130,120,10,True),
                        ('short-ttl-valid-25-bounded',POLICIES['bounded'],25,40,10,None)]
                    for case,policy,delay,ttl,buffer,suppressed in cases:
                        late.append(run_late(browser,manifest,fixtures,out,version,case,policy,delay,ttl,buffer,suppressed))
        finally:browser.close()
    assert harness_hashes=={name:digest((ROOT/name).read_bytes()) for name in harness_names},'Harness changed during measurement'
    environment.update(completedAtUTC=datetime.now(timezone.utc).isoformat(),hostLoadAtEnd=list(os.getloadavg()))
    report={'schemaVersion':1,'scope':'Controlled synthetic retention evidence only; no production policy or paid traffic',
        'baseCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'runtime':manifest['runtime'],'nativeBuilds':manifest['versions'],'parameters':vars(args)|{'fixtures':str(fixtures),'out':str(out)},
        'harnessSha256':harness_hashes,'environment':environment,
        'matchedPairs':pairs,'runs':runs,'lateRender':late,
        'limits':['Post-GC heap is the page/browser fixture, not exclusive Prebid footprint or a production budget.',
                  'CPU is synthetic sampled work with instrumentation. Virtual time does not model network/ad-server latency.',
                  'Repeated small creative markup and minimal synthetic CMP state do not model production payload diversity or iframe networking.',
                  'Native pool/event counts and heap object shapes describe retention; none extend original SSP TTL.',
                  'No live GPT/PUC/SSP accounting, paid revenue, production fill, or publisher traffic was measured.']}
    write_json(out/'summary.json',report)
    print(json.dumps({'completed':True,'runs':len(runs),'pairs':len(pairs),'lateCases':len(late),'summary':str(out/'summary.json')}),flush=True)


if __name__=='__main__':main()
