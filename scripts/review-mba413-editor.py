"""Independent account UI review: actual React and Worker, isolated SQLite, no remote ads."""
import argparse,base64,json,os,re,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

parser=argparse.ArgumentParser();parser.add_argument('--runtime',default='3.22.1');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent
out=root/'.generated/review-mba413-ui';out.mkdir(parents=True,exist_ok=True)
origin='https://accounts-review.fixture.invalid';site='account-review-site';endpoint='/api/publishers/'+site+'/bidders'
results=[]
custom={'ver':'1.0','complete':1,'nodes':[{'asi':'agency-seller.example','sid':'agency-42','hp':1}]}
with sync_playwright() as pw:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=pw.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/review-mba413-browser-fixture.mjs','--runtime='+args.runtime],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(proc.stdout.readline());assert ready['ready'] and ready['runtime']==args.runtime
   checks=[];requests=[];errors=[];external=[];hold=[];pending=[];reject=[]
   page=browser.new_page(viewport={'width':width,'height':1000});page.on('pageerror',lambda error:errors.append(str(error)))
   def send(path,method='GET',body=None):
    proc.stdin.write(json.dumps({'path':path,'method':method,'body':None if body is None else json.dumps(body)})+'\n');proc.stdin.flush()
    value=json.loads(proc.stdout.readline());assert 'error' not in value,value;return value
   def data(path):
    value=send(path);assert value['status']==200,value;return json.loads(base64.b64decode(value['body']))
   def fulfill(route):
    request=route.request;path=urlsplit(request.url).path
    value=send(path,request.method,json.loads(request.post_data) if request.post_data else None)
    requests.append({'path':path,'method':request.method,'status':value['status']})
    route.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
   def route(route):
    request=route.request;url=urlsplit(request.url)
    if url.netloc!='accounts-review.fixture.invalid':external.append(request.url);route.abort();return
    if reject and url.path==endpoint and request.method=='GET':
     reject.pop();route.fulfill(status=503,headers={'content-type':'application/json'},body=json.dumps({'error':'Synthetic list outage: retry.'}));return
    if hold and url.path.startswith(endpoint) and request.method==hold[0]:pending.append(route);hold.pop();return
    fulfill(route)
   page.route('**/*',route)
   def passed(name):checks.append(name)
   def screen(name,target=None):
    if target is not None:target.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal page overflow'
    page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
   def dialog():return page.get_by_role('dialog')
   def card(code):return page.locator('article.bidder-card').filter(has=page.locator('.bidder-card-heading code',has_text=re.compile('^'+re.escape(code)+'$')))
   def create(code,mode,params,name):
    page.get_by_role('button',name='＋ New bidder',exact=True).click()
    d=dialog();d.get_by_label('Bidder code',exact=False).fill(code);d.get_by_label('Base adapter',exact=True).fill('adf');d.get_by_label('Account name',exact=True).fill(name)
    d.get_by_label('Account SChain',exact=True).select_option(mode);d.get_by_label('Base params JSON',exact=False).fill(json.dumps(params))
    return d
   try:
    reject.append(True);page.goto(origin+'/',wait_until='domcontentloaded');expect(page.locator('.bidders-page .form-error')).to_contain_text('Synthetic list outage')
    screen('listing-error');passed('Listing failure is visible and recoverable')
    hold.append('GET');page.reload(wait_until='domcontentloaded');expect(page.locator('.bidders-page .config-loading')).to_be_visible();screen('listing-loading')
    assert len(pending)==1;fulfill(pending.pop());expect(card('pubmatic')).to_be_visible();expect(page.locator('.bidders-page .config-loading')).to_have_count(0)
    passed('Loading preserves the component and reload recovers the real API')
    before_keyboard_tests = data(endpoint)
    new_bidder = page.get_by_role('button', name='＋ New bidder', exact=True)
    new_bidder.click()
    d = dialog()
    bidder_code = d.get_by_label('Bidder code', exact=False)
    expect(bidder_code).to_be_focused()
    bidder_code.fill('discarded_account')
    finish = d.get_by_role('button', name='Create bidder', exact=True)
    close = d.get_by_role('button', name='Close bidder dialog', exact=True)
    finish.focus()
    page.keyboard.press('Tab')
    expect(close).to_be_focused()
    page.keyboard.press('Shift+Tab')
    expect(finish).to_be_focused()
    screen('bidder-dialog-keyboard', d)
    page.keyboard.press('Escape')
    expect(d).to_have_count(0)
    expect(new_bidder).to_be_focused()
    new_bidder.click()
    expect(bidder_code).to_have_value('')
    d.get_by_role('button', name='Cancel', exact=True).click()
    expect(new_bidder).to_be_focused()

    edit_bidder = card('pubmatic').get_by_role('button', name='Edit bidder', exact=True)
    edit_bidder.click()
    expect(bidder_code).to_be_focused()
    page.keyboard.press('Escape')
    expect(d).to_have_count(0)
    expect(edit_bidder).to_be_focused()

    add_override = card('pubmatic').get_by_role('button', name='＋ Add override', exact=True)
    add_override.click()
    expect(d.get_by_label('Scope type', exact=False)).to_be_focused()
    finish = d.get_by_role('button', name='Create override', exact=True)
    close = d.get_by_role('button', name='Close override dialog', exact=True)
    finish.focus()
    page.keyboard.press('Tab')
    expect(close).to_be_focused()
    page.keyboard.press('Shift+Tab')
    expect(finish).to_be_focused()
    screen('override-dialog-keyboard', d)
    page.keyboard.press('Escape')
    expect(d).to_have_count(0)
    expect(add_override).to_be_focused()
    add_override.click()
    page.mouse.click(1, 1)
    expect(d).to_have_count(0)
    expect(add_override).to_be_focused()
    assert data(endpoint) == before_keyboard_tests
    passed('Bidder and override dialogs wrap keyboard focus and return it to the exact opener without saving')

    def escape_while_saving(finish_name):
        hold.append('POST')
        d.get_by_role('button', name=finish_name, exact=True).click()
        expect(d.get_by_role('button', name='Saving…', exact=True)).to_be_disabled()
        # A native close removes the open attribute during the Escape itself, before any reopen.
        page.evaluate('''() => {
            const changes = window.savingDialogOpenChanges = [];
            new MutationObserver((records) => changes.push(...records)).observe(document.querySelector('dialog.bidder-form-dialog'), {attributeFilter: ['open']});
        }''')
        for _ in range(5):
            page.keyboard.press('Escape')
        # While the dialog stays open the page behind it is inert, so Enter cannot reach the opener and reset the form.
        page.keyboard.press('Enter')
        expect(page.locator('dialog.bidder-form-dialog')).to_have_js_property('open', True)
        expect(d).to_be_visible()
        assert page.evaluate('window.savingDialogOpenChanges.length') == 0, 'The saving dialog closed natively'
        # The disabled Saving… button can leave focus on body; it must not reach the page behind the dialog.
        assert page.evaluate('document.activeElement === document.body || document.querySelector("dialog[open]")?.contains(document.activeElement) === true'), 'Focus moved to the page behind the saving dialog'
        assert len(pending) == 1
        return pending.pop()

    def synthetic_save_outage(held, message):
        held.fulfill(status=503, headers={'content-type': 'application/json'}, body=json.dumps({'error': message}))

    new_bidder.click()
    bidder_code.fill('escape_failed')
    held = escape_while_saving('Create bidder')
    screen('bidder-saving-after-escape', d)
    synthetic_save_outage(held, 'Synthetic bidder save outage: retry.')
    expect(d.get_by_role('alert')).to_contain_text('Synthetic bidder save outage')
    expect(d.get_by_role('alert')).to_be_visible()
    expect(bidder_code).to_be_visible()
    expect(bidder_code).to_have_value('escape_failed')
    screen('bidder-save-failed-after-escape', d.get_by_role('alert'))
    # Chromium closes the dialog on a non-cancelable Escape and sends the close event later, so the
    # event can arrive after the failed save has rendered. close() reproduces that order every time.
    page.evaluate('document.querySelector("dialog.bidder-form-dialog").close()')
    expect(page.locator('dialog.bidder-form-dialog')).to_have_js_property('open', True)
    expect(d.get_by_role('alert')).to_be_visible()
    expect(bidder_code).to_have_value('escape_failed')
    passed('A close event that arrives after a failed save reopens the mounted bidder dialog')
    page.keyboard.press('Escape')
    expect(d).to_have_count(0)
    expect(new_bidder).to_be_focused()
    new_bidder.click()
    expect(bidder_code).to_be_focused()
    expect(bidder_code).to_have_value('')
    page.keyboard.press('Escape')
    expect(d).to_have_count(0)
    expect(new_bidder).to_be_focused()
    passed('Repeated Escape cannot close a saving bidder dialog; a failed save keeps its error and form open')

    add_override.click()
    held = escape_while_saving('Create override')
    synthetic_save_outage(held, 'Synthetic override save outage: retry.')
    expect(d.locator('.form-error')).to_contain_text('Synthetic override save outage')
    expect(d.locator('.form-error')).to_be_visible()
    expect(d.get_by_label('Scope key', exact=False)).to_have_value('P1')
    screen('override-save-failed-after-escape', d.locator('.form-error'))
    page.keyboard.press('Escape')
    expect(d).to_have_count(0)
    expect(add_override).to_be_focused()
    assert data(endpoint) == before_keyboard_tests
    passed('Repeated Escape cannot close a saving override dialog; a failed save keeps its error and form open')

    d = create('adf_escape', 'inherit', {'mid': 333}, 'Escape Adform')
    fulfill(escape_while_saving('Create bidder'))
    expect(d).to_have_count(0)
    expect(card('adf_escape')).to_contain_text('Site chain')
    expect(new_bidder).to_be_focused()
    passed('Repeated Escape keeps a successful bidder save open until the save closes it')

    d=create('adf_smn','inherit',{'mid':111},'SMN Adform')
    d.get_by_role('button',name='Create bidder',exact=True).click();expect(d).to_have_count(0);expect(card('adf_smn')).to_contain_text('Site chain')
    d=create('adf_ag','custom',{'mid':222},'Agency Adform')
    d.get_by_label('Custom SChain JSON',exact=True).fill('{bad')
    d.get_by_role('button',name='Create bidder',exact=True).click();expect(d.get_by_role('alert')).to_contain_text('not valid JSON')
    expect(d.get_by_label('Base params JSON',exact=False)).to_have_value(json.dumps({'mid':222}));screen('custom-json-error',d.get_by_role('alert'));passed('Invalid custom chain preserves account and parameter input')
    d.get_by_label('Custom SChain JSON',exact=True).fill(json.dumps(custom));d.get_by_label('Account SChain',exact=True).select_option('none')
    hold.append('POST');d.get_by_role('button',name='Create bidder',exact=True).click();expect(d.get_by_role('button',name='Saving…',exact=True)).to_be_disabled();screen('account-saving')
    expect(d.get_by_role('button', name='Close bidder dialog', exact=True)).to_be_disabled()
    page.keyboard.press('Escape')
    expect(d).to_be_visible()
    page.mouse.click(1, 1)
    expect(d).to_be_visible()
    assert len(pending)==1;fulfill(pending.pop());expect(d).to_have_count(0);expect(card('adf_ag')).to_contain_text('No upstream chain')
    expect(new_bidder).to_be_focused()
    passed('Agency alias saves with no upstream chain and saving state prevents double submission')
    page.reload();expect(card('adf_ag')).to_be_visible();saved=data(endpoint)['bidders'];agency=next(row for row in saved if row['bidder']=='adf_ag');own=next(row for row in saved if row['bidder']=='adf_smn')
    assert agency['baseAdapter']=='adf' and agency['schain']['mode']=='none' and agency['schain']['config']==custom and agency['params']=={'mid':222};assert own['params']=={'mid':111} and own['schain']['mode']=='inherit'
    screen('account-list');passed('Reload retains separate base adapter, account labels, params and SChain mode')
    card('adf_ag').get_by_role('button',name='＋ Add override',exact=True).click();d=dialog();d.get_by_label('Scope type',exact=False).select_option('adunit');d.get_by_label('Scope key',exact=False).fill('P1');d.get_by_label('Params JSON',exact=False).fill('{"mid":224}')
    d.get_by_role('button',name='Create override',exact=True).click();expect(d).to_have_count(0)
    card('adf_ag').locator('.bidder-actions').get_by_role('button',name='Duplicate',exact=True).click();d=dialog();d.get_by_label('Bidder code',exact=False).fill('adf_ag2');expect(d.get_by_label('Base adapter',exact=True)).to_have_value('adf');expect(d.get_by_label('Account SChain',exact=True)).to_have_value('none');d.get_by_label('Enabled',exact=True).uncheck()
    screen('duplicate-account',d);d.get_by_role('button',name='Duplicate bidder',exact=True).click();expect(d).to_have_count(0)
    saved=data(endpoint)['bidders'];copy=next(row for row in saved if row['bidder']=='adf_ag2');agency=next(row for row in saved if row['bidder']=='adf_ag');assert not copy['enabled'] and copy['schain']['mode']=='none';assert copy['overrides'][0]['bidder']=='adf_ag2' and copy['overrides'][0]['id']!=agency['overrides'][0]['id'];passed('Duplicate preserves mode and base adapter, copies overrides to distinct account, and respects disabled state')
    card('adf_ag').get_by_role('button',name='Edit bidder',exact=True).click();d=dialog();d.get_by_label('Base params JSON',exact=False).fill('{"mid":999}')
    response=send(endpoint+'/'+agency['id'],'PATCH',{'schain':{'mode':'custom','config':custom},'expectedUpdatedAt':agency['updatedAt']});assert response['status']==200,response
    d.get_by_role('button',name='Save bidder',exact=True).click();expect(d.get_by_role('alert')).to_contain_text('changed in another tab');expect(d.get_by_label('Base params JSON',exact=False)).to_have_value('{"mid":999}');screen('stale-save-refused',d.get_by_role('alert'))
    saved=next(row for row in data(endpoint)['bidders'] if row['bidder']=='adf_ag');assert saved['schain']['mode']=='custom' and saved['params']=={'mid':222};passed('Stale full-form save is refused without restoring the old chain or losing entered params')
    reject.append(True);d.get_by_role('button',name='Reload saved account (discard edits)',exact=True).click();expect(d.get_by_role('alert')).to_contain_text('Synthetic list outage');expect(d.get_by_label('Base params JSON',exact=False)).to_have_value('{"mid":999}')
    d.get_by_role('button',name='Reload saved account (discard edits)',exact=True).click();expect(d.get_by_label('Account SChain',exact=True)).to_have_value('custom');expect(d.get_by_label('Base params JSON',exact=False)).to_have_value(json.dumps({'mid':222},indent=2));assert json.loads(d.get_by_label('Custom SChain JSON',exact=True).input_value())==custom;screen('custom-chain-reloaded',d)
    d.get_by_label('Base params JSON',exact=False).fill('{"mid":999}');d.get_by_role('button',name='Save bidder',exact=True).click();expect(d).to_have_count(0)
    saved=next(row for row in data(endpoint)['bidders'] if row['bidder']=='adf_ag');assert saved['params']=={'mid':999} and saved['schain']['config']==custom;passed('Reopening the fresh record allows recovery while preserving the new custom chain')
    card('adf_ag').get_by_role('button',name='Edit bidder',exact=True).click();d=dialog();remembered={**custom,'nodes':[{**custom['nodes'][0],'sid':'agency-edited-43'}]};d.get_by_label('Custom SChain JSON',exact=True).fill(json.dumps(remembered));d.get_by_label('Account SChain',exact=True).select_option('inherit');d.get_by_role('button',name='Save bidder',exact=True).click();expect(d).to_have_count(0)
    saved=next(row for row in data(endpoint)['bidders'] if row['bidder']=='adf_ag');assert saved['schain']=={'mode':'inherit','config':remembered};passed('Switching away from custom preserves the edited custom values for later reuse')
    card('adf_ag').get_by_role('button',name='Edit bidder',exact=True).click();d=dialog();d.get_by_label('Account SChain',exact=True).select_option('custom');expect(d.get_by_label('Custom SChain JSON',exact=True)).to_have_value(json.dumps(remembered,indent=2));d.get_by_label('Custom SChain JSON',exact=True).fill('{bad');d.get_by_label('Account SChain',exact=True).select_option('none');d.get_by_role('button',name='Save bidder',exact=True).click();expect(d.get_by_role('alert')).to_contain_text('not valid JSON');screen('inactive-custom-draft-error',d.get_by_role('alert'));d.get_by_role('button',name='Discard custom draft',exact=True).click();d.get_by_role('button',name='Save bidder',exact=True).click();expect(d).to_have_count(0)
    saved=next(row for row in data(endpoint)['bidders'] if row['bidder']=='adf_ag');assert saved['schain']=={'mode':'none'};passed('Invalid hidden draft is explicit and can be discarded before saving no upstream chain')
    before=data('/__fixture/snapshot');page.get_by_role('button',name='Script setup',exact=True).click();selector=page.get_by_label('Script version',exact=True);expect(selector).to_be_enabled()
    if args.runtime=='3.22.1':assert 'preview' in selector.locator('option:checked').inner_text().lower(),'Preview version is not labeled as preview'
    screen('script-preview-labeled',selector);assert data('/__fixture/snapshot')==before,'Opening version settings must not switch or modify account settings';passed('Script setup labels the selected preview explicitly and opening it changes no settings')
    assert not external,external;assert not errors,errors;passed('No horizontal overflow, page JavaScript errors or outbound traffic')
    results.append({'width':width,'checks':checks,'requests':requests,'pageErrors':errors,'externalRequests':external})
   except Exception:
    screen('failure');(out/f'failure-{width}.json').write_text(json.dumps({'checks':checks,'requests':requests,'pageErrors':errors,'visibleText':page.locator('body').inner_text()},indent=2));raise
   finally:page.close();proc.stdin.close();proc.wait(timeout=15)
 finally:browser.close()
report={'scope':'Actual React + authenticated Worker with local SQLite. No hosted deployment or SSP receipt verified.','runtime':args.runtime,'results':results,'passed':sum(len(row['checks']) for row in results),'failed':0}
(out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
