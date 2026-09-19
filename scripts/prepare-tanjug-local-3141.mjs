// Reproducible standalone control override. No network or live activation.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {zipSync,unzipSync} from 'fflate';
import {prepareTanjugCacheReview} from '../worker/pilots/tanjug-cache-review.mjs';
import {buildArtifactCandidate,runtimeDescriptor} from '../worker/runtime-variant-en/artifact-candidate.mjs';
import {previewInput,PREBID_SHA256} from '../worker/runtime-cache/snapshot.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {describeCandidate} from '../worker/runtime/draft-release-store.mjs';
import {prebidRequirements,inspectPrebidArtifact,parsePrebidHeader} from '../worker/runtime/prebid-artifact-check.mjs';
import {LIVE_SCRIPTS,hash} from './capture-tanjug-live-baseline.mjs';

const root=new URL('../',import.meta.url),read=path=>readFileSync(new URL(path,root));
const proposal=JSON.parse(read('worker/pilots/tanjug-cache-review-v1.json'));
const sourceBytes=read(proposal.sourceFile),prebidBytes=read('vendor/prebid/tanjug-11.34.0/prebid.js');
// Reuse the already reviewed frozen source and explicit two-position scope.
// The old proposal, snapshots, runtime records and ZIPs are not rewritten.
const old=await prepareTanjugCacheReview({proposal,sourceBytes,prebidBytes});
const snapshot=structuredClone(old.snapshots.control),buildTimestamp='20260918_160000';
const pin=pinRuntime(runtimeDescriptor,{allowPreview:true});
assert.equal(pin.runtimeVersion,'3.14.1');
assert.equal(pin.runtimeSha256,'b56d25f3bbf97e604f4f161dda2edd1f27237ed0ae84e9a3e1f7a182b334035e');
const config=JSON.parse(snapshot.config.config_json);
assert.deepEqual(config.runtimeControls.bidCache,{mode:'fresh-only',maxAgeSeconds:60});
assert.deepEqual(snapshot.units.map(u=>u.code).sort(),['Billboard','Sticky']);
const input=previewInput(snapshot,runtimeDescriptor,buildTimestamp,proposal.takeOver);
const requirements=prebidRequirements(input,config),header=parsePrebidHeader(prebidBytes.toString());
const build={id:'tanjug-cache-reviewed-prebid',publisher_id:proposal.siteId,status:'current',version:header.version,
 modules_json:JSON.stringify(header.modules),file_key:`publishers/${proposal.siteId}/prebid-builds/tanjug-cache-reviewed-prebid/prebid.js`};
const report=await inspectPrebidArtifact({siteId:proposal.siteId,builds:[build],requirements},{get:async key=>{
 assert.equal(key,build.file_key);
 return {size:prebidBytes.length,customMetadata:{sha256:PREBID_SHA256,version:header.version},
  arrayBuffer:async()=>Uint8Array.from(prebidBytes).buffer};
}});
assert.equal(report.status,'checked');
const candidate=await buildArtifactCandidate({snapshot,pin,buildTimestamp,takeOver:proposal.takeOver,
 prebid:{report,bytes:Uint8Array.from(prebidBytes).buffer}});
const {descriptor}=await describeCandidate(proposal.siteId,candidate);
const normalized=JSON.parse(new TextDecoder().decode(candidate.files['config.json']));
assert.deepEqual(normalized.bidCache,{mode:'fresh-only',maxAgeSeconds:60});
const js=new TextDecoder().decode(candidate.files['ads.min.js']);
assert(js.includes('Variant'));assert(!js.includes('Varijant'));assert(!js.includes('tessera_ab'));
assert.equal(hash(candidate.files['prebid.js']),PREBID_SHA256);
const mappings=Object.entries(LIVE_SCRIPTS).map(([name,url])=>{
 const sourceFile=name==='ads.js'?'ads.min.js':name,bytes=candidate.files[sourceFile];
 assert.equal(hash(bytes),candidate.manifest.files[sourceFile].sha256);
 return {url,path:'overrides/tanjug.pages.dev/'+name,sourceFile,byteSize:bytes.length,sha256:hash(bytes)};
});
const mapping={schemaVersion:1,runtime:pin,prebidVersion:header.version,mode:'fresh-only',
 packageSha256:descriptor.packageSha256,sourceFile:proposal.sourceFile,sourceSha256:proposal.sourceSha256,
 sourceConfiguration:'Frozen 14 September TEST source; not asserted to match current live settings.',
 positions:['Billboard','Sticky'],omittedPositions:old.report.scope.excludedUnits,mappings,
 experiment:{active:false,assignment:null,targetingKey:'Variant',expectedTargetingValue:null,
  note:'Standalone runtime only. No loader context is fabricated and no A/B value is expected.'},
 readiness:'prepared-not-executed-on-live',scope:'One operator browser profile. Local Overrides persist until disabled.',
 rollback:'Disable Local Overrides and reload to return to current CDN responses.'};
