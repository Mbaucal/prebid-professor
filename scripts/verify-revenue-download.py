"""Click the actual saved-ZIP actions against local Worker + SQLite + in-memory R2.
Synthetic credentials/data only; every browser request is intercepted into stdin.
"""
import base64,hashlib,io,json,os,subprocess,time,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parent.parent
out=root/'.generated/revenue-download-evidence';out.mkdir(parents=True,exist_ok=True)
checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),headless=True,args=['--no-sandbox'])
 try:
  for width in [1440,390]:
   process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/site-workspace-browser-fixture.mjs','--revenue'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   assert json.loads(process.stdout.readline())['ready']
   page=browser.new_page(viewport={'width':width,'height':900},accept_downloads=True)
   errors=[];requests=[];downloads=[];pending=[];mode={'hold':None,'corrupt':None}
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.on('download',lambda d:downloads.append(d))
   def send(path,method='GET',body=None):
    process.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');process.stdin.flush()
    value=json.loads(process.stdout.readline());assert 'error' not in value,value;return value
   def data(path,body=None):
    result=send(path,'GET' if body is None else 'POST',None if body is None else json.dumps(body))
    assert result['status']==200,result
    return json.loads(base64.b64decode(result['body']))
   def fulfill(route,result):route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
   def route(r):
    url=urlsplit(r.request.url);assert url.netloc=='tessera.fixture.invalid','External request blocked'
    result=send(url.path,r.request.method,r.request.post_data)
    requests.append({'path':url.path,'method':r.request.method,'status':result['status']})
    if mode['hold']==url.path:pending.append((r,result))
    elif mode['corrupt']==url.path:r.fulfill(status=200,content_type='application/octet-stream',body=b'corrupt synthetic response')
    else:fulfill(r,result)
   page.route('**/*',route)
   try:
    # Save a real mixed-format configuration through TEST's checked API before Generate.
    settings=data('/test-api/outstream-settings')
    mixed={'schemaVersion':1,'units':{'Billboard':{'format':'banner-outstream','playerSize':[300,250],
     'minDuration':1,'maxDuration':30,'playbackMethod':2,'placement':3,'plcmt':4,
     'partner':{'bidder':'pubmatic','adapter':'pubmatic','outstreamAU':'fixture','activationConfirmed':True},
     'cacheUrl':'https://prebid.adnxs.com/pbc/v1/cache'}}}
    data('/test-api/outstream-settings',{'revision':settings['revision'],'outstream':mixed})
    page.goto('https://tessera.fixture.invalid/')
    expect(page.locator('#generate')).to_be_enabled()
    page.locator('#generate').click();expect(page.locator('#review-summary')).to_contain_text('12 files',timeout=90000)
    page.locator('#note').fill('Synthetic revenue ZIP regression');page.locator('#ack').check();page.locator('#save').click()
    page.get_by_role('button',name='Open saved release',exact=True).click()
    expect(page.locator('#opened-status')).to_have_text('Verified saved package')
    saved=json.loads(page.locator('#opened-details').text_content());release_id=saved['draft']['id']
    assert saved['verified'] and saved['draft']['fileCount']==12
    assert saved['draft']['runtime']['runtimeVersion']=='3.16.0-revenue.preview.2'
    base='/test-api/releases/'+release_id
    descriptor=data(base+'/index')['descriptor'];original={}
    for entry in descriptor['files']:
     response=send(base+'/files/'+entry['name']);assert response['status']==200
     raw=base64.b64decode(response['body']);original[entry['name']]=raw
     assert len(raw)==entry['byteSize'] and hashlib.sha256(raw).hexdigest()==entry['sha256']
    assert 'deals-plan.json' in original and 'gam-reporting.json' in original and 'prebid.js' in original
    writes_before=sum(r['method']=='POST' for r in requests)
    def verify_download(download):
     assert download.failure() is None
     assert download.suggested_filename==release_id+'.zip'
     raw=Path(download.path()).read_bytes()
     with zipfile.ZipFile(io.BytesIO(raw)) as archive:
      assert len(archive.namelist())==12 and set(archive.namelist())==set(original)
      for name,expected in original.items():assert archive.read(name)==expected,name
     return raw
    # This is the original homepage link used in the user's reported flow.
    with page.expect_download() as action:
     page.get_by_role('link',name='Download saved ZIP',exact=True).click()
    homepage_zip=verify_download(action.value)
    expect(page.locator('#download-status')).to_have_text('Saved ZIP downloaded.')
    page.locator('#download-status').scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(out/f'homepage-download-{width}.png'),full_page=True)
    # The shared React Releases button uses the same helper. Exercise loading,
    # corrupt-file refusal and recovery without changing any stored bytes.
    page.goto('https://tessera.fixture.invalid/site-workspace#packages')
    button=page.get_by_role('button',name='Download saved ZIP',exact=True)
    notice=page.locator('.runtime-message[role="status"], .runtime-error[role="status"]')
    expect(button).to_be_enabled()
    first_file=descriptor['files'][0]['name'];mode['hold']=base+'/files/'+first_file
    button.click()
    deadline=time.monotonic()+5
    while not pending and time.monotonic()<deadline:page.wait_for_timeout(10)
    assert pending,'Actual download did not reach its first saved file'
    expect(button).to_be_disabled();expect(notice).to_have_text('Downloading '+first_file+'…')
    notice.scroll_into_view_if_needed()
    page.screenshot(path=str(out/f'releases-loading-{width}.png'),full_page=True)
    assert len(downloads)==1,'Loading unexpectedly emitted a download'
    mode['hold']=None;mode['corrupt']=base+'/files/deals-plan.json'
    for r,result in pending:fulfill(r,result)
    pending.clear()
    expect(notice).to_have_text('Saved file checksum differs: deals-plan.json')
    expect(button).to_be_enabled();assert len(downloads)==1,'Corruption emitted a ZIP'
    notice.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.screenshot(path=str(out/f'releases-error-{width}.png'),full_page=True)
    mode['corrupt']=None
    with page.expect_download() as retry:button.click()
    assert verify_download(retry.value)==homepage_zip,'Two UI entry points assembled different saved ZIP bytes'
    expect(notice).to_have_text('Saved ZIP downloaded.');expect(button).to_be_enabled()
    notice.scroll_into_view_if_needed()
    page.screenshot(path=str(out/f'releases-recovered-{width}.png'),full_page=True)
    assert data(base)['verified'] is True
    assert sum(r['method']=='POST' for r in requests)==writes_before,'Download/retry regenerated or changed settings'
    assert not errors,errors
    assert not any(r['path'].startswith('/api/publishers/') for r in requests)
    checks.append({'width':width,'runtimeVersion':saved['draft']['runtime']['runtimeVersion'],'fileCount':12,
     'homepageLinkAndSharedReleasesButton':True,'exactSavedEntryBytes':True,'identicalDownloadedZips':True,
     'loadingCorruptionRefusalAndRetry':True,'downloadWrites':0,'requests':requests})
    print('PASS actual saved revenue ZIP actions',width)
   except Exception:
    page.screenshot(path=str(out/f'failure-{width}.png'),full_page=True)
    raise
   finally:
    page.close();process.stdin.close();process.wait(timeout=10)
 finally:browser.close()
(out/'results.json').write_text(json.dumps(checks,indent=2))
