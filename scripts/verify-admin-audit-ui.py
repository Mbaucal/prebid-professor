"""Actual MAIN React/Worker audit regressions; SQLite/fake R2, no hosted ad traffic."""
import base64,json,os,subprocess,argparse
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
parser=argparse.ArgumentParser();parser.add_argument('--runtime',default='3.16.0');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent;out=root/'.generated/admin-audit-ui-evidence';out.mkdir(parents=True,exist_ok=True)
USER_ID_CONFLICT='Other site settings were saved at the same time, so nothing was saved. Select Save again.'
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
   refuse_user_id=[]
   def route(route):
    request=route.request;url=urlsplit(request.url);assert url.netloc=='admin-audit.fixture.invalid','Unexpected external request'
    if refuse_user_id and request.method=='PUT' and url.path.endswith('/user-id-config'):
     refuse_user_id.clear();requests.append({'path':url.path,'method':request.method,'status':409});route.fulfill(status=409,headers={'content-type':'application/json'},body=json.dumps({'ok':False,'error':USER_ID_CONFLICT}));return
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
    # Point 3a: this tab loaded P1 before another tab saved it. Only the fields changed here are carried onto the saved rule;
    # a field both tabs changed is listed with both values and keeps this tab's value for review.
    def p1_rule():return next(r for r in data('/api/publishers/main-site/unit-rules')['unitRules'] if r['ruleKey']=='P1')
    page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True)).get_by_role('button',name='Edit',exact=True).click()
    dialog=page.get_by_role('dialog');timeout=dialog.locator('input[type="number"][min="100"]');minimum=dialog.get_by_label('Minimum time',exact=False);check=dialog.get_by_label('Check interval',exact=False)
    timeout.fill('1400');minimum.fill('90')
    p1=p1_rule();assert send('/api/publishers/main-site/unit-rules/'+p1['id'],'PATCH',{'rule':{**p1['rule'],'refresh':{**p1['rule']['refresh'],'minSeconds':75,'checkEveryMs':4000}},'expectedUpdatedAt':p1['updatedAt']})['status']==200;changed=data('/__fixture/snapshot')
    dialog.get_by_role('button',name='Save rule',exact=True).click();error=dialog.locator('.form-error');review=dialog.locator('.edit-rebase-review')
    expect(error).to_have_text('This rule was changed in another tab, so nothing was saved. The dialog now shows the saved rule with your changes applied. Review it and select Save rule again.')
    expect(review).to_contain_text('Also changed in the other tab. The form keeps your value; check it before saving:');expect(review.locator('li')).to_have_count(1)
    expect(review.locator('li')).to_have_text('Minimum time: yours 90 sec, saved in the other tab 75 sec');expect(review).to_contain_text('Your other changes are applied: Timeout.')
    expect(timeout).to_have_value('1400');expect(minimum).to_have_value('90');expect(check).to_have_value('4000');assert data('/__fixture/snapshot')==changed,'Stale save changed stored settings';screen('stale-rule-save-rebased',review)
    dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
    saved=json.loads(next(r['rule_json'] for r in data('/__fixture/snapshot')['rules'] if r['rule_key']=='P1'));assert saved['timeout']==1400 and saved['refresh']['minSeconds']==90 and saved['refresh']['checkEveryMs']==4000,saved
    # The same in Refresh schedules: the form and its row version come from one read, and another tab saves P1 meanwhile.
    def p1_row():return data('/api/publishers/main-site/unit-rules-advanced')['unitRuleRows']['P1']
    def other_tab(refresh):row=p1_row();assert send('/api/publishers/main-site/unit-rules-advanced/P1','PUT',{'expectedUpdatedAt':row['updatedAt'],'expectedUnitRuleId':row['id'],'refresh':refresh})['status']==200;return data('/__fixture/snapshot')
    nav('Refresh schedules');page.locator('.advanced-target-list button').filter(has_text='P1 · BTF').click();expect(page.get_by_role('heading',name='Timeouts for P1',exact=True)).to_be_visible()
    auction=page.get_by_label('Prebid auction timeout',exact=False);every=page.get_by_label('Every refresh',exact=False);most=page.get_by_label('Maximum refreshes',exact=False);expect(every).to_have_value('90')
    auction.fill('1500');every.fill('100')
    changed=other_tab({'maxRefreshes':12,'schedule':{'mode':'fixed','fixedSeconds':110}})
    page.get_by_role('button',name='Save P1',exact=True).click();error=page.locator('.advanced-refresh-page .form-error');review=page.locator('.advanced-refresh-page .edit-rebase-review')
    expect(error).to_have_text('P1 was changed in another tab, so nothing was saved. The form now shows the saved settings with your changes applied. Review them and select Save P1 again.')
    expect(review.locator('li')).to_have_count(1);expect(review.locator('li')).to_have_text('Every refresh: yours 100 sec, saved in the other tab 110 sec');expect(review).to_contain_text('Your other changes are applied: Prebid auction timeout.')
    expect(auction).to_have_value('1500');expect(every).to_have_value('100');expect(most).to_have_value('12');assert data('/__fixture/snapshot')==changed,'Stale save changed stored settings';screen('stale-refresh-save-rebased',review)
    page.get_by_role('button',name='Save P1',exact=True).click();expect(page.locator('.advanced-save-message')).to_contain_text('Saved P1.');expect(error).to_have_count(0);expect(review).to_have_count(0)
    saved=data('/__fixture/snapshot')['config']['advancedUnitRules']['P1'];assert saved['timeout']==1500 and saved['refresh']['schedule']['fixedSeconds']==100 and saved['refresh']['maxRefreshes']==12,saved
    # After its own save the tab saves against the version that save returned: a later save from another tab is not overwritten.
    changed=other_tab({'maxRefreshes':15});auction.fill('1600')
    page.get_by_role('button',name='Save P1',exact=True).click();expect(error).to_contain_text('P1 was changed in another tab, so nothing was saved.')
    expect(review.locator('li')).to_have_count(0);expect(review).to_have_text('Your changes are applied: Prebid auction timeout.');expect(most).to_have_value('15');expect(every).to_have_value('100');expect(auction).to_have_value('1600')
    assert data('/__fixture/snapshot')==changed,'Save from the earlier baseline changed stored settings';screen('saved-refresh-baseline-rebased',review)
    page.get_by_role('button',name='Save P1',exact=True).click();expect(page.locator('.advanced-save-message')).to_contain_text('Saved P1.')
    saved=data('/__fixture/snapshot')['config']['advancedUnitRules']['P1'];assert saved['timeout']==1600 and saved['refresh']['maxRefreshes']==15 and saved['refresh']['schedule']['fixedSeconds']==100,saved
    # The other tab switched the strategy while this tab changed a value only the old strategy uses: the strategy is the conflict,
    # this tab's strategy stays selected so the entered value takes effect, and a second Save stores it.
    fixed=page.locator('.schedule-mode-grid label').filter(has_text='Same every time').locator('input');every.fill('120');changed=other_tab({'schedule':{'mode':'sequence','sequenceSeconds':[20,40]}})
    page.get_by_role('button',name='Save P1',exact=True).click()
    expect(error).to_have_text('P1 was changed in another tab, so nothing was saved. The form now shows the saved settings with your changes applied. Review them and select Save P1 again.')
    expect(review.locator('li')).to_have_count(1);expect(review.locator('li')).to_have_text('Interval strategy: yours Same every time, saved in the other tab Explicit sequence (Intervals, in seconds: 20, 40)');expect(review).to_contain_text('Your other changes are applied: Every refresh.')
    expect(fixed).to_be_checked();expect(every).to_have_value('120');assert data('/__fixture/snapshot')==changed,'Stale save changed stored settings';screen('stale-refresh-strategy-conflict',review)
    page.get_by_role('button',name='Save P1',exact=True).click();expect(page.locator('.advanced-save-message')).to_contain_text('Saved P1.')
    saved=data('/__fixture/snapshot')['config']['advancedUnitRules']['P1']['refresh']['schedule'];assert saved['mode']=='fixed' and saved['fixedSeconds']==120 and saved['sequenceSeconds']==[20,40],saved
    # Nothing was changed in this tab: the refusal says so and the form shows the other tab's settings.
    changed=other_tab({'maxRefreshes':18});page.get_by_role('button',name='Save P1',exact=True).click()
    expect(error).to_have_text('P1 was changed in another tab, so nothing was saved. You had not changed anything here, so the form now shows the settings saved in the other tab.')
    expect(review).to_have_count(0);expect(most).to_have_value('18');expect(every).to_have_value('120');assert data('/__fixture/snapshot')==changed,'Stale save changed stored settings'
    # The other way round: this tab switched the strategy while the other tab changed the old strategy's interval. The strategy is the
    # conflict and names that value, which this tab's switch would otherwise stop applying unseen; choosing it again shows the value.
    sequence=page.locator('.schedule-mode-grid label').filter(has_text='Explicit sequence').locator('input');sequence.check();intervals=page.get_by_label('Intervals, in seconds',exact=False);intervals.fill('30, 60')
    changed=other_tab({'schedule':{'mode':'fixed','fixedSeconds':130}});page.get_by_role('button',name='Save P1',exact=True).click()
    expect(error).to_have_text('P1 was changed in another tab, so nothing was saved. The form now shows the saved settings with your changes applied. Review them and select Save P1 again.')
    expect(review.locator('li')).to_have_count(1);expect(review.locator('li')).to_have_text('Interval strategy: yours Explicit sequence, saved in the other tab Same every time (Every refresh: 130 sec)');expect(review).to_contain_text('Your other changes are applied: Intervals, in seconds.')
    expect(sequence).to_be_checked();expect(intervals).to_have_value('30, 60');assert data('/__fixture/snapshot')==changed,'Stale save changed stored settings';screen('stale-refresh-strategy-switched-here',review)
    fixed.check();expect(every).to_have_value('130');page.get_by_role('button',name='Save P1',exact=True).click();expect(page.locator('.advanced-save-message')).to_contain_text('Saved P1.')
    saved=data('/__fixture/snapshot')['config']['advancedUnitRules']['P1']['refresh']['schedule'];assert saved['mode']=='fixed' and saved['fixedSeconds']==130 and saved['sequenceSeconds']==[30,60],saved
    # Unit rules: the other tab removed the refresh override while this tab changed Minimum time. The override is the conflict; it stays
    # on so the entered value keeps its effect, and the section keeps the values this dialog showed (not form defaults).
    nav('Unit rules');p1=p1_rule();assert p1['rule'].get('refresh'),p1
    page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True)).get_by_role('button',name='Edit',exact=True).click()
    dialog=page.get_by_role('dialog');minimum=dialog.get_by_label('Minimum time',exact=False);check=dialog.get_by_label('Check interval',exact=False);checked=str(p1['rule']['refresh']['checkEveryMs'])
    override=dialog.locator('section.rule-form-section').filter(has_text='Viewability refresh guard').get_by_label('Override inherited value',exact=True);expect(override).to_be_checked();expect(check).to_have_value(checked);minimum.fill('20')
    assert send('/api/publishers/main-site/unit-rules/'+p1['id'],'PATCH',{'rule':{key:value for key,value in p1['rule'].items() if key!='refresh'},'expectedUpdatedAt':p1['updatedAt']})['status']==200;changed=data('/__fixture/snapshot')
    assert 'refresh' not in json.loads(next(r['rule_json'] for r in changed['rules'] if r['rule_key']=='P1'))
    dialog.get_by_role('button',name='Save rule',exact=True).click();error=dialog.locator('.form-error');review=dialog.locator('.edit-rebase-review')
    expect(error).to_have_text('This rule was changed in another tab, so nothing was saved. The dialog now shows the saved rule with your changes applied. Review it and select Save rule again.')
    expect(review.locator('li')).to_have_count(1);expect(review.locator('li')).to_have_text('Override inherited refresh: yours on, saved in the other tab off (inherited)');expect(review).to_contain_text('Your other changes are applied: Minimum time.')
    expect(override).to_be_checked();expect(minimum).to_have_value('20');expect(check).to_have_value(checked);assert data('/__fixture/snapshot')==changed,'Stale save changed stored settings';screen('stale-rule-override-conflict',review)
    dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
    saved=json.loads(next(r['rule_json'] for r in data('/__fixture/snapshot')['rules'] if r['rule_key']=='P1'));assert saved['refresh']['minSeconds']==20 and str(saved['refresh']['checkEveryMs'])==checked,saved
    # The other way round: this tab turned the refresh override off while the other tab changed Minimum time. The override is the
    # conflict and names the other tab's value, which this tab's switch would drop unseen; turning the override on again shows it.
    p1=p1_rule();page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True)).get_by_role('button',name='Edit',exact=True).click()
    dialog=page.get_by_role('dialog');minimum=dialog.get_by_label('Minimum time',exact=False);override=dialog.locator('section.rule-form-section').filter(has_text='Viewability refresh guard').get_by_label('Override inherited value',exact=True)
    expect(override).to_be_checked();expect(minimum).to_have_value('20');override.uncheck()
    assert send('/api/publishers/main-site/unit-rules/'+p1['id'],'PATCH',{'rule':{**p1['rule'],'refresh':{**p1['rule']['refresh'],'minSeconds':35}},'expectedUpdatedAt':p1['updatedAt']})['status']==200;changed=data('/__fixture/snapshot')
    dialog.get_by_role('button',name='Save rule',exact=True).click();error=dialog.locator('.form-error');review=dialog.locator('.edit-rebase-review')
    expect(error).to_have_text('This rule was changed in another tab, so nothing was saved. The dialog now shows the saved rule with your changes applied. Review it and select Save rule again.')
    expect(review.locator('li')).to_have_count(1);expect(review.locator('li')).to_have_text('Override inherited refresh: yours off (inherited), saved in the other tab on (Minimum time: 35 sec)');expect(review).not_to_contain_text('changes are applied')
    expect(override).not_to_be_checked();assert data('/__fixture/snapshot')==changed,'Stale save changed stored settings';screen('stale-rule-override-off-here',review)
    override.check();expect(minimum).to_have_value('35');dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
    saved=json.loads(next(r['rule_json'] for r in data('/__fixture/snapshot')['rules'] if r['rule_key']=='P1'));assert saved['refresh']['minSeconds']==35 and str(saved['refresh']['checkEveryMs'])==checked,saved
    # D4: a User ID save the Worker refuses with 409 keeps every entry, and Save again stores it. The Worker's 409 needs a second
    # save inside one D1 round trip (covered in admin-unit-rule-concurrency.test.mjs), so the browser gets that 409 body here.
    nav('User ID modules');delay=page.get_by_label('Auction delay',exact=False);expect(delay).to_be_visible();delay.fill('275');refuse_user_id.append(True)
    page.get_by_role('button',name='Save User ID config',exact=True).click();error=page.locator('.form-error.config-error')
    expect(error).to_have_text(USER_ID_CONFLICT);expect(delay).to_have_value('275');screen('user-id-save-refused',error)
    page.get_by_role('button',name='Save User ID config',exact=True).click();expect(page.get_by_text('User ID configuration saved.',exact=False)).to_be_visible();expect(error).to_have_count(0)
    assert data('/__fixture/snapshot')['config']['userIdConfig']['auctionDelay']==275
    # A Unit rules interval kept under the Default sequence: Refresh schedules shows its Unit rules timeout, and saving it unchanged keeps both.
    assert recreated['config']['advancedUnitRules']['__DEFAULT__']['refresh']['schedule']['sequenceSeconds']==[20,40,80]
    nav('Unit rules');page.once('dialog',lambda dialog:dialog.accept());page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True)).get_by_role('button',name='Delete',exact=True).click()
    expect(page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True))).to_have_count(0);assert 'P1' not in data('/__fixture/snapshot')['config']['advancedUnitRules']
    page.get_by_role('button',name='＋ New rule',exact=True).click();dialog=page.get_by_role('dialog');dialog.get_by_label('Rule target',exact=False).select_option(label='P1 · BTF')
    auction=dialog.locator('section.rule-form-section').filter(has_text='Prebid timeout');auction.get_by_label('Override inherited value',exact=True).check();auction.locator('input[type="number"]').fill('1800')
    dialog.locator('section.rule-form-section').filter(has_text='Viewability refresh guard').get_by_label('Override inherited value',exact=True).check();dialog.get_by_label('Minimum time',exact=False).fill('60');dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
    expect(row.locator('td').nth(2)).to_contain_text('1800 ms');expect(row.locator('td').nth(4)).to_contain_text('60s')
    nav('Refresh schedules');page.locator('.advanced-target-list button').filter(has_text='P1 · BTF').click();expect(page.get_by_role('heading',name='Timeouts for P1',exact=True)).to_be_visible()
    expect(page.get_by_label('Prebid auction timeout',exact=False)).to_have_value('1800');expect(page.locator('.schedule-mode-grid label').filter(has_text='Same every time').locator('input')).to_be_checked();expect(page.get_by_label('Every refresh',exact=False)).to_have_value('60')
    screen('refresh-kept-timeout',page.locator('.advanced-refresh-form'))
    page.get_by_role('button',name='Save P1',exact=True).click();expect(page.locator('.advanced-save-message')).to_contain_text('Saved P1.')
    kept=data('/__fixture/snapshot');rule=[json.loads(r['rule_json']) for r in kept['rules'] if r['rule_key']=='P1'];assert len(rule)==1 and rule[0]['timeout']==1800 and rule[0]['refresh']['minSeconds']==60,rule
    assert kept['config']['advancedUnitRules']['P1']['timeout']==1800 and kept['config']['advancedUnitRules']['P1']['refresh']['schedule']['fixedSeconds']==60,kept['config']['advancedUnitRules']['P1']
    nav('Unit rules');expect(row.locator('td').nth(2)).to_contain_text('1800 ms');expect(row.locator('td').nth(4)).to_contain_text('60s');expect(page.get_by_text('Unit rules is not used',exact=False)).to_have_count(0);screen('unit-rules-kept-timeout',row)
    # Ad units: an ATF/BTF group change keeps an interval saved in Unit rules and says so; a copy carries P1's rule and kept 60 s; a copy that loses a race is refused with the entries kept, and the retry copies the current settings.
    assert send('/api/publishers/main-site/unit-rules','POST',{'ruleKey':'Billboard','rule':{'refresh':{'enabled':True,'minSeconds':45}}})['status']==201;assert 'Billboard' not in data('/__fixture/snapshot')['config']['advancedUnitRules'],'45 s follows the ATF group'
    nav('Ad units');board=page.locator('.ad-unit-board');card=lambda code:board.locator('.ad-unit-card').filter(has=page.locator('code').get_by_text(code,exact=True));notice=page.locator('.ad-units-notice')
    card('Billboard').get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');dialog.get_by_label('Inventory group',exact=False).select_option('BTF');dialog.get_by_role('button',name='Save changes',exact=True).click();expect(dialog).to_have_count(0)
    expect(notice).to_have_text('Billboard uses its own refresh interval from Unit rules instead of an inherited Refresh schedule. Refresh schedules shows it as “Same every time”.');expect(board.locator('.ad-unit-column').nth(1).locator('code').get_by_text('Billboard',exact=True)).to_be_visible()
    moved=data('/__fixture/snapshot')['config']['advancedUnitRules']['Billboard'];assert moved['refresh']['schedule']['fixedSeconds']==45,moved;screen('ad-units-group-kept',notice)
    card('P1').get_by_role('button',name='Duplicate',exact=True).click();dialog=page.get_by_role('dialog');code=dialog.get_by_label('Ad unit code / div ID',exact=False);expect(code).to_have_value('P1_2');expect(dialog.get_by_label('Copy exact unit rule',exact=True)).to_be_checked()
    dialog.get_by_role('button',name='Duplicate ad unit',exact=True).click();expect(dialog).to_have_count(0);expect(card('P1_2')).to_be_visible();expect(notice).to_have_count(0)
    copied=data('/__fixture/snapshot');rule={r['rule_key']:json.loads(r['rule_json']) for r in copied['rules']};assert rule['P1_2']==rule['P1'] and rule['P1_2']['timeout']==1800,rule;assert copied['config']['advancedUnitRules']['P1_2']==copied['config']['advancedUnitRules']['P1'],copied['config']['advancedUnitRules']
    card('P1').get_by_role('button',name='Duplicate',exact=True).click();dialog=page.get_by_role('dialog');code=dialog.get_by_label('Ad unit code / div ID',exact=False);code.fill('P1_3')
    assert send('/__fixture/unit-rule-save-before-next-batch','POST',{'ruleKey':'P1','rule':{'timeout':1700}})['status']==200
    dialog.get_by_role('button',name='Duplicate ad unit',exact=True).click();error=dialog.locator('.form-error');expect(error).to_have_text('Site settings changed. Reload before copying this ad unit.');expect(code).to_have_value('P1_3')
    refused=data('/__fixture/snapshot');assert 'P1_3' not in {r['rule_key'] for r in refused['rules']} and 'P1_3' not in refused['config']['advancedUnitRules'];assert [json.loads(r['rule_json'])['timeout'] for r in refused['rules'] if r['rule_key']=='P1']==[1700];screen('ad-unit-copy-refused',error)
    dialog.get_by_role('button',name='Duplicate ad unit',exact=True).click();expect(dialog).to_have_count(0);expect(card('P1_3')).to_be_visible()
    retried=data('/__fixture/snapshot');assert [json.loads(r['rule_json'])['timeout'] for r in retried['rules'] if r['rule_key']=='P1_3']==[1700];assert retried['config']['advancedUnitRules']['P1_3']['timeout']==1700 and retried['config']['advancedUnitRules']['P1_3']['refresh']['schedule']['fixedSeconds']==60
    nav('Unit rules');copy_row=page.locator('table.effective-rule-table tbody tr').filter(has=page.get_by_text('P1_3',exact=True));expect(copy_row.locator('td').nth(2)).to_contain_text('1700 ms');expect(copy_row.locator('td').nth(4)).to_contain_text('60s')
    billboard=page.locator('table.effective-rule-table tbody tr').filter(has=page.get_by_text('Billboard',exact=True));expect(billboard.locator('td').nth(4)).to_contain_text('45s');expect(page.get_by_text('Unit rules is not used',exact=False)).to_have_count(0);screen('unit-rules-after-ad-unit-copy',copy_row)
    assert not errors,errors
    assert any(r['status']==409 and 'unit-rules' in r['path'] for r in requests)
    assert any(r['status']==404 and r['method']=='PATCH' and 'unit-rules' in r['path'] for r in requests)
    assert any(r['status']==409 and r['method']=='PATCH' and 'unit-rules/' in r['path'] for r in requests)
    assert any(r['status']==409 and r['method']=='PUT' and 'unit-rules-advanced/P1' in r['path'] for r in requests)
    results.append({'runtime':args.runtime,'width':width,'passed':True,'gapSupported':ready['gapSupported'],'pageErrors':errors,'externalRequests':0,'requests':requests,'scope':'Actual MAIN components and authenticated Worker with local SQLite/fake R2'})
    print('PASS audit UI and saved settings',args.runtime,width)
   except Exception:
    screen('failure');raise
   finally:page.close();proc.stdin.close();proc.wait(timeout=10)
 finally:browser.close()
(out/f'result-{args.runtime}.json').write_text(json.dumps({'passed':True,'checks':results},indent=2))
