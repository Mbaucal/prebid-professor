"""Actual MAIN ConfigPanel/authenticated router + isolated TEST editor; synthetic stores, no ads."""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'.generated/adaptive-timeout-ui';OUT.mkdir(parents=True,exist_ok=True)
(OUT/'result.json').unlink(missing_ok=True);(OUT/'failure.json').unlink(missing_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/adaptive-timeout-ui-fixture.mjs'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
fixture=json.loads(process.stdout.readline());assert fixture['ready']
errors=[];external=[];checks=[];held=[];mode={'holdRead':False,'holdSave':False,'loseSave':False}
def send(origin,path,method='GET',body=None):
 process.stdin.write(json.dumps({'origin':origin,'path':path,'method':method,'body':body})+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result;return result
def api(origin,path,body=None):
 result=send(origin,path,'POST' if body is not None else 'GET',None if body is None else json.dumps(body));assert result['status']==200,result
 return json.loads(base64.b64decode(result['body']))
def fulfill(route,result):route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
def routing(route):
 request=route.request;url=urlsplit(request.url);origin=url.scheme+'://'+url.netloc
 if origin not in [fixture['mainOrigin'],fixture['testOrigin']]:external.append(request.url);route.abort();return
 path=url.path+('?'+url.query if url.query else '')
 settings=path.endswith('/builtin-site-settings') or path=='/test-api/site-runtime'
 if settings and request.method=='GET' and mode['holdRead']:
  mode['holdRead']=False;held.append((route,send(origin,path)));return
 if settings and request.method=='POST' and mode['loseSave'] and json.loads(request.post_data).get('action')=='auction-timeout':
  mode['loseSave']=False;result=send(origin,path,request.method,request.post_data);assert result['status']==200,result
  route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Synthetic reply lost after committed save.'}));return
 if settings and request.method=='POST' and mode['holdSave']:
  mode['holdSave']=False;held.append((route,send(origin,path,request.method,request.post_data)));return
 fulfill(route,send(origin,path,request.method,request.post_data))
def check(name,value=True):assert value,name;checks.append(name);print("PASS "+name,flush=True)
def reset(origin,endpoint):
 state=api(origin,endpoint);api(origin,endpoint,{'action':'auction-timeout','revision':state['revision'],'policy':{'enabled':False}})
 state=api(origin,endpoint);runtime=next(r for r in state['runtimes'] if r['version']=='3.25.1')
 api(origin,endpoint,{'action':'version','revision':state['revision'],'runtime':runtime['pin'],'allowPreview':True})
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox','--disable-dev-shm-usage'])
  try:
   for target in ['main','test']:
    origin=fixture[target+'Origin'];endpoint='/api/publishers/alpha-site/builtin-site-settings' if target=='main' else '/test-api/site-runtime'
    for width in [1440,390]:
     reset(origin,endpoint);page=browser.new_page(viewport={'width':width,'height':900});page.route('**/*',routing);page.on('pageerror',lambda error:errors.append(str(error)))
     page.goto(origin+('/' if target=='main' else '/site-workspace#rules'))
     panel=page.get_by_role('region',name='Adaptive auction timeout settings',exact=True)
     expect(panel.get_by_role('heading',name='Adaptive auction timeout',exact=True)).to_be_visible()
     toggle=panel.get_by_role('checkbox',name='Enable adaptive auction timeout',exact=True)
     expect(toggle).not_to_be_checked();expect(toggle).to_be_disabled();check(f'{target} {width}: historical runtime stays OFF and cannot silently enable')
     page.get_by_role('button',name='Script setup',exact=True).click();select=page.get_by_label('Script version',exact=True);expect(select).to_be_enabled()
     value=select.locator('option').evaluate_all("opts=>opts.find(o=>o.value.startsWith('3.26.0:')).value")
     select.select_option(value);page.get_by_role('button',name='Save script setup',exact=True).click();expect(page.get_by_text('Script setup saved.',exact=False)).to_be_visible()
     mode['holdRead']=True
     page.get_by_role('button',name='Auction timing' if target=='main' else 'Unit rules',exact=True).click()
     expect(panel.get_by_text('Loading timeout settings…',exact=True)).to_be_visible();panel.scroll_into_view_if_needed();page.screenshot(path=str(OUT/f'{target}-loading-{width}.png'))
     check(f'{target} {width}: load status precedes editable values');assert len(held)==1;fulfill(*held.pop())
     expect(toggle).to_be_enabled();expect(toggle).not_to_be_checked();toggle.check()
     panel.get_by_label('Maximum local timeout (ms)',exact=True).fill('3200')
     panel.get_by_label('Device',exact=True).select_option('mobile');panel.get_by_label('Connection',exact=True).select_option('slow')
     expect(panel.get_by_text('Local request timeout:',exact=False)).to_contain_text('Mobile device adjustment');expect(panel.get_by_text('Local request timeout:',exact=False)).to_contain_text('Slow connection adjustment')
     mode['holdSave']=True;panel.get_by_role('button',name='Save timeout settings',exact=True).click();expect(panel.get_by_role('button',name='Saving…',exact=True)).to_be_disabled()
     expect(panel.get_by_role('status')).to_contain_text('Saving adaptive timeout settings');expect(panel.get_by_role('status')).to_be_in_viewport(ratio=1);check(f'{target} {width}: pending save never reports success');assert len(held)==1;fulfill(*held.pop())
     expect(panel.get_by_role('status')).to_contain_text('Timeout settings saved for the next generated package')
     panel.get_by_role('heading',name='Adaptive auction timeout',exact=True).scroll_into_view_if_needed();page.screenshot(path=str(OUT/f'{target}-saved-{width}.png'))
     check(f'{target} {width}: no horizontal overflow',page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
     page.reload();expect(toggle).to_be_checked();expect(panel.get_by_label('Maximum local timeout (ms)',exact=True)).to_have_value('3200');check(f'{target} {width}: explicit policy survives reload')
     panel.get_by_label('Minimum local timeout (ms)',exact=True).fill('4000');panel.get_by_role('button',name='Save timeout settings',exact=True).click();expect(panel.get_by_role('status')).to_contain_text('minimum must not exceed maximum');check(f'{target} {width}: invalid bounds remain editable')
     panel.get_by_label('Minimum local timeout (ms)',exact=True).fill('800')
     state=api(origin,endpoint);api(origin,endpoint,{'action':'auction-timeout','revision':state['revision'],'policy':{**state['adaptiveTimeout']['policy'],'mobileAdjustmentMs':300}})
     panel.get_by_label('Maximum local timeout (ms)',exact=True).fill('3100');panel.get_by_role('button',name='Save timeout settings',exact=True).click()
     expect(panel.get_by_role('status')).to_contain_text('Your entries are kept');expect(panel.get_by_label('Maximum local timeout (ms)',exact=True)).to_have_value('3100');expect(panel.get_by_role('button',name='Save timeout settings',exact=True)).to_be_disabled();check(f'{target} {width}: real revision conflict preserves draft and prevents stale retry')
     panel.get_by_role('status').scroll_into_view_if_needed();page.screenshot(path=str(OUT/f'{target}-conflict-{width}.png'))
     panel.get_by_role('button',name='Discard edits and reload saved settings',exact=True).click();expect(panel.get_by_label('Maximum local timeout (ms)',exact=True)).to_have_value('3200')
     panel.get_by_label('Maximum local timeout (ms)',exact=True).fill('3000');mode['loseSave']=True;panel.get_by_role('button',name='Save timeout settings',exact=True).click()
     expect(panel.get_by_role('status')).to_contain_text('Synthetic reply lost after committed save');expect(panel.get_by_role('status')).not_to_contain_text('Timeout settings saved');expect(panel.get_by_label('Maximum local timeout (ms)',exact=True)).to_have_value('3000');check(f'{target} {width}: uncertain committed save never claims success or repeats')
     panel.get_by_role('button',name='Discard edits and reload saved settings',exact=True).click();expect(panel.get_by_label('Maximum local timeout (ms)',exact=True)).to_have_value('3000');check(f'{target} {width}: explicit recovery reads durable committed policy')
     panel.get_by_text('Local request timeout:',exact=False).scroll_into_view_if_needed();expect(panel.get_by_text('Local request timeout:',exact=False)).to_be_in_viewport(ratio=1);check(f'{target} {width}: effective value and reason are in the viewport');page.screenshot(path=str(OUT/f'{target}-preview-{width}.png'))
     page.close()
  finally:browser.close()
 check('No uncaught browser errors',not errors);check('No external requests or generated ads',not external)
 (OUT/'result.json').write_text(json.dumps({'passed':True,'count':len(checks),'checks':checks,'pageErrors':errors,'externalRequests':external,'scope':fixture['scope']},indent=2)+'\n')
 print(json.dumps({'passed':len(checks),'pageErrors':len(errors),'externalRequests':len(external)}))
except Exception as error:
 (OUT/'failure.json').write_text(json.dumps({'error':repr(error),'checks':checks,'pageErrors':errors,'externalRequests':external},indent=2)+'\n');raise
finally:process.stdin.close();process.wait(timeout=15)
