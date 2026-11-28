"""Exercise actual compiled display/native renderer payloads with real observer API.

The functional probe wraps the constructor only to inject a synthetic intervention
and observe cleanup; it is never used for the separate quantitative memory pair.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright


def run(browser, source, renderer, fixed):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    escaped = []
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def route(request):
        if request.request.url == 'https://observer435.example.invalid/':
            request.fulfill(content_type='text/html', body='<!doctype html><html><body></body></html>')
        else:
            escaped.append(request.request.url)
            request.abort()
    context.route('**/*', route)
    try:
        page.goto('https://observer435.example.invalid/')
        result = page.evaluate("""async ({source, renderer, fixed}) => {
          const persistent = document.createElement('iframe');
          const target = document.createElement('iframe');
          document.body.append(persistent, target);
          function probe(win) {
            const Original = win.ReportingObserver;
            if (typeof Original !== 'function') throw Error('Original API missing');
            const instances = [];
            win.ReportingObserver = function(callback, options) {
              const original = new Original(callback, options);
              const item = {callback, options, disconnects: 0, queued: []};
              instances.push(item);
              const take = original.takeRecords.bind(original), disconnect = original.disconnect.bind(original);
              original.takeRecords = () => [...item.queued.splice(0), ...take()];
              original.disconnect = () => { item.disconnects++; disconnect(); };
              return original;
            };
            win.ReportingObserver.prototype = Original.prototype;
            return {instances, available: typeof Original === 'function'};
          }
          const cached = probe(persistent.contentWindow), creative = probe(target.contentWindow);
          persistent.contentWindow.eval(source);
          const messages = [];
          const utilities = {
            sendMessage(type, payload) { messages.push({type, payload}); },
            mkFrame(doc, attrs) {
              const frame = doc.createElement('iframe');
              Object.entries(attrs).forEach(([key, value]) => frame.setAttribute(key, value));
              return frame;
            }
          };
          const data = renderer === 'display'
            ? {ad: '<div data-observer435>synthetic display</div>', width: 300, height: 250}
            : {adId: 'synthetic-native', native: {adTemplate: '<div data-observer435>synthetic native</div>'}};
          await persistent.contentWindow.render(data, utilities, target.contentWindow);
          const owner = fixed ? creative : cached;
          const wrong = fixed ? cached : creative;
          if (owner.instances.length !== 1 || wrong.instances.length !== 0) throw Error('Wrong observer ownership');
          const first = owner.instances[0], payload = {type: 'intervention', body: {id: 'fixture-intervention', message: 'synthetic'}};
          const interventions = () => messages.filter(message => message.payload.event === 'browserIntervention');
          first.callback([payload]);
          if (interventions().length !== 1 || JSON.stringify(interventions()[0]) !== JSON.stringify({type: 'Prebid Event', payload: {event: 'browserIntervention', intervention: payload}})) throw Error('Intervention payload changed');
          if (first.options.buffered !== true || first.options.types.join(',') !== 'intervention') throw Error('Observer options changed');
          if (fixed) {
            // The same Document can render another winning ad without accumulating registrations.
            await persistent.contentWindow.render(data, utilities, target.contentWindow);
            if (first.disconnects !== 1 || creative.instances.length !== 2) throw Error('Repeated-document registration retained');
            first.callback([payload]);
            if (interventions().length !== 1) throw Error('Old callback still active');
            const current = creative.instances[1];
            current.callback([payload]);
            const hide = persisted => {
              const event = new target.contentWindow.Event('pagehide');
              Object.defineProperty(event, 'persisted', {value: persisted});
              target.contentWindow.dispatchEvent(event);
            };
            hide(true);
            if (current.disconnects) throw Error('BFCache entry lost observer');
            current.callback([payload]);
            current.queued.push(payload);
            hide(false);
            if (current.disconnects !== 1 || interventions().length !== 4) throw Error('Final report not drained or cleanup missing');
            current.callback([payload]);
            hide(false);
            if (current.disconnects !== 1 || interventions().length !== 4) throw Error('Late callback or duplicate cleanup');
          } else {
            target.contentWindow.dispatchEvent(new target.contentWindow.Event('pagehide'));
            if (first.disconnects !== 0) throw Error('Control unexpectedly has lifecycle cleanup');
          }
          return {renderer, fixed, creator: fixed ? 'rendered-document' : 'cached-renderer',
            cachedRegistrations: cached.instances.length, creativeRegistrations: creative.instances.length,
            interventionPayloads: interventions(), observerApiStillAvailable: typeof target.contentWindow.ReportingObserver === 'function',
            disconnects: owner.instances.map(item => item.disconnects), passed: true};
        }""", {'source': source, 'renderer': renderer, 'fixed': fixed})
        assert not errors and not escaped, {'errors': errors, 'escaped': escaped}
        return result | {'errors': errors, 'unexpectedNetwork': escaped}
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixed', type=Path, required=True)
    parser.add_argument('--control', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    report = {'passed': False, 'cases': [], 'scope': 'Compiled renderer functional probe, not heap measurement or paid traffic.'}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH'), args=['--no-sandbox'])
            try:
                for label, path in [('control', args.control), ('fixed', args.fixed)]:
                    if path is None:
                        continue
                    manifest = json.loads((path / 'manifest.json').read_text())
                    for renderer in ['display', 'native']:
                        source = (path / f'renderer-{renderer}.js').read_text()
                        assert hashlib.sha256(source.encode()).hexdigest() == manifest['rendererSha256'][renderer]
                        report['cases'].append(run(browser, source, renderer, label == 'fixed'))
            finally:
                browser.close()
        report['passed'] = all(case['passed'] for case in report['cases']) and len(report['cases']) >= 2
    except Exception as error:
        import traceback
        report.update(error=repr(error), traceback=traceback.format_exc())
    (args.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'cases': len(report['cases']), 'report': str(args.out / 'report.json')}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
