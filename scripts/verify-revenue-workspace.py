"""Actual isolated TEST router + SQLite/R2 fixture + shared React revenue panels.
Every browser request is intercepted into the local stdin fixture. No hosted access.
"""
import base64,json,os,subprocess,time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/revenue-workspace-evidence';out.mkdir(parents=True,exist_ok=True)
checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox'])
 try:
  for width in [1440,390]:
   process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/site-workspace-browser-fixture.mjs','--revenue'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   assert json.loads(process.stdout.readline())['ready']
   page=browser.new_page(viewport={'width':width,'height':900});errors=[];requests=[];pending=[];hold={'path':'/test-api/deals'}
   page.on('pageerror',lambda e:errors.append(str(e)))
   def send(path,method='GET',body=None):
    process.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');process.stdin.flush();value=json.loads(process.stdout.readline());assert 'error' not in value,value;return value
   def fulfill(route,result):route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
   def route(r):
    url=urlsplit(r.request.url);assert url.netloc=='tessera.fixture.invalid','External request blocked'
    value=send(url.path,r.request.method,r.request.post_data)
    requests.append({'path':url.path,'method':r.request.method,'status':value['status']})
    if hold['path']==url.path and r.request.method=='GET':pending.append((r,value))
    else:fulfill(r,value)
   page.route('**/*',route)
   baseline_prebid=json.loads(base64.b64decode(send('/test-api/prebid-settings')['body']))['draft']
   baseline_inventory=json.loads(base64.b64decode(send('/test-api/site-settings')['body']))['draft']
   try:
    page.goto('https://tessera.fixture.invalid/site-workspace');page.get_by_role('button',name='Deals',exact=True).click()
    expect(page.get_by_role('status')).to_contain_text('Loading or saving')
    deadline=time.monotonic()+5
    while not pending and time.monotonic()<deadline:page.wait_for_timeout(10)
    assert pending,'Missing real held Deals read';hold['path']=None
    for r,value in pending:fulfill(r,value)
    pending.clear()
    page.get_by_role('button',name='Add deal',exact=True).click()
    page.get_by_label('Deal name',exact=True).fill('TEST managed deal')
    page.get_by_label('Bidder',exact=True).select_option('pubmatic');page.get_by_label('Deal ID',exact=True).fill('0000199')
    page.get_by_label('Starts (UTC)',exact=True).fill('2026-01-01T00:00');page.get_by_label('Ends (UTC)',exact=True).fill('2027-01-01T00:00')
    page.get_by_label('Billboard',exact=True).check();page.get_by_label('Active',exact=True).check()
    page.get_by_role('button',name='Save deals',exact=True).click();expect(page.get_by_role('status')).to_contain_text('Deals saved')
    page.reload();page.get_by_role('button',name='Deals',exact=True).click();expect(page.get_by_label('Deal ID',exact=True)).to_have_value('0000199')
    expect(page.get_by_label('Billboard',exact=True)).to_be_checked()
    page.get_by_role('button',name='Formats',exact=True).click();page.get_by_role('button',name='Configure formats for Billboard',exact=True).click()
    expect(page.get_by_text('Serving requires the explicitly selected 3.16 revenue preview runtime.',exact=False)).to_have_count(0)
    page.get_by_label('Ad format',exact=True).select_option('banner-outstream')
    page.get_by_label('Player width (px)',exact=True).fill('300');page.get_by_label('Player height (px)',exact=True).fill('250')
    page.get_by_label('PubMatic outstream renderer ID',exact=True).fill('fixture_renderer')
    page.get_by_label('PubMatic confirmed this placement is activated for outstream.',exact=True).check()
    # Real display edits reproduce both the saved Sticky rejection and Standard recovery.
    display_state=json.loads(base64.b64decode(send('/test-api/site-settings')['body']))
    display_state['draft']['bottomStickyId']='Billboard'
    next(x for x in display_state['draft']['units'] if x['code']=='Billboard')['display']='sticky'
    assert send('/test-api/site-settings','POST',json.dumps({'expectedRevision':display_state['revision'],'acknowledge':True,'draft':display_state['draft']}))['status']==200
    page.get_by_role('button',name='Close format settings',exact=True).click()
    page.get_by_role('button',name='Configure formats for Billboard',exact=True).click()
    page.get_by_label('Ad format',exact=True).select_option('banner-outstream')
    page.get_by_label('Player width (px)',exact=True).fill('300');page.get_by_label('Player height (px)',exact=True).fill('250')
    page.get_by_label('PubMatic outstream renderer ID',exact=True).fill('fixture_renderer')
    page.get_by_label('PubMatic confirmed this placement is activated for outstream.',exact=True).check()
    page.get_by_role('button',name='Save format settings',exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('configured as bottom Sticky')
    expect(page.get_by_label('Ad format',exact=True)).to_have_value('banner-outstream')
    page.screenshot(path=str(out/f'formats-actual-sticky-{width}.png'),full_page=True)
    display_state=json.loads(base64.b64decode(send('/test-api/site-settings')['body']))
    display_state['draft']['bottomStickyId']=baseline_inventory['bottomStickyId']
    next(x for x in display_state['draft']['units'] if x['code']=='Billboard')['display']='standard'
    assert send('/test-api/site-settings','POST',json.dumps({'expectedRevision':display_state['revision'],'acknowledge':True,'draft':display_state['draft']}))['status']==200
    page.get_by_role('button',name='Reload format settings',exact=True).click()
    page.get_by_label('Ad format',exact=True).select_option('banner-outstream')
    page.get_by_label('Player width (px)',exact=True).fill('300');page.get_by_label('Player height (px)',exact=True).fill('250')
    page.get_by_label('PubMatic outstream renderer ID',exact=True).fill('fixture_renderer')
    page.get_by_label('PubMatic confirmed this placement is activated for outstream.',exact=True).check()
    page.get_by_role('button',name='Save format settings',exact=True).click();expect(page.get_by_role('status')).to_contain_text('Saved for the next generated script')
    page.screenshot(path=str(out/f'formats-standard-takeover-{width}.png'),full_page=True)
    page.get_by_role('button',name='Close format settings',exact=True).click();page.reload()
    page.get_by_role('button',name='Formats',exact=True).click();page.get_by_role('button',name='Configure formats for Billboard',exact=True).click()
    expect(page.get_by_label('Ad format',exact=True)).to_have_value('banner-outstream');expect(page.get_by_label('PubMatic outstream renderer ID',exact=True)).to_have_value('fixture_renderer')
    # Real second-client write advances the shared snapshot revision; no mocked error.
    page.evaluate("""async()=>{const data=await(await fetch('/test-api/deals')).json();data.settings.entries[0].name='Concurrent TEST deal';const r=await fetch('/test-api/deals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:data.revision,settings:data.settings})});if(!r.ok)throw Error('Concurrent fixture save failed');}""")
    page.get_by_label('Ad format',exact=True).select_option('outstream');page.get_by_role('button',name='Save format settings',exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('Reload');expect(page.get_by_role('alert')).to_be_in_viewport();expect(page.get_by_label('Ad format',exact=True)).to_have_value('outstream')
    page.screenshot(path=str(out/f'formats-conflict-{width}.png'),full_page=True)
    page.get_by_role('button',name='Reload format settings',exact=True).click();expect(page.get_by_label('Ad format',exact=True)).to_have_value('banner-outstream')
    page.get_by_label('Ad format',exact=True).select_option('banner');page.get_by_role('button',name='Save format settings',exact=True).click();expect(page.get_by_role('status')).to_contain_text('Saved for the next generated script')
    page.get_by_role('button',name='Close format settings',exact=True).click()
    page.get_by_role('button',name='Deals',exact=True).click();expect(page.get_by_label('Deal name',exact=True)).to_have_value('Concurrent TEST deal')
    page.screenshot(path=str(out/f'deals-{width}.png'),full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Horizontal overflow'
    persisted=json.loads(base64.b64decode(send('/test-api/outstream-settings')['body']));assert 'Billboard' not in persisted['outstream']['units'],'Banner override not removed in real store'
    positions=json.loads(base64.b64decode(send('/test-api/site-settings')['body']));assert positions['draft']==baseline_inventory,'Revenue settings changed saved inventory/maps'
    current_prebid=json.loads(base64.b64decode(send('/test-api/prebid-settings')['body']))['draft'];assert current_prebid==baseline_prebid,'Revenue settings changed banner bidder parameters/build selection'
    assert not errors,errors
    assert not any(r['path'].startswith('/api/publishers/') for r in requests),'Main route leaked into TEST'
    assert any(r['status']==409 for r in requests),'Missing actual CAS conflict'
    checks.append({'width':width,'sharedPanelsRealWorkerSQLite':True,'dealsSavedReopened':True,'formatsSavedReopenedAndBannerRestored':True,'realStaleRevision409':True,'mainPublisherRequests':0,'requests':requests})
    print('PASS real TEST revenue workspace',width)
   finally:
    page.close();process.stdin.close();process.wait(timeout=10)
 finally:browser.close()
(out/'results.json').write_text(json.dumps(checks,indent=2))
