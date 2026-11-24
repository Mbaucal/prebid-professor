"""Check the reported Measurement overlap against the actual App and MAIN fixture.

Only reads synthetic fixture data. The zoom cases reduce the CSS viewport and
increase device scale by the same factor: browser-zoom layout equivalents, not
an assertion that Chromium's browser zoom UI was exercised.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
parser.add_argument('--out', type=Path)
args = parser.parse_args()
ROOT = args.root.resolve()
OUT = (args.out or ROOT / '.generated/measurement-layout-ui').resolve()
OUT.mkdir(parents=True, exist_ok=True)
for name in ['result.json', 'failure.json']:
    (OUT / name).unlink(missing_ok=True)
for stale in OUT.glob('*-failure.png'):
    stale.unlink()

checks, geometries, requests, external, errors = [], [], [], [], []
held = []
mode = {'hold': False}
process = None
browser = None
playwright = None
page = None
case_name = 'fixture'


def check(name, condition=True):
    assert condition, name
    checks.append(name)


def send(path, method='GET', body=None):
    process.stdin.write(json.dumps({'path': path, 'method': method, 'body': body}) + '\n')
    process.stdin.flush()
    result = json.loads(process.stdout.readline())
    assert 'error' not in result, result
    return result


def fulfill(route, result):
    route.fulfill(status=result['status'], headers=result['headers'], body=base64.b64decode(result['body']))


def intercept(route):
    request = route.request
    url = urlsplit(request.url)
    if url.netloc != urlsplit(origin).netloc:
        external.append(request.url)
        route.abort()
        return
    path = url.path + ('?' + url.query if url.query else '')
    assert request.method == 'GET', 'Layout checks must not write through the browser'
    result = send(path, request.method, request.post_data)
    requests.append({'case': case_name, 'path': path, 'method': request.method, 'status': result['status']})
    if mode['hold'] and path == '/api/publishers/tanjug/ab-tests':
        mode['hold'] = False
        held.append((route, result))
        return
    fulfill(route, result)


def geometry(state):
    """Compare painted border boxes; inline anchor padding must count."""
    result = page.locator('#ab-tests').evaluate('''panel => {
      const rect = element => {
        const box = element.getBoundingClientRect();
        return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height};
      };
      const heading = panel.querySelector('#ab-tests-title');
      const action = [...panel.querySelectorAll('a')].find(link=>link.textContent==='Create A/B test');
      const intro = [...panel.children].find(child=>child.tagName==='P');
      const peer = [...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Edit site');
      const colors = element => {const s=getComputedStyle(element);return {color:s.color,background:s.backgroundColor,border:s.borderColor};};
      return {heading:rect(heading),action:rect(action),intro:rect(intro),panel:rect(panel),
        actionDisplay:getComputedStyle(action).display,
        actionColors:colors(action),secondaryColors:colors(peer),
        viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
        scrollWidth:document.documentElement.scrollWidth};
    }''')
    result.update({'case': case_name, 'state': state})
    geometries.append(result)

    def overlap(a, b):
        return min(a['right'], b['right']) - max(a['left'], b['left']) > 1 and min(a['bottom'], b['bottom']) - max(a['top'], b['top']) > 1

    for first, second in [('heading', 'action'), ('heading', 'intro'), ('action', 'intro')]:
        check(f'{case_name}/{state}: {first} and {second} border boxes do not overlap', not overlap(result[first], result[second]))
    check(f'{case_name}/{state}: intro starts below heading and CTA', result['intro']['top'] >= max(result['heading']['bottom'], result['action']['bottom']) + 3)
    check(f'{case_name}/{state}: CTA stays inside panel width', result['action']['left'] >= result['panel']['left'] - 1 and result['action']['right'] <= result['panel']['right'] + 1)
    check(f'{case_name}/{state}: CTA uses the normal secondary action colors', result['actionColors'] == result['secondaryColors'])
    check(f'{case_name}/{state}: no horizontal document overflow', result['scrollWidth'] <= result['viewport']['width'] + 1)
    return result


def fields_geometry():
    result = page.locator('.ab-tests-fields').evaluate('''grid => {
      const rect = element => {const b=element.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
      return [...grid.querySelectorAll('.ab-tests-field')].map(field=>({
        label:field.querySelector('label').textContent,
        text:rect(field.querySelector('label')),
        control:rect(field.querySelector('input,select')),
        field:rect(field),
      }));
    }''')
    for row in result:
        check(f"{case_name}: {row['label']} control starts below its label", row['control']['top'] >= row['text']['bottom'] + 3)
        check(f"{case_name}: {row['label']} control fits its field", row['control']['left'] >= row['field']['left'] - 1 and row['control']['right'] <= row['field']['right'] + 1)
    for i, first in enumerate(result):
        for second in result[i + 1:]:
            a, b = first['control'], second['control']
            overlaps = min(a['right'], b['right']) - max(a['left'], b['left']) > 1 and min(a['bottom'], b['bottom']) - max(a['top'], b['top']) > 1
            check(f"{case_name}: {first['label']} and {second['label']} controls do not overlap", not overlaps)


try:
    source_commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, check=True, text=True, capture_output=True).stdout.strip()
    process = subprocess.Popen(['node', '--experimental-strip-types', '--experimental-loader', './tests/support/ts-extension-loader.mjs', 'scripts/experiments-workspace-browser-fixture.mjs'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    fixture = json.loads(process.stdout.readline())
    assert fixture['ready'], fixture
    origin = fixture['origin']
    check('fixture represents zero-source Tanjug', fixture['initialBuiltinSources'] == 0)
    playwright = sync_playwright().start()
    launch = {'headless': True, 'args': ['--no-sandbox', '--disable-dev-shm-usage']}
    if os.environ.get('CHROMIUM_PATH'):
        launch['executable_path'] = os.environ['CHROMIUM_PATH']
    browser = playwright.chromium.launch(**launch)
    # Physical desktop width 1440 at each zoom equivalent; 390 is a real narrow CSS viewport.
    cases = [('desktop-1972', 1972, 1280, 1), ('desktop-1440', 1440, 960, 1), ('narrow-390', 390, 960, 1)]
    cases += [(f'zoom-equivalent-{int(zoom * 100)}', round(1440 / zoom), round(960 / zoom), zoom) for zoom in [1.25, 1.5, 2]]
    cases.append(('narrow-large-heading-text', 390, 960, 1))
    for case_name, width, height, scale in cases:
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=scale)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/*', intercept)
        mode['hold'] = True
        page.goto(origin + '/?section=publishers&publisher=minacord-media-doo&site=tanjug&tab=measurement')
        expect(page.locator('#ab-tests-title')).to_be_visible()
        if case_name == 'narrow-large-heading-text':
            # A focused user-font-size override exercises actual row wrapping at
            # a supported viewport. It is separate from browser zoom equivalents.
            page.add_style_tag(content='.ab-tests-heading{font-size:32px}.ab-tests-heading h2{font-size:40px}')
        deadline = time.monotonic() + 5
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(10)
        assert len(held) == 1, held
        expect(page.get_by_text('Loading A/B tests…', exact=True)).to_be_visible()
        page.locator('#ab-tests-title').scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f'{case_name}-loading.png'))
        geometry('loading')
        if case_name == 'narrow-large-heading-text':
            wrapped = geometries[-1]
            check('enlarged heading text wraps the CTA to a separate row', wrapped['action']['top'] >= wrapped['heading']['bottom'] + 3)
        pending, response = held.pop()
        pending.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Synthetic A/B listing temporarily unavailable'}))
        alert = page.get_by_role('alert').filter(has_text='Synthetic A/B listing temporarily unavailable')
        expect(alert).to_be_visible()
        geometry('load-error')
        page.locator('#ab-tests-title').scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f'{case_name}-error.png'))
        alert.get_by_role('button', name='Reload A/B tests', exact=True).click()
        expect(page.locator('form.ab-tests-form')).to_be_visible()
        expect(alert).to_have_count(0)
        expect(page.get_by_role('heading', name='Earlier A/B tests', exact=True)).to_be_visible()
        geometry('recovered')
        page.locator('#ab-tests-title').scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f'{case_name}-header.png'))

        cta = page.get_by_role('link', name='Create A/B test', exact=True)
        expect(cta).to_have_attribute('href', '#ab-source-versions')
        cta.focus()
        expect(cta).to_be_focused()
        cta.press('Enter')
        check(f'{case_name}: keyboard activation reaches source-version anchor', urlsplit(page.url).fragment == 'ab-source-versions')
        source = page.locator('#ab-source-versions')
        expect(source).to_have_attribute('open', '')
        source_box = source.locator(':scope > summary').bounding_box()
        check(f'{case_name}: source target is scrolled into viewport', source_box and source_box['y'] >= -1 and source_box['y'] < height)
        version = source.get_by_label('Version name', exact=True)
        version.focus()
        expect(version).to_be_focused()
        version.press_sequentially('Layout check only')
        expect(version).to_have_value('Layout check only')
        version.press('Tab')
        expect(source.locator(':scope > .runtime-actions button:enabled').first).to_be_focused()
        check(f'{case_name}: source field accepts keyboard input and Tab reaches an available action')

        form = page.locator('form.ab-tests-form')
        expect(form.get_by_label('Version A', exact=True)).to_be_disabled()
        expect(form.get_by_label('Version B', exact=True)).to_be_disabled()
        name = form.get_by_label('Test name', exact=True)
        name.focus()
        name.press_sequentially('Keyboard layout check')
        name.press('Tab')
        expect(form.get_by_label('TestId', exact=True)).to_be_focused()
        check(f'{case_name}: A/B field Tab order remains usable')
        fields_geometry()
        form.scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f'{case_name}-fields.png'))
        geometry('fields-in-use')
        query = parse_qs(urlsplit(page.url).query)
        check(f'{case_name}: interactions retain site and Measurement', query.get('site') == ['tanjug'] and query.get('publisher') == ['minacord-media-doo'] and query.get('tab') == ['measurement'])
        page.close()
        page = None
    inspection = send('/__qa/inspect')
    assert inspection['status'] == 200, inspection
    state = json.loads(base64.b64decode(inspection['body']))
    check('no source/test/config/inventory/ZIP mutation during layout checks', state['releases'] == [] and state['newKeys'] == [] and state['configUnchanged'] and state['originalObjectsUnchanged'] and state['siteUnchanged'] and state['inventoryUnchanged'] and state['otherSiteUnchanged'])
    check('no external traffic or browser errors', state['outboundRequests'] == 0 and external == [] and errors == [])
    result = {'passed': True, 'sourceCommit': source_commit, 'checks': checks, 'geometry': geometries, 'requests': requests, 'errors': errors, 'external': external,
              'scope': 'Actual App and MAIN routes, synthetic zero-source Tanjug, GET-only browser interactions. Desktop/narrow CSS viewports; 125/150/200% zoom uses corresponding CSS viewport plus DPR, not the browser zoom UI. One separate 390px case enlarges only the changed heading/action text to 200% to exercise row wrapping. No script generation, ad execution or hosted authentication.'}
    (OUT / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({'passed': True, 'checks': len(checks), 'cases': [row[0] for row in cases], 'evidence': str(OUT)}))
except Exception as error:
    if page:
        page.screenshot(path=str(OUT / f'{case_name}-failure.png'))
    (OUT / 'failure.json').write_text(json.dumps({'error': str(error), 'checks': checks, 'geometry': geometries, 'requests': requests, 'errors': errors, 'external': external}, indent=2))
    raise
finally:
    for route, response in held:
        fulfill(route, response)
    if browser:
        browser.close()
    if playwright:
        playwright.stop()
    if process:
        process.stdin.close()
        process.wait(timeout=10)
