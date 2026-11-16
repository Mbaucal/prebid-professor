"""Baseline-only independent Chromium observations; all network intercepted."""
import json
import argparse
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--fixtures-dir',default='.generated/stable-readiness-evidence')
parser.add_argument('--expect-fixed',action='store_true')
parser.add_argument('--resize-checks',action='store_true')
args=parser.parse_args()
fixtures=root/args.fixtures_dir
out=root/'.generated/audit-independent-review'
out.mkdir(parents=True,exist_ok=True)
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
html='<!doctype html><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:2400px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="Overlay" class="wrapperAd"></div></body>'
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    for width in [1440,390]:
        for extension in ['.js','.min.js']:
            for mode in ['empty','wrong-size','timeout','define-null','filled']:
                page=browser.new_page(viewport={'width':width,'height':900 if width==1440 else 844})
                errors=[];unexpected=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                def route(r):
                    if r.request.url=='https://audit.test/':r.fulfill(status=200,content_type='text/html',body=html)
                    else:unexpected.append(r.request.url);r.abort()
                page.route('**/*',route)
                page.goto('https://audit.test/')
                page.clock.install(time=datetime(2026,10,24,tzinfo=timezone.utc))
                page.evaluate('mode=>window.__testOptions={takeoverResult:mode}',mode)
                page.add_script_tag(content=mock)
                page.add_script_tag(content=(fixtures/('gam'+extension)).read_text())
                page.clock.run_for(20000)
                data=page.evaluate('''() => ({requests:__testAds.observations.requests,state:takeOverDebug.state(),phase:__tesseraReadiness.snapshot().consent})''')
                guards=[r for r in data['requests'] if r['id']=='interstitial-guard']
                takeovers=[r for r in data['requests'] if r['id']=='adsx-takeover-slot']
                assert not errors,errors
                assert not unexpected,unexpected
                expected_guard=1 if args.expect_fixed and mode!='filled' else 0
                assert len(guards)==expected_guard,('unexpected guard count',mode,len(guards),expected_guard,data)
                if mode!='define-null':assert len(takeovers)==1,(mode,takeovers)
                if mode=='empty':assert data['state']['guardStatus']==('fallback-filled' if args.expect_fixed else 'fallback-requested'),data['state']
                results.append({'finding':'T04','width':width,'variant':extension,'mode':mode,'guardRequests':len(guards),'takeoverRequests':len(takeovers),'guardStatus':data['state']['guardStatus'],'phase':data['phase'],'pageErrors':errors,'unexpectedNetwork':unexpected})
                page.close()
    for width in [1440,390]:
        page=browser.new_page(viewport={'width':width,'height':900 if width==1440 else 844})
        page.route('**/*',lambda r:r.fulfill(status=200,content_type='text/html',body=html) if r.request.url=='https://audit.test/' else r.abort())
        page.goto('https://audit.test/');page.clock.install(time=datetime(2026,10,24,tzinfo=timezone.utc))
        page.evaluate('window.__testOptions={takeoverResult:"empty"}')
        page.add_script_tag(content=mock)
        page.evaluate('''() => {window.__auditCmp=[];window.__tcfapi=(cmd,v,cb)=>{if(cmd==='addEventListener'){__auditCmp.push(cb);cb({gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown'},true);}};}''')
        page.add_script_tag(content=(fixtures/'gam.js').read_text())
        page.clock.run_for(5000);assert page.evaluate('__testAds.observations.requests.length')==0
        page.evaluate('() => __auditCmp.forEach(cb=>cb({gdprApplies:false},true))')
        page.clock.run_for(5000)
        data=page.evaluate('({requests:__testAds.observations.requests,state:takeOverDebug.state()})')
        guard_count=len([r for r in data['requests'] if r['id']=='interstitial-guard'])
        assert guard_count==(1 if args.expect_fixed else 0),data
        assert len([r for r in data['requests'] if r['id']=='adsx-takeover-slot'])==1
        results.append({'finding':'T04','width':width,'mode':'pending-then-ready','requestsBeforeDecision':0,'guardRequestsAfterDecision':guard_count,'guardStatus':data['state']['guardStatus']})
        page.close()
    if args.resize_checks:
        assert args.expect_fixed,'resize checks are positive candidate checks'
        for extension in ['.js','.min.js']:
            for kind,start,end in [('desktop-only',1440,800),('mobile-only',800,1440)]:
                page=browser.new_page(viewport={'width':start,'height':900});errors=[];unexpected=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                def route(r):
                    if r.request.url=='https://audit.test/':r.fulfill(status=200,content_type='text/html',body=html)
                    else:unexpected.append(r.request.url);r.abort()
                page.route('**/*',route);page.goto('https://audit.test/');page.clock.install(time=datetime(2026,10,24,tzinfo=timezone.utc))
                page.add_script_tag(content=mock)
                page.evaluate('''() => {window.__auditCmp=[];window.__tcfapi=(cmd,v,cb)=>{if(cmd==='addEventListener'){__auditCmp.push(cb);cb({gdprApplies:true,cmpStatus:'loaded',eventStatus:'cmpuishown'},true);}};}''')
                page.add_script_tag(content=(fixtures/(kind+extension)).read_text());page.clock.run_for(500)
                page.set_viewport_size({'width':end,'height':900});page.clock.run_for(2500)
                assert page.evaluate('__testAds.observations.requests.length')==0
                page.evaluate('() => __auditCmp.forEach(cb=>cb({gdprApplies:false},true))');page.clock.run_for(5000)
                data=page.evaluate('({requests:__testAds.observations.requests,state:takeOverDebug.state(),config:takeOverDebug.config()})')
                assert not errors,errors
                assert not unexpected,unexpected
                assert not [r for r in data['requests'] if r['id']=='adsx-takeover-slot'],data
                assert len([r for r in data['requests'] if r['id']=='interstitial-guard'])==1,data
                assert data['state']['status']=='skipped-viewport',data
                assert data['config']['current'] is None,data
                results.append({'finding':'T23','mode':kind+extension,'from':start,'to':end,'status':data['state']['status'],'guardRequests':1,'takeoverRequests':0,'errors':errors})
                page.close()
            for width in [375,800,1100,1400]:
                page=browser.new_page(viewport={'width':width,'height':900})
                page.route('**/*',lambda r:r.fulfill(status=200,content_type='text/html',body=html) if r.request.url=='https://audit.test/' else r.abort())
                page.goto('https://audit.test/');page.clock.install(time=datetime(2026,10,24,tzinfo=timezone.utc));page.add_script_tag(content=mock)
                page.add_script_tag(content=(fixtures/('gam'+extension)).read_text());page.clock.run_for(4000)
                data=page.evaluate('({state:takeOverDebug.state(),config:takeOverDebug.config()})')
                assert data['config']['current']['size']==data['state']['requestedSize'],data
                assert data['config']['desktopSize'] is None,data
                assert data['config']['mobileSize'] is None,data
                results.append({'finding':'T23','width':width,'mode':'diagnostic'+extension,'current':data['config']['current']['size'],'requested':data['state']['requestedSize']})
                page.close()
    browser.close()
report=out/('native-working-candidate.json' if args.expect_fixed else 'native-baseline.json')
report.write_text(json.dumps({'scope':'Real headless Chromium, local generated GAM-only; synthetic GPT/TCF; every network route intercepted','candidateOnly':args.expect_fixed,'results':results},indent=2)+'\n')
print(json.dumps({'cases':len(results),'observed':True,'expectFixed':args.expect_fixed,'report':str(report)}))