const files=Object.fromEntries(mappings.map(m=>[m.path,candidate.files[m.sourceFile]]));
const encode=text=>new TextEncoder().encode(text);
files['mapping.json']=encode(JSON.stringify(mapping,null,2)+'\n');
files['README.md']=encode(`# Tanjug — 3.14.1 — lokalni control override

ads.js 3.14.1 · Prebid 11.34.0 · nova aukcija · keš isključen.
Ovaj paket služi za proveru rada nove skripte u tvom browseru na živom Tanjugu.
Sadrži samo Billboard i Sticky. Ostale pozicije nisu uključene u ovu lokalnu proveru.
Postavka dolazi iz pregledanog TEST izvora od 14. septembra; nije potvrđena kao današnja postavka celog sajta.

## Uključivanje

1. Raspakuj ZIP u novi folder, odvojeno od ranijeg paketa. Koristi jedan Tanjug tab.
2. U DevTools → Sources → Overrides isključi stari override i ukloni samo njegovu vezu sa folderom (Remove from workspace). Izaberi folder overrides iz ovog ZIP-a, dozvoli pristup i uključi Enable Local Overrides.
3. Network: No throttling, Keep log OFF. Sa otvorenim DevTools uradi Cmd+R.
4. Filtriraj domain:tanjug.pages.dev. Proveri da i ads.js i prebid.js imaju oznaku lokalnog override-a. Ako se zamenjuje samo jedan fajl, isključi override i proveri folder.
5. Proveri da se pokrenula samo jedna skripta, verziju 3.14.1, Prebid 11.34.0, CMP, Billboard, Sticky i refresh. Pošalji Network screenshot oba fajla za naredni korak.

## Šta očekivati za Variant

Ovo nije uključen A/B test. Paket pokreće samo samostalnu kontrolnu skriptu;
ne postavlja niti izmišlja A/B dodelu. Bez aktivnog A/B loadera ne očekuj Variant=A/B
u Google Publisher Console. Tu oznaku proveravamo u zasebnom koraku sa loaderom.
Ne dodaj drugu skriptu kroz konzolu i ne kombinuj ovaj folder sa starim paketom.
Paket zamenjuje samo dva JavaScript odgovora. HTML, Funding Choices, GPT i bezbednosna zaglavlja ostaju postojeći.

## Završetak provere

Isključi Enable Local Overrides i osveži stranicu. Proveri da oba fajla ponovo stižu
sa CDN-a. Samo zatvaranje taba ne isključuje sačuvane override-e.
Promena važi samo u tvom browseru; ne objavljuje skriptu za druge posetioce.
Na živom sajtu tokom provere mogu nastati stvarni zahtevi za oglase.
Local Overrides isključuje browser cache, pa ovo nije test brzine ili prihoda.

Chrome uputstvo: https://developer.chrome.com/docs/devtools/overrides
`);
const archive=zipSync(Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,[bytes,{level:0,mtime:new Date(1980,0,1,0,0,0)}]])),{level:0});
const roundtrip=unzipSync(archive);
assert.deepEqual(Object.keys(roundtrip).sort(),Object.keys(files).sort());
for(const [name,bytes] of Object.entries(files))assert.deepEqual(roundtrip[name],bytes);
const out=new URL('.generated/tanjug-local-3141/',root);mkdirSync(out,{recursive:true});
writeFileSync(new URL('tanjug-3.14.1-control-override.zip',out),archive);
writeFileSync(new URL('mapping.json',out),JSON.stringify(mapping,null,2)+'\n');
console.log(JSON.stringify({version:pin.runtimeVersion,mode:normalized.bidCache.mode,packageSha256:descriptor.packageSha256,
 zipSha256:hash(archive),byteSize:archive.length,mappings,experiment: mapping.experiment}));
