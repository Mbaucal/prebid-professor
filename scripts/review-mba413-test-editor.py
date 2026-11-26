"""Independent hosted-TEST editor parity harness; local actual HTTP handler, no paid traffic."""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parent.parent
out=root/'.generated/review-mba413-test-editor';out.mkdir(parents=True,exist_ok=True)
custom={'ver':'1.0','complete':1,'nodes':[{'asi':'agency.example','sid':'agency-42','hp':1}]}
# Script versions that apply bidder accounts, from the registry.
def registry_labels(*capabilities):
 """The versions the admin names for these capabilities, read from the release registry by the shared rule
 (worker/site-runtime/script-versions.mjs): the smallest step and the newest without a runtime notice, one or two."""
 code="const {scriptVersionLabels}=await import('./worker/site-runtime/script-versions.mjs');console.log(JSON.stringify(scriptVersionLabels(JSON.parse(process.argv[1]))))"
 labels=json.loads(subprocess.run(['node','--input-type=module','-e',code,json.dumps(capabilities)],cwd=root,check=True,capture_output=True,text=True).stdout)
 assert 1<=len(labels)<=2,labels
 return ' or '.join(labels)
ACCOUNT_SCRIPTS=registry_labels('bidder-accounts')
reports=[]
with sync_playwright() as pw:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=pw.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/review-mba413-test-editor-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(proc.stdout.readline());assert ready['ready'];origin=ready['origin']
   page=browser.new_page(viewport={'width':width,'height':1000});errors=[];external=[];requests=[];checks=[];hold=[];pending=[];reject=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   def send(path,method='GET',body=None,headers=None):
    raw=body if isinstance(body,str) else json.dumps(body) if body is not None else None
    proc.stdin.write(json.dumps({'path':path,'method':method,'body':raw,'headers':headers or ({'content-type':'application/json'} if raw else {})})+'\n');proc.stdin.flush()
    result=json.loads(proc.stdout.readline());assert 'error' not in result,result;return result
   def data(path):
    result=send(path);assert result['status']==200,result;return json.loads(base64.b64decode(result['body']))
   def fulfill(route):
    req=route.request;path=urlsplit(req.url).path;result=send(path,req.method,req.post_data,req.headers)
    requests.append({'path':path,'method':req.method,'status':result['status']})
    route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
   def route(route):
    req=route.request;path=urlsplit(req.url).path
    if not req.url.startswith(origin+'/'):external.append(req.url);route.abort();return
    if reject and path=='/test-api/prebid-settings' and req.method=='GET':
     reject.pop();route.fulfill(status=503,headers={'content-type':'application/json'},body=json.dumps({'error':'Synthetic TEST read outage. Retry.'}));return
    if hold and path==hold[0] and req.method=='POST':hold.pop();pending.append(route);return
    fulfill(route)
   page.route('**/*',route)
   def screen(name,target=None):
    if target is not None:target.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal overflow'
    page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
   def field(row,name):return row.locator('[data-field="'+name+'"]')
   def add(code,mode,mid,name):
    page.locator('#add-bidder').click();row=page.locator('#bidders > .bidder').last
    field(row,'bidder').select_option('adf');field(row,'accountCode').fill(code);field(row,'displayName').fill(name);field(row,'params').fill(json.dumps({'mid':mid}));field(row,'schainMode').select_option(mode)
    return row
   def saveplan():
    if not page.locator('#save-later').evaluate('(el)=>el.open'):page.locator('#save-later > summary').click()
    page.locator('#save-plan').click()
   try:
    reject.append(True);page.goto(origin+'/prebid-settings',wait_until='domcontentloaded');expect(page.locator('#message')).to_contain_text('Synthetic TEST read outage');screen('read-error')
    page.locator('#reload-prebid').click();expect(page.locator('#editor')).to_be_enabled();checks.append('Read failure is visible and reload recovers actual TEST data')
    expect(page.locator('#account-scripts')).to_have_text(f'Account aliases and custom or no-upstream SChain require script {ACCOUNT_SCRIPTS}. Saving preparation does not switch the script version.')
    expect(page.locator('#editor')).not_to_contain_text('3.22.1');checks.append('Account note names the script versions that apply bidder accounts')
    own=add('adf_smn','inherit',111,'SMN Adform');agency=add('adf_ag','custom',222,'Agency Adform');field(agency,'schainJson').fill('{bad')
    page.locator('#enable-prebid').check();saveplan();expect(page.locator('#message.error')).to_contain_text('JSON');expect(field(agency,'params')).to_have_value(json.dumps({'mid':222}));screen('custom-json-error',agency)
    assert not data('/__fixture/snapshot')['bidders'];checks.append('Invalid custom JSON is rejected without activation or lost account inputs')
    field(agency,'schainJson').fill(json.dumps(custom));field(agency,'schainMode').select_option('none')
    page.locator('#override-section > summary').click();page.locator('#add-override').click();override=page.locator('#overrides > .override').last
    field(override,'bidder').select_option('adf_ag');field(override,'scopeType').select_option('slot');field(override,'scopeKey').select_option('ATF');field(override,'params').fill('{"mid":223}')
    hold.append('/test-api/prebid/plan/save');saveplan();expect(page.locator('#save-plan')).to_be_disabled();screen('saving-plan')
    assert len(pending)==1;fulfill(pending.pop());expect(page.locator('#message')).to_contain_text('Build preparation saved')
    assert not data('/__fixture/snapshot')['bidders'];checks.append('New alias is selectable for an override before save; plan save does not activate it')
    page.reload();expect(page.locator('#bidders > .bidder')).to_have_count(2)
    # Value is a live input property; locate the exact row by its current value.
    rows=page.locator('#bidders > .bidder');agency=next(rows.nth(i) for i in range(rows.count()) if field(rows.nth(i),'accountCode').input_value()=='adf_ag')
    expect(field(agency,'bidder')).to_have_value('adf');expect(field(agency,'schainMode')).to_have_value('none');assert json.loads(field(agency,'schainJson').input_value())==custom
    expect(field(page.locator('#overrides > .override').first,'bidder')).to_have_value('adf_ag');screen('pending-alias-reloaded',agency);checks.append('Pending plan reload retains exact aliases, base adapters, params, override and inactive custom draft')
    settings=data('/test-api/prebid-settings');plan=settings['plan'];assert plan['configuration']['modules'].count('adfBidAdapter')==1;assert not any(x.startswith('adf_ag') for x in plan['configuration']['modules'])
    original=('/* prebid.js v'+plan['version']+'\nModules: '+', '.join(plan['configuration']['modules'])+' */\nvoid 0;').encode()
    page.locator('#upload-file').set_input_files({'name':'prebid.js','mimeType':'application/javascript','buffer':original});page.locator('#upload').click();expect(page.locator('#message')).to_contain_text('File stored')
    uploaded=data('/test-api/prebid-settings')['files'];assert len(uploaded)==1;page.locator('#build').select_option(uploaded[0]['id']);page.locator('#ack').check();page.locator('#save-prebid').click();expect(page.locator('#message')).to_contain_text('Prebid settings saved')
    saved=data('/__fixture/snapshot');accounts={r['bidder']:r for r in saved['bidders']};assert set(accounts)=={'adf_smn','adf_ag'}
    assert json.loads(accounts['adf_ag']['account_json'])['schain']=={'mode':'none','config':custom};assert json.loads(accounts['adf_smn']['account_json'])['schain']['mode']=='inherit';assert json.loads(accounts['adf_ag']['params_json'])=={'mid':222};assert json.loads(accounts['adf_smn']['params_json'])=={'mid':111}
    assert saved['overrides'][0]['bidder']=='adf_ag' and json.loads(saved['overrides'][0]['params_json'])=={'mid':223};checks.append('Returned inert Prebid activates exact separate accounts, one base module and agency override')
    rows=page.locator('#bidders > .bidder');agency=next(rows.nth(i) for i in range(rows.count()) if field(rows.nth(i),'accountCode').input_value()=='adf_ag')
    field(agency,'schainMode').select_option('custom');field(agency,'schainJson').fill('{bad');field(agency,'schainMode').select_option('none');saveplan();expect(page.locator('#message.error')).to_contain_text('JSON')
    agency.get_by_role('button',name='Discard custom draft',exact=True).click();saveplan();expect(page.locator('#message')).to_contain_text('Build preparation saved');assert next(r for r in data('/test-api/prebid-settings')['plan']['draft']['bidders'] if r['bidder']=='adf_ag')['schain']=={'mode':'none'};checks.append('Invalid inactive custom draft can be explicitly discarded')
    hold.append('/test-api/prebid/plan');field(agency,'params').fill('{"mid":999}');page.wait_for_timeout(450)
    assert len(pending)==1,'Hold the automatic preview so the explicit save tests stale recovery'
    current=data('/test-api/prebid-settings');plan=current['plan'];concurrent={**plan['draft'],'bidders':[{**r,'displayName':'Concurrent account edit'} if r['bidder']=='adf_ag' else r for r in plan['draft']['bidders']]}
    response=send('/test-api/prebid/plan/save','POST',{'expectedRevision':current['revision'],'acknowledge':True,'version':plan['version'],'options':plan['options'],'draft':concurrent});assert response['status']==200,response
    saveplan();expect(page.locator('#message.error')).to_contain_text('changed');expect(field(agency,'params')).to_have_value('{"mid":999}');screen('stale-plan-retained',agency);fulfill(pending.pop())
    page.locator('#reload-prebid').click();expect(page.locator('#editor')).to_be_enabled();expect(page.locator('#message')).to_contain_text('Saved preparation restored');checks.append('Stale form cannot overwrite concurrent account changes and reload recovers')
    assert not errors,errors;assert not external,external;checks.append('No JavaScript errors, horizontal overflow or outbound ad traffic')
    reports.append({'width':width,'checks':checks,'requests':requests})
   except Exception:
    screen('failure');(out/f'failure-{width}.json').write_text(json.dumps({'checks':checks,'requests':requests,'errors':errors,'external':external,'visibleText':page.locator('body').inner_text()},indent=2));raise
   finally:page.close();proc.stdin.close();proc.wait(timeout=15)
 finally:browser.close()
report={'scope':'Actual TEST editor and authenticated Worker against local SQLite; inert Prebid bytes, no ad execution. Hosted deployment not verified.','results':reports,'passed':sum(len(r['checks']) for r in reports),'failed':0}
(out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
