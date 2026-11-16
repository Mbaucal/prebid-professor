"""Reported missing-Prebid state, actual main React components + real services."""
import base64,json,re,subprocess,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/site-workspace-evidence';out.mkdir(exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/site-workspace-browser-fixture.mjs','--release-setup'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
requests=[];errors=[]
# MBA-419: 3.22.0 stays selectable and savable, labeled and explained. The
# current version is read from the endpoint, never assumed.
legacy='3.22.0 · No 3.21.1+ fixes'
legacy_warning_start='3.22.0 adds bidder rules but is built on 3.21.0. It does not have the 3.21.1 and 3.21.2 fixes for page and category size maps when no key-value mapping sets a size map, contextual signals with existing Prebid RTD providers, and the TakeOver frequency cap and debug storage before CMP consent.'
def legacy_warning(current):
    return legacy_warning_start+' 3.22.2 (Preview) has bidder rules with these fixes. '+current+' is the current version.'
def select_fits(select):
    # Closed-select text width against its content box minus the native arrow.
    # Measured in the rendered font, in the admin stack (src/styles.css) and in
    # the fonts that stack falls back to where Inter is not installed (DejaVu
    # Sans on stock Ubuntu, including the CI runner); the widest one counts, so
    # the result does not depend on the fonts of the machine running the check.
    return select.evaluate("""(el)=>{const s=getComputedStyle(el),c=document.createElement('canvas').getContext('2d');
      const text=el.options[el.selectedIndex].textContent,size=s.fontWeight+' '+s.fontSize+' ';
      const fonts={rendered:s.font,admin:size+'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        dejaVuSans:size+'"DejaVu Sans"',liberationSans:size+'"Liberation Sans"',arial:size+'Arial'};
      const widths=Object.fromEntries(Object.entries(fonts).map(([name,font])=>{c.font=font;return [name,Math.ceil(c.measureText(text).width)];}));
      const width=Math.max(...Object.values(widths)),room=el.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-24;
      return {text,textWidth:width,widths,room:Math.floor(room),selectWidth:el.clientWidth,font:s.font,fits:width<=room};}""")
fits=[]
def dashboard_fits(browser):
    # The dashboard-styled admin (main-revenue fixture) is narrower than this
    # unstyled harness: check the standalone Script setup and the one inside
    # Releases at 390 px with 3.22.0 selected and saved.
    origin='https://main-revenue.fixture.invalid'
    fixture=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/main-revenue-browser-fixture.mjs','--script-setup=new'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    try:
        assert json.loads(fixture.stdout.readline())['ready']
        def dashboard_route(request):
            url=urlsplit(request.request.url)
            assert url.netloc=='main-revenue.fixture.invalid'
            fixture.stdin.write(json.dumps({'path':url.path,'method':request.request.method,'body':request.request.post_data})+'\n');fixture.stdin.flush()
            result=json.loads(fixture.stdout.readline());assert 'error' not in result,result
            request.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
        page=browser.new_page(viewport={'width':390,'height':844});page.route('**/*',dashboard_route)
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(origin+'/')
        panel=page.get_by_role('region',name='Script setup',exact=True)
        version=panel.get_by_role('combobox',name='Script version',exact=True);version.wait_for()
        options=version.locator('option').evaluate_all('(items)=>items.map(item=>({label:item.textContent.trim(),value:item.value}))')
        version.select_option(next(item['value'] for item in options if item['label']==legacy))
        fit=select_fits(version);fits.append({'viewport':390,'context':'Dashboard Script setup','state':'selected',**fit});assert fit['fits'],fit
        panel.get_by_role('radio',name='GAM / AdX only',exact=False).check()
        panel.get_by_role('button',name='Save script setup',exact=True).click()
        panel.get_by_role('status').filter(has_text='Script setup saved').wait_for()
        page.get_by_role('button',name='Generate and releases',exact=True).click()
        releases=page.get_by_role('region',name='Saved packages',exact=True)
        releases.get_by_role('button',name='Change script setup',exact=True).click()
        inline=releases.get_by_role('combobox',name='Script version',exact=True);inline.wait_for()
        assert inline.locator('option:checked').text_content().strip()==legacy
        fit=select_fits(inline);fits.append({'viewport':390,'context':'Dashboard Releases inline setup','state':'saved',**fit});assert fit['fits'],fit
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.screenshot(path=str(out/'runtime-322-dashboard-inline-mobile.png'),full_page=True)
        inline.screenshot(path=str(out/'runtime-322-dashboard-inline-select.png'))
        # A saved Preview version that is also selected: the closed select shows "<version> · Preview"
        # and fits, standalone and inside Releases. The open list keeps "Saved version" on it while
        # another version is selected.
        labels=lambda select:select.locator('option').evaluate_all('(items)=>items.map(item=>({label:item.textContent.trim(),value:item.value}))')
        for saved in ['3.24.0','3.22.2','3.22.1']:
            label=saved+' · Preview'
            page.get_by_role('button',name='Configuration',exact=True).click()
            version=panel.get_by_role('combobox',name='Script version',exact=True);version.wait_for()
            version.select_option(next(item['value'] for item in labels(version) if item['label'].startswith(label)))
            panel.get_by_role('button',name='Save script setup',exact=True).click()
            panel.get_by_role('status').filter(has_text='Script setup saved').wait_for()
            fit=select_fits(version);fits.append({'viewport':390,'context':'Dashboard Script setup','state':'saved '+saved,**fit});assert fit['fits'],fit
            assert version.locator('option:checked').text_content().strip()==label,version.locator('option:checked').text_content()
            page.get_by_role('button',name='Generate and releases',exact=True).click()
            releases.get_by_role('button',name='Change script setup',exact=True).click()
            inline=releases.get_by_role('combobox',name='Script version',exact=True);inline.wait_for()
            fit=select_fits(inline);fits.append({'viewport':390,'context':'Dashboard Releases inline setup','state':'saved '+saved,**fit});assert fit['fits'],fit
            assert inline.locator('option:checked').text_content().strip()==label,inline.locator('option:checked').text_content()
            inline.screenshot(path=str(out/f'runtime-{saved.replace(".","")}-dashboard-inline-select.png'))
            inline.select_option(next(item['value'] for item in labels(inline) if item['label']=='3.21.2 · Current version'))
            assert label+' · Saved version' in [item['label'] for item in labels(inline)],labels(inline)
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        page.close()
    finally:
        fixture.stdin.close();fixture.wait(timeout=10)
