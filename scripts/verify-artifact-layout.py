"""Offline CSS checks on the final readable/minified candidates. Never calls live ads."""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parent.parent
packages = Path(sys.argv[1]).resolve() / 'packages'
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    for variant in ['ads.js', 'ads.min.js']:
        page = browser.new_page(viewport={'width':1280,'height':900})
        external, errors = [], []
        page.route('**/*', lambda route: route.abort())
        page.on('request', lambda r: external.append(r.url) if r.url.startswith(('http:', 'https:')) else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        try:
            page.set_content('<html><body><div id="Billboard" class="wrapperAd"></div><div id="Sticky" class="wrapperAd"></div></body></html>')
            page.add_script_tag(content=mock)
            page.add_script_tag(content=(packages/'standard'/variant).read_text())
            page.wait_for_function('takeOverDebug.state().visible', timeout=3000)
            css = (packages/'standard'/'sticky.css').read_text()
            assert page.locator('#adsx-sticky-css').text_content() == css, 'Injected and standalone CSS differ'
            properties = '(el) => {const c=getComputedStyle(el);return [c.position,c.backgroundColor,c.width,c.minHeight,c.padding,c.visibility];}'
            before = page.locator('#Sticky').evaluate(properties)
            page.add_style_tag(content=css)
            assert before == page.locator('#Sticky').evaluate(properties), 'External file conflicts with injected styles'
            assert not external and not errors, f'{external}, {errors}'
            results.append({'name':variant+' shared CSS parity','passed':True,'externalRequests':0})
        except Exception as e:
            results.append({'name':variant+' shared CSS parity','passed':False,'error':str(e)})
        finally:
            page.close()
    for name in ['empty-layout','fluid-layout']:
        page = browser.new_page(viewport={'width':360,'height':740})
        try:
            page.set_content('<div id="Billboard"></div>')
            page.add_style_tag(content=(packages/name/'min-height.css').read_text())
            assert page.locator('#Billboard').evaluate('(el)=>getComputedStyle(el).minHeight') == '250px'
            page.set_viewport_size({'width':800,'height':740})
            assert page.locator('#Billboard').evaluate('(el)=>getComputedStyle(el).minHeight') == '0px'
            page.set_viewport_size({'width':360,'height':740})
            assert page.locator('#Billboard').evaluate('(el)=>getComputedStyle(el).minHeight') == '250px'
            results.append({'name':name+' breakpoint reset','passed':True})
        except Exception as e:
            results.append({'name':name+' breakpoint reset','passed':False,'error':str(e)})
        finally:
            page.close()
    browser.close()
report = {'passed':sum(r['passed'] for r in results),'failed':sum(not r['passed'] for r in results),'cases':results,
          'scope':'Final CSS rendered in local Chromium; synthetic DOM/GPT/Prebid. No live delivery or hosted deployment.'}
(packages.parent/'layout-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
sys.exit(1 if report['failed'] else 0)
