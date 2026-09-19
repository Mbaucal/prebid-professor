import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {minify} from 'terser';
import {zipSync,unzipSync} from 'fflate';
import {READINESS_RELEASE,instrumentObservedRuntime,observedLoader} from '../worker/runtime-readiness/static-profile.mjs';

const read=p=>readFileSync(new URL('../'+p,import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
const encode=s=>Buffer.from(s),sri=b=>'sha256-'+createHash('sha256').update(b).digest('base64');
const oldArchive=read('.generated/tanjug-aa/tanjug-aa-1.0.0.zip');
assert.equal(hash(oldArchive),'bb66d583573099f46795e9e3cd9f700a5fad1581cafa7a62212b041882319993','Existing A/A release changed');
const oldFiles=unzipSync(oldArchive),oldManifest=JSON.parse(Buffer.from(oldFiles['release.json']));
const base=read('.generated/tanjug-pilot/ads.js');assert.equal(hash(base),oldManifest.baseReadableSha256);
const arm=encode((await minify(instrumentObservedRuntime(base.toString(),oldManifest.config.positions),{
  ecma:2020,compress:true,mangle:true,format:{comments:false}})).code+'\n');
const folder='releases/'+READINESS_RELEASE+'-'+hash(arm).slice(0,16)+'/';
const config={...oldManifest.config,release:READINESS_RELEASE,armSha256:hash(arm),
  prebidPath:folder+'prebid.js',arms:{A:{path:folder+'A.js',integrity:sri(arm)},B:{path:folder+'B.js',integrity:sri(arm)}}};
const files={};
for(const name of ['prebid.js','sticky.css','min-height.css','_headers','404.html'])files[name]=Buffer.from(oldFiles[name]);
files['ads.js']=encode(observedLoader(config));
files[config.prebidPath]=files['prebid.js'];files[config.arms.A.path]=arm;files[config.arms.B.path]=arm;
files['UPUTSTVO.txt']=encode(`TANJUG — ${READINESS_RELEASE}

Nova, zasebna dijagnostička verzija pune A/A skripte, svih 19 pozicija.
Postojeći A/A 1.0.0 paket i aktivni test nisu menjani. Ovaj paket nije automatski objavljen.
Pripremljen je za narednu proveru nakon pregleda sadašnjeg A/A izveštaja.

Obe varijante imaju identičan kod. Native Prebid 11.34.0, raspodela i Variant ostaju isti.
Keširanje je i dalje isključeno. Aukcije, refresh intervali, CMP, bidder parametri,
floors i responsive/fluid/1x1 pozicije ostaju iz pune osnovne postavke.

Console: AdVariant.inspect() — isporuka plus tabela bidova.
Console: AdBidReadiness.inspect() — samo bidovi po poziciji.
Console: AdBidReadiness.snapshot() — strukturiran lokalni rezultat.

candidates = ponude koje su prošle lokalne provere, NE garantovani oglasi niti
potvrda da bi ih native targeting/GAM izabrao. Kada je cacheEnabled=false,
ovaj broj sam ne uključuje njihovu ponovnu upotrebu. Nema preuzimanja ili
probnog renderovanja kreative, dodatne aukcije niti slanja dijagnostike serveru.

Provere: ista pozicija/veličina/consent kontekst, završen posmatrani auction,
status i prethodno slanje GAM-u (uključujući dodatne deal bidove), valuta/floor,
render podaci i preostali TTL. Dijagnostički limit starosti je 60 s, uz native
TTL buffer i dodatni budžet od 2 s za isporuku; to nije produženje važenja ponude.
Vidljivi su razlozi odbacivanja, slanje GAM-u, bidWon i Prebid render događaji.
RenderSucceeded nije potvrda naplate niti svih učitanih resursa.
Podaci su ograničeni na ovu stranicu: do 2048 bidova/128 aukcija; dostignut limit
prikazuje capacityReached i prestaje da potvrđuje kandidate.
Direktna/AdX klasifikacija i promenljivi refresh nisu uključeni u ovu verziju.

Kada se izabere objava, objavljuje se CEO ZIP u postojeći Cloudflare Pages projekat,
sa ads.js/prebid.js u korenu i folderom releases. HTML adrese ostaju iste.
Za povratak odabrati prethodni kompletan production deployment u Cloudflare Pages.
Otvoreni tab zadržava svoju verziju do ponovnog učitavanja.
`);
const sourcePaths=['worker/runtime-readiness/observer.mjs','worker/runtime-readiness/static-profile.mjs',
  'worker/experiments/static-aa-v1.mjs','worker/runtime-cache/consent-epoch.mjs','scripts/prepare-tanjug-readiness.mjs'];
const manifest={release:READINESS_RELEASE,kind:'static-aa-readiness-observer',config,
  baseRuntime:oldManifest.config.baseRuntime,baseReadableSha256:hash(base),baseAdsSha256:oldManifest.baseAdsSha256,
  previousArchiveSha256:hash(oldArchive),prebidSha256:hash(files['prebid.js']),
  diagnostics:{mode:'observe-only',maxAgeSeconds:60,renderBudgetSeconds:2,nativeSelectionVerified:false},
  sourceFiles:Object.fromEntries(sourcePaths.map(p=>[p,hash(read(p))])),
  files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,{sha256:hash(b),bytes:b.length}]))};
files['release.json']=encode(JSON.stringify(manifest,null,2)+'\n');
const out=new URL('../.generated/tanjug-readiness/',import.meta.url);mkdirSync(out,{recursive:true});
for(const [path,bytes] of Object.entries(files)){const p=new URL('deploy/'+path,out);mkdirSync(new URL('.',p),{recursive:true});writeFileSync(p,bytes);}
const zip=zipSync(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,[b,{level:6,mtime:new Date(1980,0,1,0,0,0)}]])));
const back=unzipSync(zip);for(const [p,b] of Object.entries(files))assert.deepEqual(Buffer.from(back[p]),b);
writeFileSync(new URL(READINESS_RELEASE+'.zip',out),zip);
const result={release:READINESS_RELEASE,sha256:hash(zip),bytes:zip.length,positions:config.positions.length,config};
writeFileSync(new URL('build.json',out),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
