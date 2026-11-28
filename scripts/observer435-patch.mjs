/** Reviewed opt-in source patch for Prebid 11.34.0; never edits a released Tessera input. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const OBSERVER435_VARIANT='tessera-observer-lifecycle-1';
export const OBSERVER435_UPSTREAM=Object.freeze({version:'11.34.0',commit:'195e0c6069928ed906bde550cb4e4183d1dc8474',lockSha256:'077338389169c8834d5bd1dedacd92094fb3b0e05a1c54fb4de7ffaa4b7d02d9'});
export const OBSERVER435_BEFORE=Object.freeze({
  'creative/reporting.js':'a1cb0023df943fd3339f931b4ff39054bda6fb144fdd5e66d8f9a1a47b719a56',
  'creative/renderers/display/renderer.js':'6e75d531da972fbd7b3ec1e5b47d7d70e51226905015433d3e18f938032e53bb',
  'creative/renderers/native/renderer.js':'86ad0875d9bd6d69172de682c042ee129ac85ec45d1f81370539ef2d32d5dc8b',
});
export function observer435Modules(profile,explicit=false){
  assert(profile&&typeof profile==='object'&&!Array.isArray(profile),'Use an explicit Prebid module profile.');
  assert.equal(profile.version,OBSERVER435_UPSTREAM.version,'The module profile must explicitly select reviewed Prebid11.34.0. No implicit version upgrade.');
  assert(Array.isArray(profile.modules)&&profile.modules.length>0&&profile.modules.length<=1000&&profile.modules.every(name=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_]{0,119}$/.test(name)),'Invalid explicit module list.');
  const modules=[...new Set(explicit?profile.modules:[...profile.modules,'allowActivities','gptPreAuction','rtdModule','contextualSignalsRtdProvider','videoModule'])].sort();
  assert(modules.includes('consentManagementTcf')&&modules.includes('tcfControl'),'Keep native TCF consent modules in the reviewed build.');
  assert(!modules.includes('contextualAuditRtdProvider'),'Synthetic audit providers are not production candidates.');
  return modules;
}
export function observer435BuildDate(value){
  assert(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value,'Use an explicit valid UTC build date YYYY-MM-DD.');
  return value;
}
/** Upstream stamps today's UTC date. Normalize that one comment line, never executable code. */
export function normalizeObserver435Banner(input,date){
  const buildDate=observer435BuildDate(date),source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);
  const prefix=`/* prebid.js v${OBSERVER435_UPSTREAM.version}\nUpdated: `;
  assert(source.startsWith(prefix),'Unexpected upstream build banner.');
  const upstreamBannerDate=observer435BuildDate(source.slice(prefix.length,prefix.length+10));
  assert(source.slice(prefix.length+10).startsWith('\nModules: '),'Unexpected upstream banner date line.');
  const normalized=prefix+buildDate+source.slice(prefix.length+10),bodyStart=source.indexOf('*/')+2;
  assert(bodyStart>1&&normalized.slice(bodyStart)===source.slice(bodyStart),'Banner normalization changed executable bytes.');
  return{bytes:Buffer.from(normalized),buildDate,upstreamBannerDate,executableBodySha256:observer435Sha(source.slice(bodyStart))};
}

export const OBSERVER435_REPORTING_SOURCE=`// One registration per live render document, without rooting detached documents.
const registrations = new WeakMap();

export function registerReportingObserver(callback, types, document) {
  let view, owner, observer, disposed = false;
  const pagehide = (event) => {
    // A BFCache entry may return to the same creative and still needs reporting.
    if (!event.persisted) disconnect();
  };
  function disconnect() {
    if (disposed) return;
    disposed = true;
    if (owner && registrations.get(owner) === disconnect) registrations.delete(owner);
    try { view?.removeEventListener?.('pagehide', pagehide); } catch (e) {}
    const current = observer, notify = callback;
    observer = callback = owner = view = null;
    if (current) {
      // Preserve an intervention queued before the document leaves, then release it.
      try {
        const reports = current.takeRecords?.();
        if (reports?.length) notify(reports[0]);
      } catch (e) {}
      try { current.disconnect(); } catch (e) {}
    }
  }
  try {
    // An explicit inactive document must not fall back to the cached renderer realm.
    view = document === undefined ? window : document?.defaultView;
    owner = document === undefined ? view?.document : document;
    if (!view || !owner || !('ReportingObserver' in view)) return disconnect;
    registrations.get(owner)?.();
    observer = new view.ReportingObserver((reports) => {
      if (!disposed && reports?.length) callback(reports[0]);
    }, { buffered: true, types });
    observer.observe();
    registrations.set(owner, disconnect);
    view.addEventListener?.('pagehide', pagehide);
  } catch (e) {
    disconnect();
  }
  return disconnect;
}
`;

export const observer435Sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function observer435PatchedSource(name,source){
  assert.equal(observer435Sha(source),OBSERVER435_BEFORE[name],`Unexpected upstream source: ${name}`);
  if(name==='creative/reporting.js')return OBSERVER435_REPORTING_SOURCE;
  const before="  }, ['intervention']);",after="  }, ['intervention'], win.document);";
  assert.equal(source.split(before).length,2,`Ambiguous reporting call: ${name}`);
  return source.replace(before,after);
}
/** Verify all source inputs before writing any of them. Rerunning a patch is refused. */
export async function applyObserver435Patch(upstream){
  const changes=[];
  for(const [name,beforeSha256]of Object.entries(OBSERVER435_BEFORE)){
    const before=await readFile(resolve(upstream,name),'utf8'),after=observer435PatchedSource(name,before);
    changes.push({name,before,after,beforeSha256,afterSha256:observer435Sha(after)});
  }
  for(const {name,after}of changes)await writeFile(resolve(upstream,name),after);
  return changes.map(({name,beforeSha256,afterSha256})=>({name,beforeSha256,afterSha256}));
}
