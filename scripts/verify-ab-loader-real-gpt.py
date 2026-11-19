"""Bounded offline generic-loader regressions with exact native 3.25.1 and real GPT.

All requests are intercepted. GAM receives local 204 responses. This proves
outgoing cust_params/prev_scp and startup ownership, not paid/hosted delivery.
The receipt is written on failures too; no failing case is retried.
"""
import hashlib
import json
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / '.generated/ab-loader-real-gpt'
ORIGIN = 'https://reporting.example.invalid'
NOW = datetime(2026, 11, 20, 1, tzinfo=timezone.utc)
CASES = ['clean-first-and-refresh', 'early-keywords', 'set-config-during-cmp',
         'slot-reserved-before-dispatch', 'expired-b-before-a', 'expired-b-after-a',
         'publisher-gpt-labels', 'late-setter-and-refresh']

SETUP = r'''
(()=>{
 const options=%OPTIONS%;window.__nativeStarts=[];window.__refresh=[];window.__cmpListeners=[];
 window.__publisherOriginal=Object.freeze(options.keywords);
 window.adsKeywords=window.__publisherOriginal;
 window.__cmpReady=!options.pendingCmp;
 window.__AD_GEO={version:1,getSnapshot:()=>({version:1,status:'known',country:'RS',source:'cloudflare'}),ready:()=>Promise.resolve(__AD_GEO.getSnapshot())};
 window.__tcfapi=(command,version,callback)=>{
  const data=()=>__cmpReady?{gdprApplies:false,listenerId:1,eventStatus:'tcloaded',cmpStatus:'loaded'}:
   {gdprApplies:true,listenerId:1,eventStatus:'cmpuishown',cmpStatus:'loaded'};
  if(command==='addEventListener'){__cmpListeners.push(callback);callback(data(),true);}
  else if(command==='getTCData')callback(data(),true);
  else if(command==='ping')callback({cmpLoaded:true,gdprApplies:!__cmpReady,cmpStatus:'loaded'},true);
  else callback(true);
 };
 window.__releaseCmp=()=>{__cmpReady=true;for(const cb of __cmpListeners)cb({gdprApplies:false,listenerId:1,eventStatus:'useractioncomplete',cmpStatus:'loaded'},true);};
 window.googletag={cmd:[()=>{
  const p=googletag.pubads(),refresh=p.refresh;
  p.refresh=function(slots,settings){
   __refresh.push({at:performance.now(),page:Object.fromEntries(p.getTargetingKeys().map(k=>[k,p.getTargeting(k)])),
    slots:(slots||p.getSlots()).map(s=>({id:s.getSlotElementId(),keys:Object.fromEntries(s.getTargetingKeys().map(k=>[k,s.getTargeting(k)]))}))});
   return refresh.apply(this,arguments);
  };
  if(options.publisherLabels){p.setTargeting('Variant','publisher');p.setTargeting('TestId','publisher_test');p.setTargeting('section','sport');}
  if(options.slotConflict){
   const define=googletag.defineSlot;
   googletag.defineSlot=function(){
    const slot=define.apply(this,arguments);
    if(slot){
     if(slot.getSlotElementId()==='Billboard'){slot.setTargeting('Variant','FORGED_SLOT');slot.setTargeting('TestId','slot_test');}
     else slot.setConfig({targeting:{Variant:'FORGED_CONFIG',TestId:'slot_config_test'}});
     slot.setTargeting('slot_section','sport');
    }
    return slot;
   };
  }
 }]};
})();
'''


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def decode_gam(url):
    query = parse_qs(urlsplit(url).query)
    ids = query.get('dids', [''])[0].split('~')
    values = query.get('prev_scp', [''])[0].split('|')
    return {'page': parse_qs(query.get('cust_params', [''])[0]),
            'slots': {ids[i]: parse_qs(value) for i, value in enumerate(values) if i < len(ids)}}


def advance(page, milliseconds):
    while milliseconds:
        step = min(milliseconds, 250)
        page.clock.run_for(step)
        page.wait_for_timeout(2)
        milliseconds -= step


def pump(page, condition, message):
    for _ in range(400):
        if condition():
            return
        page.clock.run_for(10)
        page.wait_for_timeout(2)
    raise AssertionError(message)


def check(result, condition, message):
    result['checks'].append({'passed': bool(condition), 'message': message})
    if not condition:
        raise AssertionError(message)


