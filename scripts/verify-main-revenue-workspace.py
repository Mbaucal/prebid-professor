"""Real MAIN configuration/release components -> authenticated MAIN Worker -> SQLite/R2.
All traffic is synthetic and routed into the local stdin fixture; no hosted access.
"""
import base64,hashlib,io,json,os,subprocess,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/main-revenue-workspace-evidence';out.mkdir(parents=True,exist_ok=True)
checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox'])
 try:
  for width in [1440,390]:
   process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/main-revenue-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(process.stdout.readline());assert ready['ready'] and ready['siteId']=='main-site'
   page=browser.new_page(viewport={'width':width,'height':900},accept_downloads=True);errors=[];requests=[]
   page.on('pageerror',lambda error:errors.append(str(error)))
   def send(path,body=None,method=None):
    process.stdin.write(json.dumps({'path':path,'method':method or ('POST' if body is not None else 'GET'),'body':None if body is None else json.dumps(body)})+'\n');process.stdin.flush()
    value=json.loads(process.stdout.readline());assert 'error' not in value,value;return value
   def data(path,body=None,method=None):
    response=send(path,body,method);value=json.loads(base64.b64decode(response['body']));assert response['status']==200,value;return value
   def route(r):
    url=urlsplit(r.request.url);assert url.netloc=='main-revenue.fixture.invalid','External request blocked'
    process.stdin.write(json.dumps({'path':url.path+('?' + url.query if url.query else ''),'method':r.request.method,'body':r.request.post_data})+'\n');process.stdin.flush()
    value=json.loads(process.stdout.readline());assert 'error' not in value,value
    requests.append({'path':url.path,'method':r.request.method,'status':value['status']})
    r.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
   page.route('**/*',route);base='/api/publishers/main-site'
   def screen(name):
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Horizontal overflow'
    page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
   def save_formats():
    page.get_by_role('button',name='Save format settings',exact=True).click()
    expect(page.get_by_text('Saved for the next revenue preview release. Existing scripts are unchanged.',exact=True)).to_be_visible()
   def edit_desktop(value):
    page.locator('.size-map-card').filter(has=page.get_by_role('heading',name='display',exact=True)).get_by_role('button',name='Edit',exact=True).click()
    page.get_by_role('dialog').get_by_label('Sizes',exact=True).nth(1).fill(value)
    page.get_by_role('button',name='Save size map',exact=True).click()
    expect(page.get_by_role('dialog')).to_have_count(0)
   try:
    page.goto('https://main-revenue.fixture.invalid/')
    expect(page.get_by_role('navigation',name='Configuration groups',exact=True)).to_be_visible()
    page.get_by_role('button',name='Formats',exact=True).click()
    page.get_by_label('Ad format',exact=True).select_option('banner-outstream')
    expect(page.get_by_label('Player width (px)',exact=True)).to_have_count(0)
    expect(page.get_by_text('300 × 250 px · Automatic',exact=False)).to_be_visible()
    expect(page.get_by_text('640 × 360 px · Automatic',exact=False)).to_be_visible()
    page.get_by_label('PubMatic outstream renderer ID',exact=True).fill('main_fixture')
    page.get_by_label('PubMatic confirmed this placement is activated for outstream.',exact=True).check();save_formats()
    saved=data(base+'/outstream-settings')['outstream']['units']['Billboard'];assert saved['playerSizing']=='size-map' and saved['playerSizes']=={}
    page.get_by_role('button',name='Close format settings',exact=True).click()
    page.get_by_role('button',name='Generate and releases',exact=True).click()
    page.get_by_label('What changed?',exact=True).fill('Synthetic MAIN revenue regression')
    page.get_by_role('button',name='Generate and save package',exact=True).click()
    expect(page.get_by_role('status')).to_contain_text('Package saved in Releases.',timeout=90000)
    state=data(base+'/builtin-releases');release_id=state['releases'][0]['id'];assert release_id.startswith('builtin-release-')
    index=data(base+'/builtin-releases/'+release_id+'/index');assert len(index['descriptor']['files'])==12
    original={}
    for entry in index['descriptor']['files']:
     response=send(base+'/builtin-releases/'+release_id+'/files/'+entry['name']);assert response['status']==200
     raw=base64.b64decode(response['body']);assert len(raw)==entry['byteSize'] and hashlib.sha256(raw).hexdigest()==entry['sha256'];original[entry['name']]=raw
    assert 'deals-plan.json' in original
    writes_before=len([r for r in requests if r['method']!='GET'])
    with page.expect_download() as download:page.get_by_role('button',name='Download saved ZIP',exact=True).click()
    assert download.value.failure() is None and download.value.suggested_filename==release_id+'.zip'
    with zipfile.ZipFile(io.BytesIO(Path(download.value.path()).read_bytes())) as archive:
     assert len(archive.namelist())==12 and set(archive.namelist())==set(original)
     for name,raw in original.items():assert archive.read(name)==raw,name
    assert len([r for r in requests if r['method']!='GET'])==writes_before,'Download wrote settings or regenerated a package'
    expect(page.get_by_role('status')).to_have_text('Saved ZIP downloaded.');screen('main-saved-zip')
    page.get_by_role('button',name='Configuration',exact=True).click()
    page.get_by_role('navigation',name='Inventory settings',exact=True).get_by_role('button',name='Size maps',exact=True).click()
    edit_desktop('640x360 | 970x250')
    notice=page.get_by_role('status').filter(has_text='Review Outstream sizes before Generate')
    expect(notice).to_be_visible();expect(notice).to_be_focused();screen('main-map-review')
    assert data(base+'/outstream-settings')['outstream']['units']['Billboard']==saved
    blocked=data(base+'/builtin-releases');assert blocked['ready'] is False
    refusal=send(base+'/builtin-releases',{'action':'generate','revision':blocked['revision'],'notes':'Must refuse unresolved size'})
    assert refusal['status'] in [409,422],refusal
    page.get_by_role('button',name='Review formats for Billboard',exact=True).click()
    selector=page.get_by_label('Video size · display · from 1024px wide',exact=True)
    expect(selector).to_have_value('');expect(page.get_by_role('button',name='Save format settings',exact=True)).to_be_disabled()
    selector.select_option('970x250');save_formats()
    page.get_by_role('button',name='Close format settings',exact=True).click();expect(notice).to_have_count(0)
    assert data(base+'/outstream-settings')['formatReviewRequired']==[] and data(base+'/builtin-releases')['ready'] is True
    # Removing the selected dimension remains repairable through the same native map flow.
    edit_desktop('640x360');expect(notice).to_be_visible()
    page.get_by_role('button',name='Review formats for Billboard',exact=True).click()
    expect(page.get_by_text('640 × 360 px · Automatic',exact=False)).to_be_visible()
    expect(page.get_by_label('PubMatic outstream renderer ID',exact=True)).to_have_value('main_fixture')
    save_formats();page.get_by_role('button',name='Close format settings',exact=True).click();expect(notice).to_have_count(0)
    assert data(base+'/outstream-settings')['outstream']['units']['Billboard']['playerSizes']=={}
    page.get_by_role('button',name='Generate and releases',exact=True).click()
    page.get_by_role('button',name='Generate and save package',exact=True).click()
    expect(page.get_by_role('status')).to_contain_text('Package saved in Releases.',timeout=90000);screen('main-generated-after-repair')
    assert data(base+'/builtin-releases/'+release_id+'/index')==index
    for name,raw in original.items():assert base64.b64decode(send(base+'/builtin-releases/'+release_id+'/files/'+name)['body'])==raw
    assert any(r['method']=='PATCH' and r['path']==base+'/size-maps/map' for r in requests),'Missing native MAIN map mutation'
    assert not any(r['path'].startswith('/test-api/') for r in requests),'TEST route leaked into MAIN browser flow'
    assert not errors,errors
    checks.append({'width':width,'scope':'Actual MAIN components and authenticated Worker with SQLite/fake R2',
     'groupedInventoryNavigation':True,'mainMapMutationAndFormatsRepair':True,'generationBlocksUntilReview':True,
     'realMainSavedZip12ExactFiles':True,'oldReleaseBytesPreserved':True,'requests':requests})
    print('PASS native MAIN revenue workflow',width)
   except Exception:
    page.screenshot(path=str(out/f'failure-{width}.png'),full_page=True);raise
   finally:
    page.close();process.stdin.close();process.wait(timeout=10)
 finally:browser.close()
(out/'results.json').write_text(json.dumps(checks,indent=2))
