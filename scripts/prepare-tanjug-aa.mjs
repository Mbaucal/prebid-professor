import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {minify} from 'terser';
import {zipSync,unzipSync} from 'fflate';
import {AA_RELEASE,instrumentFullRuntime,staticAALoader} from '../worker/experiments/static-aa-v1.mjs';

const root=new URL('../',import.meta.url),out=new URL('.generated/tanjug-aa/',root);
const read=p=>readFileSync(new URL(p,root)),hash=b=>createHash('sha256').update(b).digest('hex');
const encode=s=>Buffer.from(s),sri=b=>'sha256-'+createHash('sha256').update(b).digest('base64');
const pilot=JSON.parse(read('worker/pilots/tanjug-v1.json'));
const base=read('.generated/tanjug-pilot/ads.js'),baseMin=read('.generated/tanjug-pilot/ads.min.js');
assert.equal(hash(base),'0faec2eccdcedbd29153357c7a94c879cdec4a8d037b16593a94a7884f242e2b');
assert.equal(hash(baseMin),'62fc33c7ece330d87cc3e684b7f3eba5009e36d74e43cc426b636eb956a6d2c4');
const prebid=read('vendor/prebid/tanjug-11.34.0/prebid.js');assert.equal(hash(prebid),pilot.prebid.sha256);
const positions=pilot.snapshot.units.filter(u=>u.enabled).map(u=>u.code);assert.equal(positions.length,19);
assert(base.includes('useBidCache: false'));assert(base.includes('"fluid"'));assert(base.includes('[ 1, 1 ]'));
const arm=encode((await minify(instrumentFullRuntime(base.toString()),{ecma:2020,compress:true,mangle:true,format:{comments:false}})).code+'\n');
const folder='releases/'+AA_RELEASE+'-'+hash(arm).slice(0,16)+'/';
const config={release:AA_RELEASE,baseRuntime:pilot.runtimeVersion,positions,
 armSha256:hash(arm),prebidVersion:pilot.prebid.version,prebidPath:folder+'prebid.js',prebidIntegrity:sri(prebid),
 arms:{A:{path:folder+'A.js',integrity:sri(arm)},B:{path:folder+'B.js',integrity:sri(arm)}}};
const headers=`/ads.js
  Cache-Control: no-store
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
/prebid.js
  Cache-Control: no-store
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
/releases/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
`;
const guide=`TANJUG — A/A 1.0.0 — kompletan paket za Cloudflare Pages

Sadrži svih 19 pozicija iz pune Tanjug postavke. A i B imaju identičan kod i
podešavanja; jedina eksperimentalna razlika je GAM ključ Variant sa vrednošću A ili B.
Raspodela je nasumično 50/50 po otvaranju stranice, u browseru. Cloudflare isporučuje
isti mali ads.js loader svima; CDN cache ne može da dodeli istu varijantu svima.
Nema kolačića za raspodelu. Varijanta ostaje ista tokom refresh-a oglasa i BFCache-a;
novo otvaranje stranice bira ponovo. 50/50 ne znači naizmenično A pa B.

OBJAVA
1. Isključi Chrome Local Overrides za Tanjug pre provere produkcije.
2. Objavi ceo sadržaj tanjug-aa-1.0.0.zip kao novi production deployment postojećeg
   Pages projekta tanjug. ads.js i prebid.js moraju biti direktno u korenu projekta,
   uz ceo folder releases i _headers. Ne objavljuj samo dva glavna fajla.
3. Postojeći HTML sa https://tanjug.pages.dev/ads.js i /prebid.js ostaje važeći.
   Ne dodaj A.js ili B.js u HTML. Ako postoji samo ads.js tag, loader sam učitava Prebid.
4. U GAM: Inventory → Key-values: ključ Variant, vrednosti A i B. Uključi ih za
   izveštavanje ako želiš poređenje u izveštajima. Nema potrebe menjati line iteme.
   Pojavljivanje ključa u Publisher Console proverava se nezavisno od report podešavanja.

PROVERA
Otvori Tanjug bez Overrides i u Console unesi:
  AdVariant.inspect()
Očekuj release=tanjug-aa-1.0.0, Variant=A ili B, status=loaded,
runtimeEntries=1, Prebid=11.34.0, mode=fresh-only. Druga tabela pokazuje
Variant na stvarno definisanim pozicijama te stranice. Svih 19 pozicija je u
konfiguraciji, a kreiraju se one za koje postoji odgovarajući div i uslovi prikaza.
Google Publisher Console → Ad Slots → pozicija → Targeting info → Variant.
Network pokazuje samo A.js ili samo B.js; ads.js je loader, ne druga aukcija.
Pogledaj više novih otvaranja za obe oznake. Ovaj paket nema ručno forsiranje varijante.
Ako ima greške, inspect prikazuje konkretan razlog; nema automatskog pokretanja druge
varijante koje bi moglo da duplira aukciju. Ne ubacuj dodatni ads.js kroz konzolu.

POVRATAK
Cloudflare Pages → tanjug → Deployments → izaberi prethodni ispravan PRODUCTION
deployment → Rollback to this deployment. Sačekaj objavu i osveži stranicu.
Izaberi raniji kompletan deployment, ne onaj sa samo Billboard + Sticky.
Otvoreni tab zadržava već pokrenuti kod do ponovnog učitavanja.
Poseban tanjug-aa-1.0.0-stop.zip isključuje A/A i vraća punu osnovnu skriptu
sa Prebid 11.34.0 iz ovog paketa. To nije identična kopija starog CDN Prebid 10.10.0.

OSNOVA I OBIM
Puna pinovana Tanjug konfiguracija od 14. septembra, osnovni ads.js hash
62fc33c7ece330d87cc3e684b7f3eba5009e36d74e43cc426b636eb956a6d2c4.
Nova isporuka A/A 1.0.0 koristi dve identične kopije sa dodatim oznakama i kontrolom
jednog pokretanja. Postojeći sačuvani runtime-i i njihovi paketi nisu prepisani.
Prebid 11.34.0 je uključen za obe strane. Keš je isključen, nema novih geo/CMP pravila.
Funding Choices, bidder parametri, floors, lazy i refresh su iz pune osnovne postavke.
TakeOver ostaje isključen. Ovo je Tanjug paket, sa Tanjug GAM putanjama i bidder ID-jevima.
Prvi test proverava isporuku i oznake, ne dokazuje razliku u zaradi ili korist keširanja.
Realni prihodi i Funding Choices/GPT na produkciji potvrđuju se posle objave.

UPUTSTVA
https://developers.cloudflare.com/pages/get-started/direct-upload/
https://developers.cloudflare.com/pages/configuration/rollbacks/
https://developers.google.com/publisher-tag/guides/publisher-console
https://support.google.com/admanager/answer/9796369
`;
const files={'ads.js':encode(staticAALoader(config)),'prebid.js':prebid,
 [config.arms.A.path]:arm,[config.arms.B.path]:arm,[config.prebidPath]:prebid,
 '_headers':encode(headers),'404.html':encode('<!doctype html><title>Not found</title>Not found'),
 'UPUTSTVO.txt':encode(guide)};
