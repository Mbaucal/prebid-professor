/** New delivery version only. The accepted A/A 1.0.0 archive is never rewritten. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {minify} from 'terser';
import {unzipSync} from 'fflate';
import {CMP_RELEASE,instrumentCmpRuntime,cmpLoader} from '../worker/experiments/cmp-aa-v1.mjs';
import {sha256,integrity,archiveStaticAAPackage,readStaticAAArchive} from './static-aa-package.mjs';

const release=CMP_RELEASE;
const read=p=>readFileSync(new URL('../'+p,import.meta.url)),encode=s=>Buffer.from(s);
const previousArchive=read('.generated/tanjug-aa/tanjug-aa-1.0.0.zip');
assert.equal(sha256(previousArchive),'bb66d583573099f46795e9e3cd9f700a5fad1581cafa7a62212b041882319993');
const old=unzipSync(previousArchive),prior=JSON.parse(Buffer.from(old['release.json']));
for(const [name,e] of Object.entries(prior.files))assert.equal(sha256(old[name]),e.sha256);
const base=read('.generated/tanjug-pilot/ads.js');assert.equal(sha256(base),prior.baseReadableSha256);
async function compact(source) {
  const result=await minify(source,{ecma:2020,compress:true,mangle:true,sourceMap:false,format:{comments:false}});
  assert(result.code&&!result.map);return encode(result.code+'\n');
}
const arm=await compact(instrumentCmpRuntime(base.toString()));
const folder='releases/'+release+'-'+sha256(arm).slice(0,16)+'/';
const config={...prior.config,release,armSha256:sha256(arm),prebidPath:folder+'prebid.js',
  arms:{A:{path:folder+'A.js',integrity:integrity(arm)},B:{path:folder+'B.js',integrity:integrity(arm)}}};
const loader=cmpLoader(config);
const files={};
for(const name of ['prebid.js','sticky.css','min-height.css','_headers','404.html'])files[name]=Buffer.from(old[name]);
files['ads.js']=await compact(loader);
files[config.arms.A.path]=arm;files[config.arms.B.path]=arm;files[config.prebidPath]=files['prebid.js'];
const manifest={schemaVersion:1,release,kind:'static-production-aa-compact',allocation:prior.allocation,
  key:'Variant',values:['A','B'],config,baseAdsSha256:prior.baseAdsSha256,baseReadableSha256:prior.baseReadableSha256,
  sourceConfigurationSha256:prior.sourceConfigurationSha256,previousArchiveSha256:sha256(previousArchive),
  prebidSha256:sha256(files['prebid.js']),
  files:Object.fromEntries(Object.keys(files).sort().map(name=>[name,{bytes:files[name].length,sha256:sha256(files[name])}]))};
const archive=archiveStaticAAPackage(manifest,files),archiveHash=sha256(archive);
// The deploy directory is materialized from the exact ZIP, not a second generation.
const delivered=readStaticAAArchive(manifest,archive,archiveHash);
const out=new URL('../.generated/tanjug-cmp/',import.meta.url);
function put(path,bytes) {
  const target=new URL(path,out);mkdirSync(new URL('.',target),{recursive:true});
  if(existsSync(target))assert.deepEqual(readFileSync(target),Buffer.from(bytes),'Existing compact delivery differs: '+path);
  else writeFileSync(target,bytes,{flag:'wx'});
}
const deploy=new URL('deploy/',out);
function paths(dir,prefix='') {
  return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?paths(new URL(e.name+'/',dir),prefix+e.name+'/'):[prefix+e.name]);
}
if(existsSync(deploy))assert(paths(deploy).every(p=>Object.hasOwn(delivered,p)),'Deployment directory contains unexpected files');
put(release+'.zip',archive);
for(const [name,bytes] of Object.entries(delivered))put('deploy/'+name,bytes);
// Private evidence and human instructions are siblings, never public ZIP entries.
put('release.json',encode(JSON.stringify(manifest,null,2)+'\n'));
const summary={release,sha256:archiveHash,bytes:archive.length,positions:config.positions.length,
  loaderBytesBefore:old['ads.js'].length,loaderBytesAfter:files['ads.js'].length,
  consentModuleAlwaysEnabled:true,publicFiles:Object.keys(files).sort(),prebidUnchanged:true};
put('build.json',encode(JSON.stringify(summary,null,2)+'\n'));
put('UPUTSTVO.txt',encode(`TANJUG — ${release} — CMP ispravka

Objavi CEO ZIP u isti Pages projekat, bez izmene HTML-a i GAM ključa Variant.
Prebid TCF modul je uvek uključen. Loader čeka do 8 s da se pojavi stvarni CMP API.
Ako se API ne pojavi, modul ostaje uključen: native Prebid obrađuje nedostajući
consent, a postojeći GAM fallback ostaje dostupan. Ne postavlja se lažni TC string
ili gdprApplies. Funding Choices ostaje izvor consent podataka.

Provera: pbjs.getConfig('consentManagement').gdpr.enabled treba da bude true.
AdConsent.snapshot() pokazuje da li je CMP API bio dostupan pri pokretanju.
Ako vidiš api-timeout, proveri CMP tag i učitaj stranicu ponovo nakon popravke.
A/B i dalje imaju istu logiku. Svih 19 pozicija i minifikacija su očuvani.
Prethodni paketi nisu prepisani. Za povratak koristi prethodni Pages deployment.
`));
console.log(JSON.stringify(summary));
