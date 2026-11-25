"""Exercise detailed GAM reports in the actual App and authenticated MAIN router.

All HTTP is intercepted and dispatched into the existing SQLite/R2 memory
fixture. No generated ad script is executed and no publisher/GAM request runs.
"""
import argparse
import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
parser.add_argument('--out', type=Path)
args = parser.parse_args()
ROOT = args.root.resolve()
OUT = (args.out or ROOT / '.generated/gam-report-v2-ui').resolve()
OUT.mkdir(parents=True, exist_ok=True)
for name in ['result.json', 'failure.json']:
    (OUT / name).unlink(missing_ok=True)
for stale in OUT.glob('*-failure.png'):
    stale.unlink()

checks, requests, external, errors, geometries = [], [], [], [], []
held = []
mode = {'hold': None, 'fail': None}
process = browser = page = playwright = None
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


def api(path, method='GET', body=None):
    result = send(path, method, None if body is None else json.dumps(body))
    return result['status'], json.loads(base64.b64decode(result['body']))


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
    check('browser writes only to synthetic detailed report plans', request.method == 'GET' or (request.method == 'POST' and '/measurement/v2/plans' in path))
    if mode['fail'] == (request.method, path):
        mode['fail'] = None
        requests.append({'case': case_name, 'path': path, 'method': request.method, 'status': 503, 'syntheticFailure': True})
        route.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Synthetic detailed report temporarily unavailable'}))
        return
    result = send(path, request.method, request.post_data)
    requests.append({'case': case_name, 'path': path, 'method': request.method, 'status': result['status']})
    if mode['hold'] == (request.method, path):
        mode['hold'] = None
        held.append((route, result))
        return
    fulfill(route, result)


def take_held():
    deadline = time.monotonic() + 5
    while not held and time.monotonic() < deadline:
        page.wait_for_timeout(10)
    assert len(held) == 1, held
    return held.pop()


def geometry(panel, state):
    value = panel.evaluate('''panel => {
      const rect = el => {const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
      const shown = el => {
        const r=el.getBoundingClientRect();
        if(!r.width||!r.height||getComputedStyle(el).visibility==='hidden')return false;
        // Chromium can keep layout boxes for content-visibility-hidden details.
        // Only the first summary is painted while its disclosure is closed.
        for(let detail=el.closest('details');detail;detail=detail.parentElement?.closest('details'))
          if(!detail.open&&!detail.querySelector(':scope > summary')?.contains(el))return false;
        return true;
      };
      const controls = [...panel.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea,button')].filter(shown)
        .map(el=>({name:el.getAttribute('aria-label')||el.id||el.textContent.trim(),box:rect(el)}));
      const labels = [...panel.querySelectorAll('label')].filter(shown).flatMap(label=>{
        const control=label.htmlFor?document.getElementById(label.htmlFor):label.querySelector('input,select,textarea');
        if(!control||!shown(control)||['checkbox','radio'].includes(control.type))return [];
        const text=[...label.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim());
        return text.flatMap(node=>{const range=document.createRange();range.selectNodeContents(node);return [...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({name:node.textContent.trim(),text:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},control:rect(control)}));});
      });
      return {panel:rect(panel),controls,labels,width:innerWidth,scrollWidth:document.documentElement.scrollWidth};
    }''')
    value.update({'case': case_name, 'state': state})
    geometries.append(value)

    def overlap(a, b):
        return min(a['right'], b['right']) - max(a['left'], b['left']) > 1 and min(a['bottom'], b['bottom']) - max(a['top'], b['top']) > 1

    check(f'{case_name}/{state}: no horizontal document overflow', value['scrollWidth'] <= value['width'] + 1)
    for row in value['labels']:
        check(f"{case_name}/{state}: label {row['name']} does not overlap its input", not overlap(row['text'], row['control']))
    collisions = []
    for i, first in enumerate(value['controls']):
        check(f"{case_name}/{state}: {first['name']} stays inside panel", first['box']['left'] >= value['panel']['left'] - 1 and first['box']['right'] <= value['panel']['right'] + 1)
        for second in value['controls'][i + 1:]:
            if overlap(first['box'], second['box']):
                collisions.append([first['name'], second['name']])
    check(f'{case_name}/{state}: no intersecting control boxes; collisions={collisions}', not collisions)