for(const name of ['sticky.css','min-height.css'])files[name]=read('.generated/tanjug-pilot/'+name);
const manifest={release:AA_RELEASE,kind:'static-production-aa',allocation:'50/50 per document',key:'Variant',values:['A','B'],
 config,baseAdsSha256:hash(baseMin),baseReadableSha256:hash(base),prebidSha256:hash(prebid),
 sourceConfigurationSha256:hash(read('worker/pilots/tanjug-v1.json')),
 files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,{sha256:hash(b),bytes:b.length}]))};
files['release.json']=encode(JSON.stringify(manifest,null,2)+'\n');
mkdirSync(out,{recursive:true});
function archive(name,entries){
 const zip=zipSync(Object.fromEntries(Object.entries(entries).map(([p,b])=>[p,[b,{level:6,mtime:new Date(1980,0,1,0,0,0)}]])));
 const back=unzipSync(zip);assert.deepEqual(Object.keys(back).sort(),Object.keys(entries).sort());
 for(const [p,b] of Object.entries(entries))assert.deepEqual(Buffer.from(back[p]),b);
 writeFileSync(new URL(name,out),zip);return {name,sha256:hash(zip),bytes:zip.length};
}
for(const [name,bytes] of Object.entries(files)){const p=new URL('deploy/'+name,out);mkdirSync(new URL('.',p),{recursive:true});writeFileSync(p,bytes);}
const production=archive(AA_RELEASE+'.zip',files);
const stopFiles={'ads.js':baseMin,'prebid.js':prebid,'_headers':encode(headers),'404.html':files['404.html'],
 'UPUTSTVO.txt':encode('Objava ovog CELOG ZIP-a isključuje A/A za nova otvaranja. Puna Tanjug skripta, 19 pozicija, Prebid 11.34.0.\nZa identičan prethodni deployment koristi Cloudflare Rollback.\n')};
const stop=archive(AA_RELEASE+'-stop.zip',stopFiles);
writeFileSync(new URL('build.json',out),JSON.stringify({production,stop,config},null,2)+'\n');
console.log(JSON.stringify({production,stop,positions:positions.length,identicalArms:hash(files[config.arms.A.path])===hash(files[config.arms.B.path]),armSha256:hash(arm)}));