def route(request):
    url=urlsplit(request.request.url)
    assert url.netloc=='tessera.fixture.invalid'
    body={'path':url.path,'method':request.request.method,'body':request.request.post_data}
    process.stdin.write(json.dumps(body)+'\n');process.stdin.flush()
    result=json.loads(process.stdout.readline());assert 'error' not in result,result
    requests.append(body);assert result['status'] in (200,201),result
    request.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
try:
 assert json.loads(process.stdout.readline())['ready']
 with sync_playwright() as p:
    browser=p.chromium.launch()
    page=browser.new_page(viewport={'width':390,'height':844});page.route('**/*',route)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('https://tessera.fixture.invalid/setup')
    page.get_by_text('No current Prebid file',exact=False).wait_for()
    assert page.get_by_role('button',name='Generate and save package',exact=True).is_disabled()
    assert page.get_by_text('Choose a generator profile',exact=False).count()==0
    assert not any('/validate' in r['path'] for r in requests)
    page.get_by_role('button',name='Open Prebid.js',exact=True).click()
    page.get_by_role('heading',name='Prebid.js destination',exact=True).wait_for()
    page.get_by_role('button',name='Script setup',exact=True).click()
    page.get_by_role('radio',name='GAM + Prebid',exact=False).wait_for()
    assert page.get_by_role('button',name='Save script setup',exact=True).is_disabled()
    page.get_by_role('radio',name='GAM / AdX only',exact=False).check()
    assert page.get_by_role('button',name='Save script setup',exact=True).is_enabled()
    assert page.get_by_role('button',name='Open Prebid.js',exact=True).count()==0
    version=page.get_by_role('combobox',name='Script version',exact=True)
    assert version.count()==1
    options=version.locator('option').evaluate_all('(items)=>items.map(item=>({label:item.textContent.trim(),value:item.value}))')
    assert options and all(re.fullmatch(r'\d+\.\d+\.\d+',item['label'].split(' · ')[0]) for item in options),options
    by_label={item['label']:item['value'] for item in options}
    stable='3.21.2 · Current version'
    preview='3.22.1 · Preview'
    assert stable in by_label and preview in by_label,options
    assert version.input_value()==by_label[stable]
    preview_notice=page.get_by_role('note').filter(has_text='Preview version selected.')
    assert not preview_notice.is_visible()
    version.select_option(by_label[preview])
    preview_notice.wait_for()
    preview_notice_class=preview_notice.get_attribute('class')
    assert preview_notice.text_content()=='Preview version selected. Save explicitly and verify a generated package on TEST before using it on a live site.'
    assert page.get_by_text('Unsaved version change',exact=False).is_visible()
    assert all(r['method']=='GET' for r in requests)
    page.get_by_role('button',name='Use current version',exact=True).click()
    assert version.input_value()==by_label[stable]
    assert not preview_notice.is_visible()
    current_label=stable.split(' · ')[0]
    earlier_cache='3.23.0 · Earlier bid cache'
    assert earlier_cache in by_label,options
    version.select_option(by_label[earlier_cache])
    cache_notice=page.get_by_role('note').filter(has_text='3.23.0 adds bid caching')
    cache_notice.wait_for()
    expect(cache_notice).to_contain_text('3.24.0 (Preview) has bid caching, bidder accounts and rules with these safeguards.')
    expect(version).to_have_accessible_description(cache_notice.inner_text())
    cache_fit=select_fits(version);fits.append({'viewport':390,'context':'Script setup','state':'earlier-cache',**cache_fit});assert cache_fit['fits'],cache_fit
    page.screenshot(path=str(out/'runtime-323-notice-mobile.png'),full_page=True)
    page.set_viewport_size({'width':1280,'height':900})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'runtime-323-notice-desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    version.select_option(by_label[stable])
    assert not cache_notice.is_visible()
    assert legacy in by_label,options
    assert [item['label'] for item in options].index(legacy)==[item['label'] for item in options].index(preview)+1,options
    legacy_notice=page.get_by_role('note').filter(has_text='3.22.0 adds bidder rules')
    assert legacy_notice.count()==0
    version.select_option(by_label[legacy])
    legacy_notice.wait_for()
    assert legacy_notice.text_content()==legacy_warning(current_label),legacy_notice.text_content()
    assert legacy_notice.get_attribute('class')==preview_notice_class
    # Screen readers hear the warning with the select, not only when reading the page.
    expect(version).to_have_accessible_description(legacy_warning(current_label))
    assert page.locator('.script-version-summary').text_content().startswith('Script version 3.22.0 · Unsaved version change')
    assert not preview_notice.is_visible()
    assert page.get_by_role('button',name='Save script setup',exact=True).is_enabled()
    fit=select_fits(version);fits.append({'viewport':390,'context':'Script setup','state':'selected',**fit});assert fit['fits'],fit
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'runtime-322-notice-mobile.png'),full_page=True)
    assert all(r['method']=='GET' for r in requests)
    page.get_by_role('button',name='Use current version',exact=True).click()
    assert version.input_value()==by_label[stable]
    assert legacy_notice.count()==0
    assert version.get_attribute('aria-describedby') is None
    chosen='3.14.0'
    version.select_option(next(item['value'] for item in options if item['label'].split(' · ')[0]==chosen))
    assert page.get_by_text('Frozen engine',exact=True).count()==0
    assert all(r['method']=='GET' for r in requests)
    page.get_by_role('button',name='Save script setup',exact=True).click()
    page.get_by_role('status').filter(has_text='Script setup saved').wait_for()
    saves=[json.loads(request['body']) for request in requests if request['method']=='POST']
    assert len(saves)==1 and saves[0]['action']=='setup' and saves[0]['runtime']['runtimeVersion']==chosen and saves[0]['enablePrebid'] is False,saves
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'simple-adx-mobile.png'),full_page=True)
    # Return to the real Releases wrapper: setup persists, no profile or Prebid required.
    page.goto('https://tessera.fixture.invalid/setup')
    page.get_by_role('button',name='Change script setup',exact=True).wait_for()
    page.get_by_role('button',name='Generate and save package',exact=True).click()
    page.get_by_role('status').filter(has_text='Package saved in Releases').wait_for()
    with page.expect_download() as download:
        page.get_by_role('button',name='Download saved ZIP',exact=True).click()
    path=out/'simple-adx.zip';download.value.save_as(path)
    with zipfile.ZipFile(path) as package:
        assert 'prebid.js' not in package.namelist()
        assert 'prebid.js' not in package.read('implementation.html').decode()
        config=json.loads(package.read('config.json'))
        assert config['prebidBuild'] is None
        assert config['runtime']['runtimeVersion']==chosen
        assert json.loads(package.read('manifest.json'))['runtime']==config['runtime']
    page.set_viewport_size({'width':1280,'height':900})
    page.screenshot(path=str(out/'simple-adx-desktop-releases.png'),full_page=True)
    # Save 3.22.0 explicitly on desktop: no preview opt-in, the warning stays
    # beside the saved version, and Releases labels the saved version.
    page.get_by_role('button',name='Change script setup',exact=True).click()
    version=page.get_by_role('combobox',name='Script version',exact=True);version.wait_for()
    options=version.locator('option').evaluate_all('(items)=>items.map(item=>({label:item.textContent.trim(),value:item.value}))')
    by_label={item['label']:item['value'] for item in options}
    assert legacy in by_label,options
    legacy_notice=page.get_by_role('note').filter(has_text='3.22.0 adds bidder rules')
    assert legacy_notice.count()==0
    version.select_option(by_label[legacy])
    legacy_notice.wait_for()
    assert legacy_notice.text_content()==legacy_warning(current_label)
    page.screenshot(path=str(out/'runtime-322-notice-desktop.png'),full_page=True)
    page.get_by_role('button',name='Save script setup',exact=True).click()
    # The Releases wrapper closes the editor after a confirmed save; its saved line is the result.
    summary=page.locator('.script-version-summary').filter(has_text='GAM / AdX only')
    summary.wait_for()
    saves=[json.loads(request['body']) for request in requests if request['method']=='POST' and request['path'].endswith('/builtin-site-settings')]
    assert len(saves)==2 and saves[1]['runtime']['runtimeVersion']=='3.22.0' and saves[1]['allowPreview'] is False and saves[1]['enablePrebid'] is False,saves
    assert summary.text_content().startswith('GAM / AdX only · '+legacy),summary.text_content()
    page.screenshot(path=str(out/'runtime-322-saved-desktop-releases.png'),full_page=True)
    page.get_by_role('button',name='Change script setup',exact=True).click()
    version=page.get_by_role('combobox',name='Script version',exact=True);version.wait_for()
    legacy_notice.wait_for()
    assert version.locator('option:checked').text_content().strip()==legacy
    assert legacy_notice.text_content()==legacy_warning(current_label)
    expect(version).to_have_accessible_description(legacy_warning(current_label))
    assert page.locator('.script-version-summary').filter(has_text='Script version').text_content().startswith('Script version 3.22.0 · Saved version')
    page.screenshot(path=str(out/'runtime-322-saved-desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    assert legacy_notice.is_visible() and legacy_notice.text_content()==legacy_warning(current_label)
    fit=select_fits(version);fits.append({'viewport':390,'context':'Releases inline setup','state':'saved',**fit});assert fit['fits'],fit
    page.screenshot(path=str(out/'runtime-322-saved-mobile.png'),full_page=True)
    # With 3.22.0 saved and another version selected, its choice still says it is the saved version.
    page.get_by_role('button',name='Use current version',exact=True).click()
    assert version.input_value()==by_label[stable]
    labels=[label.strip() for label in version.locator('option').all_text_contents()]
    assert legacy+' · Saved version' in labels and legacy not in labels,labels
    assert page.locator('.script-version-summary').filter(has_text='Script version').text_content().startswith('Script version '+current_label+' · Unsaved version change')
    assert legacy_notice.count()==0
    page.screenshot(path=str(out/'runtime-322-saved-switched-mobile.png'),full_page=True)
    version.select_option(by_label[legacy])
    legacy_notice.wait_for()
    assert version.locator('option:checked').text_content().strip()==legacy
    assert page.locator('.script-version-summary').filter(has_text='Script version').text_content().startswith('Script version 3.22.0 · Saved version')
    page.get_by_role('button',name='Cancel setup changes',exact=True).click()
    summary.wait_for()
    assert summary.text_content().startswith('GAM / AdX only · '+legacy)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'runtime-322-saved-mobile-releases.png'),full_page=True)
    dashboard_fits(browser)
    assert not errors,errors
    browser.close()
    (out/'release-setup-result.json').write_text(json.dumps({'passed':True,'requests':requests,'errors':errors,'runtime322SelectFit':fits},indent=2))
    print('PASS main Releases missing-Prebid recovery, one-save GAM-only setup, preserved choice and downloaded ZIP without Prebid; 3.22.0 labeled, explained and saved at 390/1280, its label fitting every 390 px Script version select in default fonts')
finally:
 process.stdin.close();process.wait(timeout=10)
