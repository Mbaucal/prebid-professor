"""Native Chromium check of imported-template portal repair with synthetic GPT.
No hosted configuration, paid traffic, credentials or external scripts.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
directory = root / '.generated/legacy-portal-evidence'
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
html = '''<!doctype html><html><head><style>body{margin:0;font:16px Arial}#Billboard{min-height:250px}#P1{min-height:250px}</style></head>
<body><div id="Billboard" class="wrapperAd"></div><main style="height:2000px">Local synthetic page</main><div id="P1" class="wrapperAd lazyAd"></div><div id="Sticky" class="wrapperAd"></div></body></html>'''
results = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for width, height in [(1440, 900), (390, 844)]:
        for fixed in [False, True]:
            for external_css in [False, True]:
                name = ('fixed' if fixed else 'original')
                case = {'width': width, 'fixed': fixed, 'externalCss': external_css,
                        'expected': 'fixed behavior' if fixed else 'baseline observation'}
                page = browser.new_page(viewport={'width': width, 'height': height})
                errors, requests = [], []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('request', lambda r: requests.append(r.url) if r.url.startswith(('https:', 'http:')) else None)
                page.route('**/*', lambda route: route.abort())
                try:
                    page.set_content(html)
                    if external_css:
                        page.add_style_tag(content=(directory / f'{name}.css').read_text())
                    page.add_script_tag(content=mock)
                    page.add_script_tag(content=(directory / f'{name}.js').read_text())
                    page.wait_for_function("document.getElementById('Sticky').classList.contains('ad-loaded')", timeout=3000)
                    page.wait_for_timeout(1100)
                    page.evaluate("() => { for(let i=0;i<5;i++)window.dispatchEvent(new Event('resize')); }")
                    page.wait_for_timeout(70)
                    state = page.evaluate('''() => {
                      const list=[...document.querySelectorAll('#close_sticky_ad')], b=list[0];
                      if(!b)return{count:0};
                      const r=b.getBoundingClientRect(), s=getComputedStyle(b), x=r.x+r.width/2,y=r.y+r.height/2;
                      return {count:list.length,body:b.parentNode===document.body,position:s.position,zIndex:s.zIndex,
                        radius:s.borderRadius,bottom:s.bottom,top:s.top,hit:document.elementFromPoint(x,y)===b,
                        rect:{x:r.x,y:r.y,width:r.width,height:r.height},center:{x,y}};
                    }''')
                    case['state'] = state
                    if fixed:
                        assert state['count'] == 1, state
                        assert state['body'] and state['position'] == 'fixed', state
                        assert state['zIndex'] == '2147483647' and state['radius'] == '50%', state
                        assert state['hit'], state
                        assert state['rect']['y'] > height / 2, state
                        assert state['rect']['x'] >= 0 and state['rect']['x'] + state['rect']['width'] <= width, state
                        page.screenshot(path=str(directory / f'portal-{width}-css-{int(external_css)}.png'))
                        page.mouse.click(state['center']['x'], state['center']['y'])
                        page.wait_for_function("!document.getElementById('Sticky').classList.contains('ad-loaded')", timeout=1000)
                        assert page.locator('#close_sticky_ad').count() == 0, 'Portal button remains after close'
                    assert not errors, errors
                    assert not requests, requests
                    case.update({'passed': True, 'pageErrors': errors, 'externalRequests': len(requests)})
                except Exception as e:
                    case.update({'passed': False, 'error': str(e), 'pageErrors': errors, 'externalRequests': len(requests)})
                finally:
                    results.append(case)
                    page.close()
    browser.close()

fixed = [r for r in results if r['fixed']]
baseline = [r for r in results if not r['fixed']]
assert any(r.get('state', {}).get('count', 0) > 1 or not r.get('state', {}).get('hit', True)
           or r.get('state', {}).get('rect', {}).get('y', 900) < 400 for r in baseline), 'Baseline did not reproduce the defect'
report = {'scope': 'Native Chromium; actual reference/compiler + legacy CSS functions; synthetic GPT/CMP; no hosted or paid traffic',
          'checks': results, 'fixedPassCount': sum(r['passed'] for r in fixed),
          'baselineObservationCount': len(baseline), 'passed': all(r['passed'] for r in fixed)}
(directory / 'browser-result.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
if not report['passed']:
    raise SystemExit(1)
