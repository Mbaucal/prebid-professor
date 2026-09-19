"""Compiled candidate, simulated GPT requests only. No real ads or GAM account changes."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
out=Path('.generated/measured-evidence')
source=(out/'ads.js').read_text()
mock=Path('tests/runtime/mock-ad-libraries.js').read_text()
checks=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        for variant in ['A','B','stopped','absent']:
            page=browser.new_page(viewport={'width':1280,'height':900})
            errors=[];external=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.route('**/*',lambda r:(external.append(r.request.url),r.abort()))
            page.set_content('<!doctype html><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="Overlay"></div>')
            page.add_script_tag(content=mock)
            page.evaluate("""() => {
                window.requestLabels=[];
                __testAds.service.addEventListener('slotRequested',({slot})=>requestLabels.push({id:slot.id,value:slot.getTargeting('tessera_ab')}));
                window.foreignSlot=googletag.defineSlot('/123/foreign',[300,250],'foreign').addService(googletag.pubads());
            }""")
            if variant!='absent':
                page.evaluate("""v=>{
                    window.__tesseraExperimentOwner='test-site';
                    window.__tesseraExperiments={'test-site':{status:'loading',context:{profile:'experiment-preview-v1',siteId:'test-site',runtimeVersion:'3.12.0-tessera.preview.1',active:v!=='stopped',variant:v==='B'?'B':'A',experimentId:'test-measurement',revision:1,deliverySha256:'a'.repeat(64),packageSha256:'b'.repeat(64)}}};
                }""",variant)
            page.add_script_tag(content=source)
            page.wait_for_function("requestLabels.some(r=>r.id==='Billboard') && requestLabels.some(r=>r.id==='adsx-takeover-slot')")
            expected=['d'+'a'*32+'_'+variant.lower()] if variant in ['A','B'] else []
            assert all(r['value']==expected for r in page.evaluate('requestLabels'))
            assert page.evaluate("foreignSlot.getTargeting('tessera_ab')")==[]
            page.evaluate("__testAds.service.refresh([adSlots.Billboard])")
            assert page.evaluate('requestLabels.at(-1).value')==expected
            before=page.evaluate("__tesseraGamMeasurement['test-site'].snapshot()")
            page.add_script_tag(content=source)
            assert page.evaluate("__tesseraGamMeasurement['test-site'].snapshot()")==before
            assert page.evaluate("__tesseraRuntimeDiagnostics['test-site'].snapshot().blockedDuplicates")==1
            assert not errors,errors
            assert not external,external
            checks.append(variant+': correct first/refresh/TakeOver targeting; foreign slot unchanged; duplicate blocked; no external requests')
            page.close()
    finally:
        browser.close()
(out/'browser.json').write_text(json.dumps({'scope':'Local mock GPT request labels, not confirmed GAM reporting','checks':checks,'passed':len(checks)},indent=2))
print(json.dumps(checks,indent=2))