def case(browser, name, manifest, files, gpt):
    result = {'case': name, 'status': 'failed', 'checks': [], 'wire': [], 'refresh': [],
              'servedArms': [], 'checkpoints': [], 'errors': [], 'blocked': []}
    context = browser.new_context(viewport={'width': 1280, 'height': 900}, timezone_id='UTC', service_workers='block')
    page = context.new_page()
    held = {}
    paths = {side: '/' + arm['path'] for side, arm in manifest['arms'].items()}
    page.on('pageerror', lambda error: result['errors'].append(str(error)))

    def observe_startup():
        # A call-through observer on the loader's accessor records real startup writes.
        # Unlike a breakpoint on a minified assignment, this cannot resolve to the
        # preceding guard/read. Frozen script/SRI bytes and accessor behavior stay intact.
        page.evaluate('''paths=>{
          if(window.__observingStartup)return;
          const previous=Object.getOwnPropertyDescriptor(window,'__TESSERA_RUNTIME_STARTED');
          if(!previous||typeof previous.get!=='function'||typeof previous.set!=='function')throw Error('Missing loader startup accessor');
          Object.defineProperty(window,'__TESSERA_RUNTIME_STARTED',{configurable:previous.configurable,enumerable:previous.enumerable,
            get:function(){return previous.get.apply(this,arguments);},
            set:function(){const script=document.currentScript?.src||null;const side=Object.keys(paths).find(side=>script===location.origin+paths[side])||'unknown';
              __nativeStarts.push({side,script,at:performance.now()});return previous.set.apply(this,arguments);}});
          window.__observingStartup=true;
        }''', paths)

    def route(request):
        url = request.request.url
        path = urlsplit(url).path
        if url == ORIGIN + '/fixture':
            request.fulfill(content_type='text/html', body='<!doctype html><html><head><link rel="icon" href="data:,"><script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script><script defer src="/ads.js"></script></head><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div></body></html>')
        elif url == ORIGIN + '/ads.js':
            request.fulfill(content_type='application/javascript', body=files['ads.js'])
        elif path in paths.values():
            observe_startup()
            side = next(side for side, value in paths.items() if path == value)
            result['servedArms'].append(side)
            if name.startswith('expired-b-'):
                held[side] = request
            else:
                request.fulfill(content_type='application/javascript', headers={'access-control-allow-origin': '*'}, body=files[path[1:]])
        elif url in gpt:
            request.fulfill(content_type='application/javascript', body=gpt[url])
        elif '/gampad/ads?' in url:
            result['wire'].append(decode_gam(url))
            request.fulfill(status=204, body='')
        else:
            result['blocked'].append(url)
            request.abort()

    def snapshot(label):
        entry = {'label': label, 'wireCount': len(result['wire']),
                 'state': page.evaluate('AdVariant.snapshot()'),
                 'nativeStarts': page.evaluate('__nativeStarts')}
        result['checkpoints'].append(entry)
        return entry

    try:
        context.route('**/*', route)
        # Require the immutable native entry guard used by the retired-arm gate.
        for side, path in paths.items():
            source = files[path[1:]].decode('utf8')
            anchor = 'window.__TESSERA_RUNTIME_STARTED='
            check(result, source.count(anchor) == 1, 'One native startup assignment in arm ' + side)
            check(result, 'if(window.__TESSERA_RUNTIME_STARTED)return;' in source, 'Native startup guard precedes execution in arm ' + side)
        page.clock.install(time=NOW)
        page.clock.pause_at(NOW + timedelta(seconds=1))
        keywords = {'publisher_key': 'preserved'}
        if name == 'early-keywords':
            keywords.update({'Variant': 'FORGED', 'TestId': 'forged_test'})
        options = {'keywords': keywords, 'pendingCmp': name == 'set-config-during-cmp',
                   'slotConflict': name == 'slot-reserved-before-dispatch', 'publisherLabels': name == 'publisher-gpt-labels'}
        page.add_init_script(SETUP.replace('%OPTIONS%', json.dumps(options)))
        page.goto(ORIGIN + '/fixture', wait_until='domcontentloaded')
        pump(page, lambda: page.evaluate('!!window.__tesseraAbLoader'), 'Loader did not initialize')
        if name.startswith('expired-b-'):
            pump(page, lambda: 'B' in held, 'Assigned B was not requested')
            advance(page, manifest['armDeadlineMs'])
            pump(page, lambda: 'A' in held, 'Arm deadline did not request control A')
            pending = snapshot('control-A-pending')
            check(result, not pending['state']['runtimeStarted'] and not result['wire'], 'Fallback starts no runtime/request while A is pending')
            order = ['B', 'A'] if name == 'expired-b-before-a' else ['A', 'B']
            for side in order:
                held[side].fulfill(content_type='application/javascript', headers={'access-control-allow-origin': '*'}, body=files[paths[side][1:]])
                page.wait_for_timeout(50)
                advance(page, 1500)
                point = snapshot('released-' + side)
                if side == 'B' and order[0] == 'B':
                    check(result, not point['state']['runtimeStarted'] and not result['wire'], 'Retired B cannot start before A')
            state = page.evaluate('AdVariant.snapshot()')
            check(result, state['fallback'] and state['scriptRelease'] == manifest['arms']['A']['release'], 'Fallback executes control A')
            check(result, state['blockedLateArmStarts'] >= 1, 'Late B was stopped by the immutable native guard')
            check(result, len(result['wire']) == 1, 'Late B creates no duplicate GAM request')
        else:
            pump(page, lambda: page.evaluate('!!window.__TESSERA_RUNTIME_STARTED'), 'Native runtime did not start')
            if name == 'set-config-during-cmp':
                advance(page, 1000)
                check(result, not result['wire'] and not page.evaluate('__refresh.length'), 'Pending CMP sends no GAM request')
                page.evaluate("window.__configInput={targeting:{Variant:'FORGED',TestId:'forged_test',section:'news'}};window.__configBefore=JSON.stringify(__configInput);googletag.setConfig(__configInput)")
                check(result, page.evaluate('JSON.stringify(__configInput)===__configBefore'), 'setConfig caller input is unchanged')
                snapshot('conflict-before-CMP-decision')
                page.evaluate('__releaseCmp()')
            advance(page, 2500)
            pump(page, lambda: bool(result['wire']), 'No actual outgoing GAM request')
            snapshot('first-GAM')
            if name == 'late-setter-and-refresh':
                page.evaluate("googletag.pubads().setTargeting('TestId','forged_test');googletag.pubads().setTargeting('section','news')")
                snapshot('reserved-write-after-first-GAM')
            if name in ['clean-first-and-refresh', 'late-setter-and-refresh']:
                advance(page, 65000)
                check(result, len(result['wire']) >= 3, 'Initial request and two native automatic GAM-only refreshes observed')
                snapshot('two-native-refreshes')

        result['state'] = page.evaluate('AdVariant.snapshot()')
        result['refresh'] = page.evaluate('__refresh')
        result['nativeStarts'] = page.evaluate('__nativeStarts')
        check(result, len(result['nativeStarts']) == 1, 'Exactly one immutable native runtime starts')
        if name.startswith('expired-b-'):
            check(result, result['nativeStarts'][0]['side'] == 'A', 'Only control A reaches its startup assignment')
        check(result, not result['errors'], 'No uncaught browser errors')
        check(result, bool(result['wire']), 'Actual GAM serialization was captured')
        for request in result['wire']:
            check(result, request['page'].get('publisher_key') == ['preserved'], 'Unrelated publisher page targeting survives')
            check(result, set(request['slots']) == {'Billboard', 'P1'}, 'Both native slot positions reach GAM')
        measured = name in ['clean-first-and-refresh', 'expired-b-before-a', 'expired-b-after-a']
        if measured:
            for request in result['wire']:
                check(result, request['page'].get('Variant') == ['B'] and request['page'].get('TestId') == [manifest['testId']], 'GAM carries exactly the assigned Variant and TestId')
                check(result, all(not slot.get('Variant') and not slot.get('TestId') for slot in request['slots'].values()), 'No slot shadows the measured page labels')
        elif name == 'publisher-gpt-labels':
            check(result, result['state']['variant'] is None and result['servedArms'] == ['A'], 'Publisher label conflict chooses unmeasured A')
            for request in result['wire']:
                check(result, request['page'].get('Variant') == ['publisher'] and request['page'].get('TestId') == ['publisher_test'], 'Pre-existing publisher labels are preserved')
        else:
            check(result, result['state']['variant'] is None and result['state']['keyConflict'], 'Reserved label conflict excludes measurement')
            requests = result['wire'][1:] if name == 'late-setter-and-refresh' else result['wire']
            for request in requests:
                check(result, not request['page'].get('Variant') and not request['page'].get('TestId'), 'Excluded GAM request contains no Tessera page labels')
                if name in ['set-config-during-cmp', 'late-setter-and-refresh']:
                    check(result, request['page'].get('section') == ['news'], 'Unrelated targeting from the same call survives')
                if name == 'slot-reserved-before-dispatch':
                    for code, variant, test_id in [('Billboard', 'FORGED_SLOT', 'slot_test'), ('P1', 'FORGED_CONFIG', 'slot_config_test')]:
                        slot = request['slots'][code]
                        check(result, slot.get('Variant') == [variant] and slot.get('TestId') == [test_id] and slot.get('slot_section') == ['sport'], 'Foreign slot data is preserved: ' + code)
        check(result, page.evaluate('JSON.stringify(__publisherOriginal)') == json.dumps(keywords, separators=(',', ':')), 'The original publisher keyword object is not mutated')
        if name == 'early-keywords':
            check(result, result['servedArms'] == ['A'], 'Early keyword conflict never loads B')
        result['status'] = 'passed'
    except Exception as error:
        result['error'] = str(error)
        result['traceback'] = traceback.format_exc()
        try:
            result['state'] = page.evaluate('window.AdVariant?.snapshot()||null')
            result['refresh'] = page.evaluate('window.__refresh||[]')
            result['nativeStarts'] = page.evaluate('window.__nativeStarts||[]')
        except Exception as capture_error:
            result['captureError'] = str(capture_error)
    finally:
        context.close()
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'schemaVersion': 1, 'scope': 'Offline GAM-only native 3.25.1 + pinned real GPT; local204 GAM, no paid traffic or hosted/SSP acceptance.',
              'cases': [], 'status': 'failed'}
    try:
        manifest = json.loads((OUT / 'manifest.json').read_text())
        assert manifest['schemaVersion'] == 1 and manifest['runtime']['runtimeVersion'] == '3.25.1'
        assert manifest['loader']['version'] == '1.0.2' and manifest['assigned'] == 'B'
        report['loader'] = manifest['loader']
        report['fixtureManifestSha256'] = sha256((OUT / 'manifest.json').read_bytes())
        files = {}
        for name, expected in manifest['files'].items():
            path = (OUT / name).resolve()
            assert path.is_relative_to(OUT), 'Fixture path escaped its directory'
            data = path.read_bytes()
            assert sha256(data) == expected['sha256'] and len(data) == expected['bytes'], 'Changed fixture: ' + name
            files[name] = data
        record = json.loads(files['record.json'])
        assert record['loader'] == manifest['loader'] and record['arms'] == manifest['arms']
        for arm in manifest['arms'].values():
            assert sha256(files[arm['path']]) == arm['sha256']
        gpt = {}
        for entry in manifest['gpt']['files']:
            path = (ROOT / manifest['gptRoot'] / entry['file']).resolve()
            assert path.is_relative_to(ROOT / 'vendor/gpt'), 'Unexpected GPT asset path'
            data = path.read_bytes()
            assert sha256(data) == entry['sha256'] and len(data) == entry['bytes'], 'Changed pinned GPT: ' + entry['file']
            gpt[entry['url']] = data
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
            try:
                for name in CASES:
                    result = case(browser, name, manifest, files, gpt)
                    report['cases'].append(result)
                    print(result['status'].upper() + ' ' + name + (': ' + result['error'] if 'error' in result else ''), flush=True)
            finally:
                browser.close()
        report['status'] = 'passed' if len(report['cases']) == len(CASES) and all(row['status'] == 'passed' for row in report['cases']) else 'failed'
    except Exception as error:
        report['setupFailure'] = {'error': str(error), 'traceback': traceback.format_exc()}
        print('FAIL setup: ' + str(error), flush=True)
    finally:
        (OUT / 'browser-report.json').write_text(json.dumps(report, indent=2) + '\n')
        failures = [row for row in report['cases'] if row['status'] != 'passed']
        (OUT / 'failed-cases.json').write_text(json.dumps({'setupFailure': report.get('setupFailure'), 'cases': failures}, indent=2) + '\n')
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
