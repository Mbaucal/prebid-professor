"""Combined generated-package QA. Native Chromium, synthetic demand, no external traffic."""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
output = Path(sys.argv[2] if len(sys.argv) > 2 else '.generated/qa-runtime3201').resolve()
fixture = json.loads((output / 'cases.json').read_text())
assert fixture['cases'] and all(case['pass'] for case in fixture['cases']), 'Package generation must pass first'
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()

def sizes(rows, width, height):
    ordered = sorted(rows, key=lambda row: tuple(row['viewport']), reverse=True)
    return next((row['sizes'] for row in ordered if width >= row['viewport'][0] and height >= row['viewport'][1]), [])

results = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=['--no-sandbox'], executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH'))
    for case in fixture['cases']:
        for source in ['ads.js', 'ads.min.js']:
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            page = context.new_page()
            errors, outbound = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/*', lambda route: (outbound.append(route.request.url), route.abort()))
            package = output / case['name']
            try:
                html = re.sub(r'<script\b[^>]*>[\s\S]*?</script\s*>', '', (package / 'implementation.html').read_text(), flags=re.I)
                html = re.sub(r'<link\b[^>]*>', '', html, flags=re.I)
                page.set_content(html)
                now = datetime(2026, 11, 10, 12, tzinfo=timezone.utc)
                page.clock.install(time=now)
                page.clock.pause_at(now + timedelta(seconds=1))
                page.add_style_tag(content=(package / 'min-height.css').read_text())
                page.add_script_tag(content=mock)
                page.evaluate('''c => {
                    window.adsKeywords = c.keywords || {};
                    window.__qaBids = []; window.__qaRequests = [];
                    window.fetch = () => c.country === 'timeout' ? new Promise(() => {}) : Promise.resolve(new Response(JSON.stringify({version:1, status:c.country==='unknown'?'unknown':'known', country:c.country==='unknown'?null:(c.country||'RS'), source:'cloudflare'}), {headers:{'content-type':'application/json'}}));
                    const requestBids = pbjs.requestBids;
                    pbjs.requestBids = function(input) {for(const u of input.adUnits || []) __qaBids.push({id:u.code, sizes:u.mediaTypes?.banner?.sizes, params:u.bids[0]?.params}); return requestBids(input);};
                    const refresh = __testAds.service.refresh;
                    __testAds.service.refresh = function(list) {for(const s of list || []) {const ordered=[...(s.mapping||[])].sort((a,b)=>b.viewport[0]-a.viewport[0]||b.viewport[1]-a.viewport[1]); const row=ordered.find(r=>innerWidth>=r.viewport[0]&&innerHeight>=r.viewport[1]); __qaRequests.push({id:s.id,path:s.path,sizes:row?.sizes||[]});} return refresh(list);};
                    const mapping=googletag.sizeMapping;
                    googletag.sizeMapping=()=>{const builder=mapping(),build=builder.build;builder.build=()=>build().sort((a,b)=>b.viewport[0]-a.viewport[0]||b.viewport[1]-a.viewport[1]);return builder;};
                    if(c.pendingCmp) {window.__qaConsentCallbacks=[]; window.__tcfapi=(command,version,callback)=>{if(command==='addEventListener'||command==='getTCData') {__qaConsentCallbacks.push(callback);callback({gdprApplies:true,eventStatus:'cmpuishown',cmpStatus:'loaded',listenerId:1},true);}};}
                }''', case)
                page.add_script_tag(content=(package / source).read_text())
                phases = [('initial', 1440, 900)]
                if case.get('pendingCmp'):
                    phases.append(('pending-resize', 1440, 1100))
                phases += [('eligible-resize', 1430, 1100), ('repeat-resize', 1420, 1100), ('mobile-resize', 390, 900)]
                previous_bids = previous_requests = 0
                dispatched = False
                for phase, width, height in phases:
                    if phase != 'initial':
                        page.set_viewport_size({'width': width, 'height': height})
                        page.wait_for_timeout(50)
                    if phase == 'eligible-resize' and case.get('pendingCmp'):
                        page.evaluate("__qaConsentCallbacks.forEach(cb=>cb({gdprApplies:false,eventStatus:'tcloaded',cmpStatus:'loaded',listenerId:1},true))")
                    page.clock.run_for(12000 if phase in ['initial', 'eligible-resize'] else 1000)
                    data = page.evaluate('''code => {const node=document.getElementById(code);return {bids:__qaBids,requests:__qaRequests,slots:__testAds.slots.map(s=>({id:s.id,path:s.path})),css:node?getComputedStyle(node).minHeight:null,attrs:node?.getAttributeNames().filter(name=>name.startsWith('on')),safe:Object.getPrototypeOf({})===Object.prototype&&Object.getPrototypeOf([])===Array.prototype,tag:node?.getAttribute('data-ad-rule-map')};}''', case['code'])
                    bids = [b for b in data['bids'][previous_bids:] if b['id'] == case['code']]
                    requests = [r for r in data['requests'][previous_requests:] if r['id'] == case['code']]
                    previous_bids, previous_requests = len(data['bids']), len(data['requests'])
                    expected = [] if case.get('disabled') else sizes(case['rows'], width, height)
                    pending = case.get('pendingCmp') and phase in ['initial', 'pending-resize']
                    closed = case.get('closeAfterInitial') and phase != 'initial'
                    findings = []
                    if errors: findings.append('Browser exception')
                    if outbound: findings.append('External request attempted')
                    if not data['safe']: findings.append('Prototype mutation')
                    if data['attrs']: findings.append('Unsafe container attribute')
                    if case.get('disabled') and any(s['id'] == case['code'] for s in data['slots']): findings.append('Disabled position defined')
                    if case.get('disabled') and case.get('country') and data['css'] != '0px': findings.append('GEO-disabled position retained reserved height')
                    if (pending or closed or not expected) and (bids or requests): findings.append('Request bypassed pending/closed/empty gate')
                    if any(b['sizes'] != [s for s in expected if isinstance(s, list)] for b in bids): findings.append('Prebid sizes mismatch')
                    if any(b['params'].get('siteId') != 'exact-' + case['code'] for b in bids): findings.append('Exact bidder override lost')
                    if any(r['sizes'] != expected or r['path'] != '/123/test/' + case['code'] for r in requests): findings.append('GPT sizes or literal path mismatch')
                    if dispatched and (bids or requests): findings.append('Resize forced refresh after initial request')
                    should_start = expected and not pending and not closed and not case.get('disabled') and not dispatched
                    if should_start and (not bids or not requests): findings.append('Eligible position never dispatched')
                    if not case.get('sticky') and not case.get('disabled'):
                        expected_css = str(max([0] + [s[1] for s in expected if isinstance(s, list)])) + 'px'
                        if data['css'] != expected_css: findings.append('CSS reservation mismatches exact map or escaped ID')
                    results.append({'case': case['name'], 'code': case['code'], 'source': source, 'phase': phase, 'expected': expected, 'bids': bids, 'requests': requests, 'css': data['css'], 'findings': findings, 'errors': errors[:], 'outbound': outbound[:]})
                    dispatched = dispatched or bool(requests)
                    if phase == 'initial' and case.get('closeAfterInitial'):
                        page.evaluate("document.getElementById('close_sticky_ad').click()")
            except Exception as error:
                results.append({'case': case['name'], 'code': case['code'], 'source': source, 'phase': 'exception', 'findings': [str(error)], 'errors': errors[:], 'outbound': outbound[:]})
            finally:
                context.close()
    browser.close()
report = {'scope': 'Actual generated package HTML, CSS, ads.js and ads.min.js; synthetic GPT/Prebid/CMP/GEO; all external network blocked', 'descriptor': fixture['descriptor'], 'commit': fixture['commit'], 'checks': len(results), 'results': results}
(output / 'browser-results.json').write_text(json.dumps(report, indent=2))
failed = [result for result in results if result['findings']]
print(json.dumps({'checks': len(results), 'failures': len(failed), 'results': failed}, indent=2))
raise SystemExit(1 if failed else 0)