def shot(panel, state, target=None):
    (target or panel).scroll_into_view_if_needed()
    geometry(panel, state)
    page.screenshot(path=str(OUT / f'{case_name}-{state}.png'))


def open_ancestors(control):
    """Expand user-facing disclosures with their own summary controls."""
    control.wait_for(state='attached')
    details = control.locator('xpath=ancestor::details')
    for index in range(details.count()):
        disclosure = details.nth(index)
        if not disclosure.evaluate('element=>element.open'):
            disclosure.locator(':scope > summary').click()


def report_csv(plan, bad_line_item=False):
    """Synthetic display data at the exact selected dimensional grain."""
    report = plan['report']
    columns = ['date', 'VersionId', 'Variant'] + report['dimensions'] + report['metrics']
    output = io.StringIO(newline='')
    writer = csv.writer(output, lineterminator='\n')
    writer.writerow([report['sourceColumns'][key] for key in columns])
    for day_index, date in enumerate([report['startDate'], report['endDate']]):
        for arm in ['A', 'B']:
            for mobile in [False, True]:
                impressions = 100 if mobile else (1000 if arm == 'A' else 900)
                values = {
                    'date': date, 'VersionId': plan['versionId'], 'Variant': arm,
                    'adUnit': '/999/other-site/' + ('BTF/' if mobile else 'ATF/'),
                    'deviceCategory': 'Mobile' if mobile else 'Desktop', 'country': 'RS',
                    'requestedAdSizes': '300x250', 'creativeSize': '300x250',
                    'orderId': report['scope']['orderIds'][0] if report['scope']['orderIds'] else '100',
                    'lineItemId': ('999999' if bad_line_item else report['scope']['lineItemIds'][0]) if report['scope']['lineItemIds'] else '200',
                    'creativeId': '300', 'hb_bidder': 'synthetic', 'hb_pb': '1.00', 'hb_size': '300x250',
                    'aq_bid_origin': 'cached' if mobile else 'fresh', 'refresh_count': '0',
                    'refresh_bucket': 'initial', 'refresh_interval': 'initial', 'refresh_policy': 'initial',
                    'aq_first_request': 'lt_500', 'aq_consent_wait': 'lt_500',
                    'aq_bidder_count': '1', 'aq_bid_count': '1', 'aq_timed_out': 'no',
                    'impressions': impressions,
                    'revenue': ('0.5' if arm == 'A' else '0.1') if mobile else ('9876.543219' if day_index == 0 else '1.25') if arm == 'A' else '11.25',
                    'clicks': 1 if mobile else 5,
                    'adRequests': 200 if mobile else 2000,
                    'responsesServed': 150 if mobile else 1500,
                    'unfilledImpressions': 50 if mobile else 500,
                    'eligibleImpressions': impressions,
                    'measurableImpressions': 90 if mobile else 900 if arm == 'A' else 850,
                    'viewableImpressions': 45 if mobile else 600 if arm == 'A' else 425,
                }
                writer.writerow([values[key] for key in columns])
    return output.getvalue()


