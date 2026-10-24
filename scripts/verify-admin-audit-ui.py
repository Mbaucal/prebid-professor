"""Actual MAIN React/Worker audit regressions; SQLite/fake R2, no hosted ad traffic."""
import base64,json,os,subprocess,argparse
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
parser=argparse.ArgumentParser();parser.add_argument('--runtime',default='3.16.0');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent;out=root/'.generated/admin-audit-ui-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://admin-audit.fixture.invalid';endpoint='/api/publishers/main-site/builtin-site-settings';results=[]
with sync_playwright() as pw:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=pw.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/admin-audit-browser-fixture.mjs','--runtime='+args.runtime],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(proc.stdout.readline());assert ready['ready'] and ready['runtimeVersion']==args.runtime
   requests=[];errors=[];page=browser.new_page(viewport={'width':width,'height':1000});page.on('pageerror',lambda error:errors.append(str(error)))
   def send(path,method='GET',body=None):
    proc.stdin.write(json.dumps({'path':path,'method':method,'body':None if body is None else json.dumps(body)})+'\n');proc.stdin.flush();value=json.loads(proc.stdout.readline());assert 'error' not in value,value;return value
   def data(path):
    value=send(path);assert value['status']==200,value;return json.loads(base64.b64decode(value['body']))
   def route(route):
    request=route.request;url=urlsplit(request.url);assert url.netloc=='admin-audit.fixture.invalid','Unexpected external request'
    value=send(url.path,request.method,json.loads(request.post_data) if request.post_data else None);requests.append({'path':url.path,'method':request.method,'status':value['status']});route.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
   page.route('**/*',route)
   def screen(name,target=None):
    if target is not None:target.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal document overflow'
    page.screenshot(path=str(out/f'{args.runtime}-{name}-{width}.png'),full_page=True)
   def nav(name):page.get_by_role('button',name=name,exact=True).first.click()
   try:
    page.goto(origin+'/',wait_until='domcontentloaded');panel=page.get_by_role('region',name='Script setup',exact=True)
    expect(panel.get_by_text('User ID settings have not been saved.',exact=False)).to_be_visible()
    if ready['gapSupported']:
     expect(panel.get_by_text('Minimum wall-clock gap is saved',exact=False)).to_have_count(0)
     expect(panel.get_by_text('Refresh is disabled by this script',exact=False)).to_have_count(0)
    else:
     expect(panel.get_by_text('Minimum wall-clock gap is saved',exact=False)).to_be_visible()
     expect(panel.get_by_text('Refresh is disabled by this script',exact=False)).to_be_visible()
    screen('setup-warnings')
    nav('Unit rules');expect(page.get_by_role('heading',name='Effective behavior by ad unit',exact=True)).to_be_visible()
    row=page.locator('table.effective-rule-table tbody tr').filter(has=page.get_by_text('P1',exact=True));expect(row).to_have_count(1)
    expect(row.locator('td').nth(4)).to_contain_text('Sequence schedule' if ready['gapSupported'] else 'Disabled')
    if not ready['gapSupported']:expect(row.locator('td').nth(4)).to_contain_text('global refresh switch is off')
    screen('effective-refresh',page.locator('table.effective-rule-table'))
    before=data('/__fixture/snapshot')
    page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True)).get_by_role('button',name='Edit',exact=True).click()
    dialog=page.get_by_role('dialog');expect(dialog).to_be_visible();timeout=dialog.locator('input[type="number"][min="100"]');expect(timeout).to_have_attribute('max','30000');timeout.fill('1200');minimum=dialog.get_by_label('Minimum time',exact=False);minimum.fill('60');dialog.get_by_role('button',name='Save rule',exact=True).click()
    expect(dialog.locator('.form-error')).to_contain_text('Refresh schedules');expect(timeout).to_have_value('1200');expect(minimum).to_have_value('60');assert data('/__fixture/snapshot')==before,'Rejected save changed stored settings'
    screen('sequence-save-conflict',dialog.locator('.form-error'))
    minimum.fill('15');dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0);expect(row.locator('td').nth(2)).to_contain_text('1200 ms');after=data('/__fixture/snapshot');assert after['config']['advancedUnitRules']['P1']['timeout']==1200;assert after['config']['advancedUnitRules']['P1']['refresh']['schedule']==before['config']['advancedUnitRules']['P1']['refresh']['schedule'];screen('sequence-save-recovered',row)
    nav('Refresh schedules');expect(page.get_by_label('Prebid auction timeout',exact=False)).to_have_attribute('max','30000');screen('refresh-timeout-limit')
    nav('User ID modules');expect(page.get_by_text('Existing generated scripts use cookie sync off.',exact=False)).to_be_visible();screen('user-sync-unsaved')
    data('/__fixture/explicit-sync-off');off=data('/__fixture/snapshot')['config']['userSync'];nav('Script setup');expect(panel.get_by_role('radio',name='GAM + Prebid',exact=False)).to_be_checked();panel.get_by_role('radio',name='GAM / AdX only',exact=False).check();panel.get_by_role('button',name='Save script setup',exact=True).click();expect(panel.get_by_role('status').filter(has_text='Script setup saved')).to_be_visible()
    panel.get_by_role('radio',name='GAM + Prebid',exact=False).check();panel.get_by_role('button',name='Save script setup',exact=True).click();expect(panel.get_by_role('status').filter(has_text='Script setup saved')).to_be_visible();assert data('/__fixture/snapshot')['config']['userSync']==off;expect(panel.get_by_text('User ID settings have not been saved.',exact=False)).to_have_count(0);screen('explicit-sync-off-preserved')
    nav('Generate and releases');expect(page.get_by_role('button',name='Generate and save package',exact=True)).to_be_enabled()
    if ready['gapSupported']:expect(page.get_by_text('Minimum wall-clock gap is saved',exact=False)).to_have_count(0)
    else:expect(page.get_by_text('Minimum wall-clock gap is saved',exact=False)).to_be_visible()
    screen('generate-warnings')
    # R2-03: a Unit rules interval stays in effect under an inherited Refresh schedule.
    nav('Unit rules');page.get_by_role('button',name='＋ New rule',exact=True).click();dialog=page.get_by_role('dialog');dialog.get_by_label('Rule target',exact=False).select_option(label='Billboard · ATF')
    dialog.locator('section.rule-form-section').filter(has_text='Viewability refresh guard').get_by_label('Override inherited value',exact=True).check();dialog.get_by_label('Minimum time',exact=False).fill('60');dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
    assert 'Billboard' not in (data('/__fixture/snapshot')['config'].get('advancedUnitRules') or {}),'No inherited schedule yet: nothing extra is saved'
    nav('Refresh schedules');expect(page.get_by_role('heading',name='Timeouts for __DEFAULT__',exact=True)).to_be_visible();page.get_by_label('Refresh enabled',exact=True).check();page.locator('.schedule-mode-grid label').filter(has_text='Same every time').locator('input').check();page.get_by_label('Every refresh',exact=False).fill('30')
    page.get_by_role('button',name='Save __DEFAULT__',exact=True).click();message=page.locator('.advanced-save-message');expect(message).to_have_text('✓ Saved __DEFAULT__. This schedule currently applies to no ad unit. Billboard keeps its own interval from Unit rules.')
    saved=data('/__fixture/snapshot')['config']['advancedUnitRules'];assert saved['Billboard']['refresh']['schedule']['fixedSeconds']==60,saved;assert saved['__DEFAULT__']['refresh']['schedule']['fixedSeconds']==30,saved;screen('refresh-kept-interval',message)
    nav('Unit rules');billboard=page.locator('table.effective-rule-table tbody tr').filter(has=page.get_by_text('Billboard',exact=True));expect(billboard.locator('td').nth(4)).to_contain_text('60s · 50%')
    expect(page.get_by_text('Unit rules is not used',exact=False)).to_have_count(0);screen('unit-rules-kept-interval',page.locator('table.effective-rule-table'))
    # Exact-rule data saved before this fix: reported with the interval the script uses, then repaired by saving the rule.
    data('/__fixture/legacy-shadowed-interval');page.get_by_role('button',name='Reload rules',exact=True).click();warning=page.get_by_role('status').filter(has_text='Unit rules is not used')
    expect(warning).to_have_text('The refresh interval saved in Unit rules is not used for: Billboard (45s; the script uses the inherited Default schedule: 30s). If the inherited schedule is intended, remove the refresh override from that rule in Unit rules. To use the saved interval, edit and save the rule in Unit rules, or set “Same every time” for it in Refresh schedules.')
    expect(billboard.locator('td').nth(4)).to_contain_text('30s · 50%');screen('unit-rules-legacy-warning',warning)
    nav('Script setup');expect(panel.get_by_text('Unit rules is not used for: Billboard (45s',exact=False)).to_be_visible()
    nav('Generate and releases');generate_warning=page.get_by_text('Unit rules is not used for: Billboard (45s',exact=False);expect(generate_warning).to_be_visible();screen('generate-legacy-warning',generate_warning);nav('Unit rules')
    page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='Billboard',exact=True)).get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');expect(dialog.get_by_label('Minimum time',exact=False)).to_have_value('45');dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
    expect(warning).to_have_count(0);expect(billboard.locator('td').nth(4)).to_contain_text('45s · 50%');assert data('/__fixture/snapshot')['config']['advancedUnitRules']['Billboard']['refresh']['schedule']['fixedSeconds']==45
    notice=page.locator('.unit-rules-notice');expect(notice).to_have_text('Billboard uses its own refresh interval from Unit rules instead of an inherited Refresh schedule. Refresh schedules shows it as “Same every time”.');screen('unit-rules-legacy-repaired',billboard)
    # Onboarding: a site-wide sequence, then Create base rules. The presets follow the schedule; an interval typed for a group is used.
    nav('Refresh schedules');expect(page.get_by_role('heading',name='Timeouts for __DEFAULT__',exact=True)).to_be_visible();page.locator('.schedule-mode-grid label').filter(has_text='Explicit sequence').locator('input').check();page.get_by_label('Intervals, in seconds',exact=False).fill('20, 40, 80')
    page.get_by_role('button',name='Save __DEFAULT__',exact=True).click();message=page.locator('.advanced-save-message');expect(message).to_contain_text('Saved __DEFAULT__.');assert data('/__fixture/snapshot')['config']['advancedUnitRules']['__DEFAULT__']['refresh']['schedule']['sequenceSeconds']==[20,40,80]
    nav('Unit rules');page.get_by_role('button',name='Create base rules',exact=True).click();expect(page.get_by_role('button',name='Create base rules',exact=True)).to_have_count(0);expect(page.locator('article.unit-rule-card.reserved.configured')).to_have_count(3)
    saved=data('/__fixture/snapshot');assert {'__ATF__','__BTF__'}<={r['rule_key'] for r in saved['rules']},saved['rules'];assert not {'__ATF__','__BTF__'}&set(saved['config']['advancedUnitRules']),'Base-rule presets must not get their own schedule';expect(page.locator('.unit-rules-notice')).to_have_count(0)
    page.once('dialog',lambda dialog:dialog.accept());page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='Billboard',exact=True)).get_by_role('button',name='Delete',exact=True).click()
    expect(page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='Billboard',exact=True))).to_have_count(0);assert 'Billboard' not in data('/__fixture/snapshot')['config']['advancedUnitRules']
    expect(billboard.locator('td').nth(4)).to_contain_text('Sequence schedule');expect(billboard.locator('td').nth(4)).to_contain_text('Uses the inherited Default schedule (20s, 40s, 80s…); the 30s interval saved for ATF group in Unit rules is not used.')
    expect(page.get_by_text('Unit rules is not used for',exact=False)).to_have_count(0);screen('unit-rules-base-follow',page.locator('table.effective-rule-table'))
    page.locator('article.unit-rule-card.reserved').filter(has=page.get_by_role('heading',name='__ATF__',exact=True)).get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');minimum=dialog.get_by_label('Minimum time',exact=False);expect(minimum).to_have_value('30');minimum.fill('45');dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
    expect(notice).to_have_text('ATF group uses its own refresh interval from Unit rules instead of an inherited Refresh schedule. Refresh schedules shows it as “Same every time”.');expect(billboard.locator('td').nth(4)).to_contain_text('45s · 60%')
    assert data('/__fixture/snapshot')['config']['advancedUnitRules']['__ATF__']['refresh']['schedule']['fixedSeconds']==45;screen('unit-rules-group-kept',notice)
    # R2-02: the rule is deleted in another tab while this tab edits it; nothing may be saved and the entries stay.
    nav('Unit rules');page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True)).get_by_role('button',name='Edit',exact=True).click()
    dialog=page.get_by_role('dialog');expect(dialog).to_be_visible();timeout=dialog.locator('input[type="number"][min="100"]');timeout.fill('1300')
    assert send('/api/publishers/main-site/unit-rules/p1-rule','DELETE')['status']==200;deleted=data('/__fixture/snapshot');assert not any(r['rule_key']=='P1' for r in deleted['rules'])
    dialog.get_by_role('button',name='Save rule',exact=True).click();error=dialog.locator('.form-error')
    expect(error).to_contain_text('deleted in another tab');expect(error).to_contain_text('Your entries are kept');expect(timeout).to_have_value('1300')
    expect(dialog.get_by_role('heading',name='Create unit rule',exact=True)).to_be_visible();assert data('/__fixture/snapshot')==deleted,'Refused save changed stored settings'
    screen('deleted-rule-save-refused',error)
    dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
    recreated=data('/__fixture/snapshot');assert [json.loads(r['rule_json'])['timeout'] for r in recreated['rules'] if r['rule_key']=='P1']==[1300];assert recreated['config']['unitRules']['P1']['timeout']==1300
    assert not errors,errors
    assert any(r['status']==409 and 'unit-rules' in r['path'] for r in requests)
    assert any(r['status']==404 and r['method']=='PATCH' and 'unit-rules' in r['path'] for r in requests)
    results.append({'runtime':args.runtime,'width':width,'passed':True,'gapSupported':ready['gapSupported'],'pageErrors':errors,'externalRequests':0,'requests':requests,'scope':'Actual MAIN components and authenticated Worker with local SQLite/fake R2'})
    print('PASS audit UI and saved settings',args.runtime,width)
   except Exception:
    screen('failure');raise
   finally:page.close();proc.stdin.close();proc.wait(timeout=10)
 finally:browser.close()
(out/f'result-{args.runtime}.json').write_text(json.dumps({'passed':True,'checks':results},indent=2))
