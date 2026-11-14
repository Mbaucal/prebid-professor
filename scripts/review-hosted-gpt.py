"""One-off MBA-404 review: exact hosted minified package + real GPT, no ad traffic."""
import base64, gzip, hashlib, json, os, re, urllib.request
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
out = root / '.generated/hosted-gpt-review'
out.mkdir(parents=True, exist_ok=True)
url = os.environ['REVIEW_ADS_URL']
code = gzip.decompress(base64.b64decode((root/'tests/fixtures/review-hosted-ads.gz.b64').read_text()))
assert hashlib.sha256(code).hexdigest() == os.environ['REVIEW_ADS_SHA256'], 'Hosted bytes differ from saved ZIP'
html = (root / 'tests/fixtures/review-hosted-gpt.html').read_text()
expected_ids = re.findall(r'<div id="([^"]+)"', html)
results = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for capped in (False, True):
        page = browser.new_page(viewport={'width':1440,'height':900})
        wire, scripts, errors = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        def route(r):
            u = urlsplit(r.request.url)
            if u.hostname == 'gpt-review.invalid':
                r.fulfill(content_type='text/html', body=html); return
            if u.hostname in ('securepubads.g.doubleclick.net','pagead2.googlesyndication.com') and (u.path.endswith('/gpt.js') or '/pagead/managed/js/gpt/' in u.path) and u.path.endswith('.js'):
                data = urllib.request.urlopen(r.request.url, timeout=30).read()
                scripts.append({'url':r.request.url,'sha256':hashlib.sha256(data).hexdigest()})
                r.fulfill(content_type='application/javascript', body=data, headers={'Access-Control-Allow-Origin':'*'}); return
            if '/gampad/' in u.path:
                wire.append({'url':r.request.url, 'post':r.request.post_data, 'query':parse_qs(u.query)})
            r.abort()
        page.route('**/*', route)
        page.goto('https://gpt-review.invalid/')
        page.evaluate('''capped => {
          window.googletag={cmd:[]}; window.__flow=[];window.__callbacks=[];
          window.__tcfapi=(c,v,cb)=>{
            if(c==='ping')cb({cmpLoaded:true,cmpStatus:'loaded'},true);
            else if(c==='addEventListener')__callbacks.push(cb);
            else if(c==='getTCData')cb({},false);
          };
          window.__emit=scope=>__callbacks.forEach(cb=>cb({gdprApplies:scope,cmpStatus:'loaded',eventStatus:'tcloaded',tcString:'',listenerId:1},true));
          window.adsKeywords={category:'Sport'};
          if(capped)sessionStorage.setItem('tessera:takeover:/123/test1/TakeOver',String(Date.now()));
        }''', capped)
        page.add_script_tag(url='https://securepubads.g.doubleclick.net/tag/js/gpt.js')
        page.wait_for_function('window.googletag.apiReady', timeout=30000)
        page.evaluate('''() => {
          const wrap=(o,n)=>{const f=o[n];o[n]=function(...a){
            __flow.push({time:Date.now(),name:n,arg:typeof a[0]==='string'?a[0]:null,slots:n==='refresh'?(a[0]||[]).map(s=>s.getAdUnitPath()):[]});
            return f.apply(this,a);
          }};
          ['defineSlot','defineOutOfPageSlot','enableServices','display'].forEach(n=>wrap(googletag,n));wrap(googletag.pubads(),'refresh');
        }''')
        snap = '''() => ({flow:__flow.slice(),slots:googletag.pubads().getSlots().map(s=>({id:s.getSlotElementId(),path:s.getAdUnitPath()})),state:takeOverDebug.state(),config:takeOverDebug.config(),readiness:window.__tesseraReadiness?.snapshot()})'''
        try:
            page.add_script_tag(content=code.decode())
            page.wait_for_timeout(700)
            pending = page.evaluate(snap)
            page.evaluate('window.__emit(undefined)')
            page.wait_for_timeout(700)
            unknown = page.evaluate(snap)
            for state in (pending, unknown):
                assert all(x['name']=='defineSlot' for x in state['flow']), state
                assert set(expected_ids)==set(s['id'] for s in state['slots']), state
            assert not wire, wire
            page.evaluate('window.__emit(false)')
            page.wait_for_timeout(2200)
            after = page.evaluate(snap)
            assert not errors, errors
            names = [x['name'] for x in after['flow']]
            assert 'enableServices' in names and wire, after
            requested = [s for x in after['flow'] if x['name']=='refresh' for s in x['slots']]
            if capped:
                assert after['state']['status']=='frequency-capped', after
                assert '/123/test1/TakeOver' not in requested, requested
            else:
                assert '/123/test1/TakeOver' in requested, after
                if after['config']['blockCodeless']:
                    assert 'defineOutOfPageSlot' in names, after
                    assert names.index('defineOutOfPageSlot') < names.index('enableServices'), after
                    fallback = [x for x in after['flow'] if x['name']=='refresh' and after['config']['codelessPath'] in x['slots']]
                    if fallback:
                        # Aborted GAM calls become no-fill. The saved configuration explicitly
                        # releases the guard on no-fill; verify that release follows that event.
                        from datetime import datetime
                        empty = [x for x in after['state']['events'] if x['type']=='empty']
                        assert after['config']['releaseCodelessOnNoFill'] and empty, after
                        empty_ms = datetime.fromisoformat(empty[0]['time'].replace('Z','+00:00')).timestamp()*1000
                        assert all(x['time'] >= empty_ms for x in fallback), after
                        assert after['state']['fallbackRequested'] and after['state']['codelessReleased'], after
            result={'capped':capped,'pending':pending,'unknown':unknown,'after':after,'wire':wire,'scripts':scripts,'errors':errors,'passed':True}
        except Exception as error:
            result={'capped':capped,'error':str(error),'snapshot':page.evaluate(snap),'wire':wire,'scripts':scripts,'errors':errors,'passed':False}
        results.append(result)
        (out/'results.json').write_text(json.dumps({'url':url,'sha256':hashlib.sha256(code).hexdigest(),'results':results},indent=2))
        print(json.dumps({'capped':capped,'passed':result['passed'],'registered':len(result.get('after',result.get('snapshot',{})).get('slots',[])),'blockedAdRequests':len(wire),'error':result.get('error'),'scripts':len(scripts)}),flush=True)
        page.close()
    browser.close()
assert all(r['passed'] for r in results), 'See results.json for failing hosted GPT case'