try:
    source_commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, check=True, text=True, capture_output=True).stdout.strip()
    process = subprocess.Popen(['node', '--experimental-strip-types', '--experimental-loader', './tests/support/ts-extension-loader.mjs', 'scripts/experiments-workspace-browser-fixture.mjs'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    fixture = json.loads(process.stdout.readline())
    assert fixture['ready'], fixture
    origin = fixture['origin']
    legacy_experiment = fixture['other']
    status, old_record = api('/api/publishers/other-site/ab-tests/' + legacy_experiment['id'])
    assert status == 200, old_record
    old_record = old_record['record']
    check('seeded historical package retains loader 1.1.1', old_record['loader']['version'] == '1.1.1')
    setup_body = {'name': 'Detailed Version ID QA package', 'testId': 'qa_version_01',
                  'a': old_record['arms']['A']['release'], 'b': old_record['arms']['B']['release'],
                  'trafficBPercent': 50, 'reportingKey': 'VersionId'}
    status, created = api('/api/publishers/other-site/ab-tests', 'POST', setup_body)
    assert status == 201, created
    record = created['record']
    check('explicit synthetic setup saves a genuine new VersionId loader package', record['loader']['version'] == '1.2.0' and record['testId'] == setup_body['testId'])
    OUT.joinpath('new-versionid-package.json').write_text(json.dumps(created, indent=2))
    experiment = {'id': record['id'], 'testId': record['testId'], 'name': record['name']}
    _, setup_inspection = api('/__qa/inspect')
    setup_keys = set(setup_inspection['newKeys'])
    BASE = '/api/publishers/other-site/ab-tests/' + experiment['id'] + '/measurement/v2/plans'
    LEGACY = BASE.replace('/measurement/v2/plans', '/measurement/plans')
    playwright = sync_playwright().start()
    launch = {'headless': True, 'args': ['--no-sandbox', '--disable-dev-shm-usage']}
    if os.environ.get('CHROMIUM_PATH'):
        launch['executable_path'] = os.environ['CHROMIUM_PATH']
    browser = playwright.chromium.launch(**launch)
    for width in [1440, 390]:
        case_name = f'width-{width}'
        page = browser.new_page(viewport={'width': width, 'height': 960}, accept_downloads=True)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/*', intercept)
        page.goto(origin + '/?section=publishers&publisher=minacord-media-doo&site=other-site&tab=measurement')
        legacy_article = page.get_by_role('article', name='A/B test: Other site saved experiment', exact=True)
        expect(legacy_article).to_be_visible()
        legacy_article.get_by_role('button', name='Review GAM report', exact=True).click()
        legacy_report = legacy_article.locator('.detailed-gam-report')
        expect(legacy_report).to_be_visible()
        expect(legacy_report).to_contain_text('TestId')
        check(f'{case_name}: old package reports its actual legacy GAM identity key', re.search(r'GAM key\s+TestId', legacy_report.inner_text()) is not None)
        legacy_article.get_by_role('button', name='Daily summary', exact=True).click()
        expect(legacy_article.get_by_label('Saved reporting plan', exact=True)).to_be_visible()
        article = page.get_by_role('article', name='A/B test: ' + experiment['name'], exact=True)
        expect(article).to_be_visible()
        mode['hold'] = ('GET', BASE)
        article.get_by_role('button', name='Review GAM report', exact=True).click()
        panel = article.locator('.ab-measurement-views')
        expect(panel).to_be_visible()
        detailed = panel.locator('.detailed-gam-report')
        expect(detailed).to_be_visible()
        check(f'{case_name}: detailed reports are the default format', True)
        def field(label):
            return detailed.get_by_label(label, exact=True)
        def button(label):
            return detailed.get_by_role('button', name=label, exact=True)
        def choice(label):
            return detailed.get_by_role('checkbox', name=re.compile('^' + re.escape(label) + r'(?:\s|$)'))
        def prepare_form():
            open_ancestors(field('Report purpose'))
            expect(field('Report purpose')).to_be_visible()
        def review_input(raw):
            field('Detailed GAM CSV').fill(raw)
            expect(detailed.get_by_role('region', name='Detailed GAM CSV review', exact=True)).to_have_count(0)
            button('Review detailed GAM CSV').click()
        pending, _ = take_held()
        shot(panel, 'loading')
        pending.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Synthetic detailed report list unavailable'}))
        expect(panel.get_by_role('alert').filter(has_text='Synthetic detailed report list unavailable')).to_be_visible()
        shot(panel, 'list-error')
        button('Reload detailed reports').click()
        prepare_form()
        open_ancestors(detailed.get_by_role('button', name='Download fictitious detailed CSV example', exact=True, include_hidden=True))
        with page.expect_download() as event:
            button('Download fictitious detailed CSV example').click()
        example_file = event.value
        example_file.save_as(OUT / f'{case_name}-prebid-example.csv')
        example_rows = list(csv.DictReader(io.StringIO(Path(example_file.path()).read_text())))
        check(f'{case_name}: wide Prebid example is explicitly fictitious and uses neutral VersionId', 'FICTITIOUS' in example_file.suggested_filename and example_rows and len(example_rows[0]) == 30 and all(row.get('VersionId') and row['VersionId'] != experiment['testId'] for row in example_rows))
        expect(detailed.get_by_role('status').filter(has_text=re.compile('Fictitious.*example downloaded'))).to_be_visible()
        with page.expect_download() as event:
            button('Download fictitious report setup JSON').click()
        event.value.save_as(OUT / f'{case_name}-prebid-example-setup.json')
        example_setup = json.loads(Path(event.value.path()).read_text())
        check(f'{case_name}: full Prebid example has matching declared scope metadata', example_setup['fictitious'] is True and example_setup['report']['purpose'] == 'prebid' and example_setup['report']['metricFamily'] == 'ad-server' and example_setup['report']['scope']['orderIds'] == ['900001'] and example_setup['report']['scope']['lineItemIds'] == ['900002'] and list(example_rows[0]) == ['date', 'VersionId', 'Variant'] + example_setup['report']['dimensions'] + example_setup['report']['metrics'])
        with page.expect_download() as event:
            button('Download fictitious overall CSV example').click()
        event.value.save_as(OUT / f'{case_name}-overall-example.csv')
        overall_rows = list(csv.DictReader(io.StringIO(Path(event.value.path()).read_text())))
        with page.expect_download() as event:
            button('Download fictitious overall setup JSON').click()
        event.value.save_as(OUT / f'{case_name}-overall-example-setup.json')
        overall_setup = json.loads(Path(event.value.path()).read_text())
        check(f'{case_name}: overall example has 26 columns and preserves all-demand scope', overall_setup['fictitious'] is True and overall_setup['report']['purpose'] == 'overall' and overall_setup['report']['metricFamily'] == 'total' and overall_setup['report']['scope'] == {'orderIds': [], 'lineItemIds': []} and len(overall_rows[0]) == 26 and not any(key in overall_rows[0] for key in ['orderId', 'lineItemId', 'creativeId']))
        expect(field('GAM network code')).to_have_value('999')
        expect(field('Inventory path')).to_have_value('/999/other-site/')
        start, end = ('2026-11-01', '2026-11-02') if width == 1440 else ('2026-11-03', '2026-11-04')
        field('Report purpose').select_option('overall')
        expect(field('Metric family')).to_have_value('total')
        expect(field('Metric family')).to_be_disabled()
        field('Report start date').fill(start)
        field('Report end date').fill(end)
        field('Report currency').fill('EUR')
        field('GAM report time zone').fill('Europe/Belgrade')
        field('Revenue basis').select_option('net')
        field('Revenue metric').select_option('cpm-cpc')
        field('GAM compatibility setting').select_option('off')
        for label in ['Ad unit', 'Device category', 'Country', 'Requested ad sizes', 'Clicks', 'Active View eligible impressions', 'Active View measurable impressions', 'Active View viewable impressions']:
            choice(label).check()
        shot(panel, 'purpose-and-scope', field('Report purpose'))
        shot(panel, 'dimensions-and-metrics', choice('Clicks'))
        open_ancestors(field('CSV header for VersionId'))
        field('CSV header for VersionId').fill('Package version')
        field('CSV header for date').fill('Report day')
        field('CSV header for date').focus()
        page.keyboard.press('Tab')
        check(f'{case_name}: source mapping is keyboard navigable', page.locator(':focus').count() == 1 and page.locator(':focus').evaluate('element=>element.tagName') == 'INPUT')
        shot(panel, 'configured', field('CSV header for VersionId'))
        # Explicit format selection preserves the detailed form while exposing
        # the existing immutable daily-summary flow.
        panel.get_by_role('button', name='Daily summary', exact=True).click()
        expect(panel.get_by_label('Saved reporting plan', exact=True)).to_be_visible()
        panel.get_by_role('button', name='Detailed report', exact=True).click()
        expect(field('Report start date')).to_have_value(start)
        expect(field('CSV header for VersionId')).to_have_value('Package version')
        check(f'{case_name}: switching to legacy daily summary preserves detailed input', True)
        before_status, before = api(BASE)
        assert before_status == 200, before
        mode['hold'] = ('POST', BASE)
        button('Save detailed report').click()
        expect(button('Save detailed report')).to_be_disabled()
        pending, saved_response = take_held()
        assert saved_response['status'] == 201, saved_response
        saved = json.loads(base64.b64decode(saved_response['body']))
        plan_id = saved['plan']['id']
        shot(panel, 'saving', button('Save detailed report'))
        pending.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Synthetic response lost after detailed plan commit; retry the same fields.'}))
        expect(detailed.get_by_role('alert').filter(has_text='Synthetic response lost after detailed plan commit')).to_be_visible()
        expect(field('Report currency')).to_have_value('EUR')
        expect(field('CSV header for VersionId')).to_have_value('Package version')
        mode['fail'] = ('GET', BASE + '/' + plan_id)
        button('Save detailed report').click()
        expect(detailed.get_by_role('alert').filter(has_text='Synthetic detailed report temporarily unavailable')).to_be_visible()
        shot(panel, 'detail-error')
        button('Retry detailed report').click()
        expect(field('Saved detailed report')).to_have_value(plan_id)
        expect(button('Download detailed CSV template')).to_be_visible()
        expect(button('Download detailed CSV template')).to_be_enabled()
        _, after = api(BASE)
        check(f'{case_name}: retry of uncertain save recovers a single immutable detailed plan', len(after['plans']) == len(before['plans']) + 1)
        plan = saved['plan']
        OUT.joinpath(f'{case_name}-saved-plan.json').write_text(json.dumps(saved, indent=2))
        check(f'{case_name}: plan records exact new identity, scope and explicit header mapping', plan['versionId'] == experiment['testId'] and plan['identityKey'] == 'VersionId' and plan['report']['sourceColumns']['VersionId'] == 'Package version' and plan['report']['scope'] == {'orderIds': [], 'lineItemIds': []})
        check(f'{case_name}: manually declared report is never claimed GAM-source verified', plan['source']['gamReportSourceVerified'] is False)
        check(f'{case_name}: visible GAM identity guidance agrees with this saved package', re.search(r'GAM key\s+' + re.escape(plan['identityKey']), detailed.inner_text()) is not None)
        with page.expect_download() as event:
            button('Download detailed CSV template').click()
        event.value.save_as(OUT / f'{case_name}-template.csv')
        template = Path(event.value.path()).read_text()
        template_headers = next(csv.reader(io.StringIO(template)))
        check(f'{case_name}: downloaded detailed template includes selected dimensions, metrics and source aliases', 'Package version' in template_headers and 'Report day' in template_headers and 'country' in template_headers and 'eligibleImpressions' in template_headers and len(template_headers) > 9)
        raw = report_csv(plan)
        OUT.joinpath(f'{case_name}-synthetic-import.csv').write_text(raw)
        _, storage_before = api('/__qa/inspect')
        field('Upload detailed GAM CSV').set_input_files({'name': 'synthetic-detailed-report.csv', 'mimeType': 'text/csv', 'buffer': raw.encode()})
        expect(field('Detailed GAM CSV')).to_have_value(raw)
        mode['hold'] = ('POST', BASE + '/' + plan_id + '/preview')
        button('Review detailed GAM CSV').click()
        expect(button('Review detailed GAM CSV')).to_be_disabled()
        pending, preview_response = take_held()
        assert preview_response['status'] == 200, preview_response
        fulfill(pending, preview_response)
        review = detailed.get_by_role('region', name='Detailed GAM CSV review', exact=True)
        expect(review).to_be_visible()
        expect(review).to_contain_text('9878.793219')
        expect(field('Break down by')).to_be_visible()
        field('Break down by').select_option('deviceCategory')
        expect(review).to_contain_text('Desktop')
        expect(review).to_contain_text('Mobile')
        review.locator('summary').filter(has_text=re.compile('^Desktop$')).click()
        expect(review.get_by_role('table', name='Device category: Desktop', exact=True)).to_be_visible()
        shot(panel, 'review', review)
        if width == 390:
            table = review.get_by_role('table', name='Device category: Desktop', exact=True)
            scroller = table.locator('..')
            scroll = scroller.evaluate('element=>{element.scrollLeft=element.scrollWidth;return {left:element.scrollLeft,width:element.clientWidth,content:element.scrollWidth};}')
            check('narrow table provides horizontal access without document overflow', scroll['content'] > scroll['width'] and scroll['left'] > 0)
            right = table.locator('thead th').last.bounding_box()
            container = scroller.bounding_box()
            check('narrow table scroll exposes the B column', right['x'] + right['width'] <= container['x'] + container['width'] + 1)
            shot(panel, 'review-scrolled-to-B', table)
        with page.expect_download() as event:
            button('Download detailed review JSON').click()
        event.value.save_as(OUT / f'{case_name}-review.json')
        exported = json.loads(Path(event.value.path()).read_text())
        check(f'{case_name}: review retains exact plan, financial context and imported CSV identity', exported['planId'] == plan_id and exported['source']['csvSha256'] == hashlib.sha256(raw.encode()).hexdigest() and exported['source']['metricFamily'] == 'total' and exported['source']['purpose'] == 'overall')
        check(f'{case_name}: rich imports never invent assignment coverage, page RPM or winners', exported['coverage'] == 'unknown' and exported['revenueReady'] is False and exported['winner'] is None and exported['upliftPercent'] is None and exported['totals']['A']['pageRpm'] is None)
        check(f'{case_name}: repeated daily rows at distinct selected grains aggregate correctly', exported['providedRows'] == 8 and exported['totals']['A']['impressions'] == 2200 and exported['totals']['B']['impressions'] == 2000 and exported['totals']['A']['revenue'] == '9878.793219')
        check(f'{case_name}: counts yield weighted viewability and preserve metric coverage', abs(exported['totals']['A']['viewabilityPercent'] - 100 * 1290 / 1980) < 0.000001 and exported['totals']['A']['metricCoverage']['viewableImpressions']['missing'] == 0)
        # Preview failure does not keep a previous result on the screen.
        mode['fail'] = ('POST', BASE + '/' + plan_id + '/preview')
        button('Review detailed GAM CSV').click()
        expect(detailed.get_by_role('alert').filter(has_text='Synthetic detailed report temporarily unavailable')).to_be_visible()
        expect(review).to_have_count(0)
        button('Review detailed GAM CSV').click()
        expect(review).to_be_visible()
        duplicate = raw + raw.splitlines()[1] + '\n'
        review_input(duplicate)
        expect(detailed.get_by_role('alert').filter(has_text=re.compile('duplicate', re.I))).to_be_visible()
        expect(review).to_have_count(0)
        shot(panel, 'csv-error', field('Detailed GAM CSV'))
        field('Upload detailed GAM CSV').set_input_files({'name': 'invalid.csv', 'mimeType': 'text/csv', 'buffer': b'\xff\xfeinvalid'})
        expect(detailed.get_by_role('alert').filter(has_text='UTF-8')).to_be_visible()
        field('Upload detailed GAM CSV').set_input_files({'name': 'valid.csv', 'mimeType': 'text/csv', 'buffer': raw.encode()})
        button('Review detailed GAM CSV').click()
        expect(review).to_be_visible()
        _, storage_after = api('/__qa/inspect')
        check(f'{case_name}: financial uploads, previews and failures do not persist CSV or change publisher data', storage_after == storage_before and not storage_after['financialDataPersisted'])
        # A separate Prebid report declares exact serving line-item scope and
        # cannot silently import an unrelated line item as whole-site results.
        prepare_form()
        field('Report purpose').select_option('prebid')
        expect(field('Metric family')).to_have_value('ad-server')
        expect(field('Metric family')).to_be_disabled()
        field('Prebid line-item IDs').fill('12345')
        expect(choice('Line item ID')).to_be_checked()
        choice('Primary bid origin').check()
        shot(panel, 'prebid-scope', field('Prebid line-item IDs'))
        button('Save detailed report').click()
        expect(field('Saved detailed report')).not_to_have_value(plan_id)
        prebid_id = field('Saved detailed report').input_value()
        status, prebid_saved = api(BASE + '/' + prebid_id)
        assert status == 200, prebid_saved
        prebid_plan = prebid_saved['plan']
        check(f'{case_name}: Prebid subset scope and Ad server family are immutable report context', prebid_plan['report']['purpose'] == 'prebid' and prebid_plan['report']['metricFamily'] == 'ad-server' and prebid_plan['report']['scope']['lineItemIds'] == ['12345'])
        review_input(report_csv(prebid_plan, bad_line_item=True))
        expect(detailed.get_by_role('alert').filter(has_text=re.compile('scope|line.item|filter', re.I))).to_be_visible()
        expect(review).to_have_count(0)
        shot(panel, 'scope-error', field('Detailed GAM CSV'))
        prebid_raw = report_csv(prebid_plan)
        review_input(prebid_raw)
        expect(review).to_be_visible()
        field('Break down by').select_option('aq_bid_origin')
        expect(review).to_contain_text('cached')
        expect(review).to_contain_text('fresh')
        review.locator('summary').filter(has_text=re.compile('^cached$')).click()
        expect(review.get_by_role('table', name='Primary bid origin: cached', exact=True)).to_be_visible()
        shot(panel, 'prebid-review', review)
        # A late financial response cannot be displayed in another site.
        mode['hold'] = ('POST', BASE + '/' + prebid_id + '/preview')
        button('Review detailed GAM CSV').click()
        pending, snapshot = take_held()
        menu = page.get_by_role('button', name='Menu', exact=True)
        if menu.is_visible():
            menu.click()
        page.locator('.site-link').filter(has_text='tanjug.rs').click()
        fulfill(pending, snapshot)
        expect(page.locator('.tabbar .active')).to_have_text('Measurement')
        expect(page.get_by_role('region', name='Detailed GAM CSV review', exact=True)).to_have_count(0)
        check(f'{case_name}: site switch discards late financial preview', '9878.793219' not in page.locator('body').inner_text())
        _, inspection = api('/__qa/inspect')
        check(f'{case_name}: only explicit setup and new v2 plans are saved; original packages stay unchanged', inspection['originalObjectsUnchanged'] and inspection['siteUnchanged'] and inspection['inventoryUnchanged'] and inspection['configUnchanged'] and inspection['otherSiteUnchanged'] and all(key in setup_keys or '/measurement-v2/' in key for key in inspection['newKeys']))
        check(f'{case_name}: fixture never sends outbound traffic', inspection['outboundRequests'] == 0)
        page.close()
    check('No browser JavaScript errors', not errors)
    check('No external browser traffic', not external)
    OUT.joinpath('result.json').write_text(json.dumps({'passed': True, 'sourceCommit': source_commit, 'setup': {'path': '/api/publishers/other-site/ab-tests', 'method': 'POST', 'name': record['name'], 'versionId': record['testId'], 'loader': record['loader']['version'], 'newKeys': sorted(setup_keys)}, 'checks': checks, 'requests': requests, 'geometry': geometries, 'errors': errors, 'external': external, 'scope': fixture['scope']}, indent=2))
    print(json.dumps({'passed': True, 'checks': len(checks), 'cases': ['width-1440', 'width-390']}))
except Exception as error:
    if page is not None:
        try:
            page.screenshot(path=str(OUT / f'{case_name}-failure.png'))
        except Exception:
            pass
    OUT.joinpath('failure.json').write_text(json.dumps({'error': str(error), 'checks': checks, 'requests': requests, 'geometry': geometries, 'errors': errors, 'external': external}, indent=2))
    raise
finally:
    if browser is not None:
        browser.close()
    if playwright is not None:
        playwright.stop()
    if process is not None:
        process.stdin.close()
        process.wait(timeout=10)
