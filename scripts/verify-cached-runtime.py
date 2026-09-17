"""Compiled new wrapper + actual pinned Prebid; all bids/GPT/CMP are synthetic."""
import hashlib,json,urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path('.generated/cache-runtime-evidence')
bundle=Path('vendor/prebid/tanjug-11.34.0/prebid.js').read_bytes()
assert hashlib.sha256(bundle).hexdigest()=='384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b'
mock=Path('tests/runtime/mock-ad-libraries.js').read_text()
fixture=Path('tests/runtime/cache-runtime-fixture.js').read_text()
checks=[];errors=[];external=[];calls=[];page_calls={};currency_fixtures=[]
html='<!doctype html><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="margin-top:5000px;height:250px"></div><div id="Overlay"></div>'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    def fresh(name='cached',ttl=300,no_cmp=False,late=False):
        page=browser.new_page(viewport={'width':1280,'height':900});page.set_default_timeout(10000)
        page_calls[page]=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        def route(r):
            if r.request.url=='https://cache-page.invalid/':r.fulfill(status=200,content_type='text/html',body=html);return
            if r.request.url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json?date='):
                currency_fixtures.append(1);r.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body=json.dumps({'conversions':{'USD':{'USD':1}}}));return
            if not r.request.url.startswith('https://cache-fixture.invalid/bid?'):
                external.append(r.request.url);r.abort();return
            rows=json.loads(urllib.parse.parse_qs(urllib.parse.urlparse(r.request.url).query)['payload'][0]);calls.extend(x['code'] for x in rows);page_calls[page].extend(x['code'] for x in rows)
            rows=[{**x,'creativeId':'synthetic','currency':'USD','netRevenue':True,'ad':'<div>Synthetic cache test</div>','meta':{'advertiserDomains':['example.invalid']}} for x in rows if x.get('cpm',0)>0]
            r.fulfill(status=200,headers={'content-type':'application/json','access-control-allow-origin':'*'},body=json.dumps({'bids':rows}))
        page.route('**/*',route);page.goto('https://cache-page.invalid/')
        page.add_script_tag(content=mock);page.add_script_tag(content=fixture)
        if no_cmp:page.evaluate('delete window.__tcfapi')
        page.add_script_tag(content=bundle.decode());page.evaluate('installFixtureAdapters()')
        if late:page.evaluate("""()=>{const native=pbjs.requestBids;pbjs.requestBids=function(input){if(!input.adUnits.some(u=>u.code==='P1'))return native.call(pbjs,input);const done=input.bidsBackHandler;return native.call(pbjs,{...input,bidsBackHandler:(...args)=>setTimeout(()=>done(...args),650)});};}""")
        page.evaluate('ttl=>{fixtureNext.pubmatic.ttl=ttl;fixtureNext.openx.ttl=ttl;}',ttl)
        page.evaluate("""()=>{window.__tesseraExperimentOwner='test-site';window.__tesseraExperiments={'test-site':{status:'loading',context:{profile:'experiment-preview-v1',siteId:'test-site',runtimeVersion:'3.13.0',active:true,variant:'B',experimentId:'test-cache',revision:1,deliverySha256:'a'.repeat(64),packageSha256:'b'.repeat(64)}}};}""")
        page.add_script_tag(content=(root/(name+'.js')).read_text())
        page.wait_for_function("fixtureRequests.some(r=>r.id==='Billboard') && fixtureRequests.some(r=>r.id==='adsx-takeover-slot')")
        return page
    def lazy_ready(page,legacy=False):
        if legacy:
            page.wait_for_function('fixtureObserverMargins().some(x=>x.includes("0px"))')
            page.evaluate("fixtureIntersect('P1',fixtureObserverMargins().find(x=>x.includes(' 0px ')))")
        else:page.evaluate("fixtureIntersect('P1','500px')")
        page.wait_for_function("fixtureBids.filter(b=>b.code==='P1').length===2")
        assert not page.evaluate("fixtureRequests.some(r=>r.id==='P1')")
        assert page.evaluate("adSlots.P1.getTargeting('hb_adid')")==[], 'No targeting during prefetch or native preset'
    def show_lazy(page):
        page.evaluate("fixtureIntersect('P1','0px')")
        page.wait_for_function("fixtureRequests.some(r=>r.id==='P1')")
        return page.evaluate("fixtureRequests.find(r=>r.id==='P1')")
    try:
        for name in ['cached','cached.min','fresh']:
            page=fresh(name);r=page.evaluate('fixtureRequests')
            assert all(x['cpm']==10 and x['status']=='targetingSet' for x in r),r
            assert all(x['experiment']==['d'+'a'*32+'_b'] and x['version'] for x in r),r
            before=page.evaluate('fixtureRequests.length');page.add_script_tag(content=(root/(name+'.js')).read_text());page.wait_for_timeout(50)
            assert page.evaluate('fixtureRequests.length')==before
            assert page.evaluate("__tesseraRuntimeDiagnostics['test-site'].snapshot().blockedDuplicates")==1
            lazy_ready(page);r=show_lazy(page);assert r['cpm']==10 and r['status']=='targetingSet',r
            page.close();checks.append(name+': compiled first/TakeOver/lazy targeting, reporting labels, PUC version and duplicate guard')
        for legacy in [False,True]:
            page=fresh('default-lazy' if legacy else 'cached',ttl=2);lazy_ready(page,legacy);page.wait_for_timeout(1300);r=show_lazy(page)
            assert r['cpm'] is None,r
            page.close();checks.append(('Default' if legacy else 'Configured')+' lazy delay: expired bid cannot be sent to GAM')
        page=fresh();lazy_ready(page);page.evaluate('changeFixtureConsent()');page.evaluate("fixtureIntersect('P1','0px')");page.wait_for_timeout(100)
        assert not page.evaluate("fixtureRequests.some(r=>r.id==='P1')")
        assert page.evaluate("__tesseraBidCache['test-site'].snapshot().totals.blocked")>0
        page.close();checks.append('Real TCF listener invalidates a prepared lazy auction after consent-context change')
        page=fresh();lazy_ready(page);page.set_viewport_size({'width':900,'height':900});page.wait_for_timeout(50);page.evaluate("fixtureIntersect('P1','0px')");page.wait_for_timeout(100)
        assert not page.evaluate("fixtureRequests.some(r=>r.id==='P1')")
        page.close();checks.append('Resize invalidates delayed targeting even if a banner size exists at both widths')
        for name,no_cmp,expected in [('refresh',False,4),('fresh-refresh',False,3),('refresh',True,3)]:
            page=fresh(name,no_cmp=no_cmp);page.wait_for_timeout(1300)
            page.evaluate("fixtureNext={pubmatic:{cpm:2,ttl:300},openx:{cpm:3,ttl:300}};__testAds.emit('slotVisibilityChanged',{slot:adSlots.Billboard,inViewPercentage:100})")
            page.wait_for_function("fixtureRequests.filter(r=>r.id==='Billboard').length===2")
            r=page.evaluate("fixtureRequests.filter(r=>r.id==='Billboard')");assert r[0]['cpm']==10 and r[1]['cpm']==expected,r
            assert page_calls[page].count('Billboard')==4,page_calls[page]
            assert page.evaluate("__tesseraBidCache['test-site'].snapshot().policy.selections.cache")== (1 if expected==4 else 0)
            page.close();checks.append(name+(' without CMP' if no_cmp else '')+': native dwell refresh requests both bidders; expected cached/fresh selection')
        page=fresh(late=True);page.evaluate("fixtureIntersect('P1','0px')");page.wait_for_function("fixtureRequests.some(r=>r.id==='P1')");page.wait_for_timeout(900)
        rows=page.evaluate("fixtureRequests.filter(r=>r.id==='P1')");assert len(rows)==1 and rows[0]['cpm'] is None,rows
        assert page.evaluate("__tesseraBidCache['test-site'].snapshot().totals.lateCallbacks")>=1
        assert not page.evaluate("pbjs.getConfig('bidCacheFilterFunction')(pbjs.getBidResponsesForAdUnitCode('P1').bids[0])")
        page.close();checks.append('Compiled lazy failsafe sends clean GAM once; late bids cannot trigger another request or cached reuse')
        assert not errors,errors
        assert not external,external
        checks.append('No external ad requests, no JavaScript errors, no live CMP/GAM changes')
    finally:browser.close()
report={'scope':'Compiled candidate + exact Prebid 11.34.0; synthetic adapters, GPT, TCF and currency response; no real network or hosted pilot','mockedCurrencyRequests':len(currency_fixtures),'checks':checks,'passed':len(checks)}
(root/'browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
