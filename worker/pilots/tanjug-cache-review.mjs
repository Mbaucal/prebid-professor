// Offline preparation only. Neither Worker imports this module. No network,
// database, publisher mutation, activation or automatic scope reduction.
import {zipSync} from 'fflate';
import {runtimeDescriptor,buildArtifactCandidate} from '../runtime-cache/artifact-candidate.mjs';
import {previewInput,PREBID_SHA256} from '../runtime-cache/snapshot.mjs';
import {pinRuntime} from '../runtime/version-pin.mjs';
import {describeCandidate} from '../runtime/draft-release-store.mjs';
import {prebidRequirements,inspectPrebidArtifact,parsePrebidHeader,sha256} from '../runtime/prebid-artifact-check.mjs';
const decode=bytes=>new TextDecoder().decode(bytes);
const requireThat=(ok,message)=>{if(!ok)throw Error(message);};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function unsupportedMaps(snapshot){
 return snapshot.maps.flatMap(map=>{
  const rows=JSON.parse(map.map_json).flatMap(row=>{
   const sizes=row.sizes.filter(size=>!Array.isArray(size)||size.some(n=>n<2));
   return sizes.length?[{viewport:row.viewport,sizes}]:[];
  });
  return rows.length?[{map:map.name,units:snapshot.units.filter(u=>u.enabled===1&&u.size_map_key===map.name).map(u=>u.code),rows}]:[];
 });
}

export async function prepareTanjugCacheReview({proposal,sourceBytes,prebidBytes}){
 // Freeze inputs before asynchronous checks; a caller cannot change the source
 // identity or selected scope while hashes are being verified.
 proposal=structuredClone(proposal);sourceBytes=new Uint8Array(sourceBytes);prebidBytes=new Uint8Array(prebidBytes);
 requireThat(await sha256(sourceBytes)===proposal.sourceSha256,'The frozen Tanjug source changed; prepare a new reviewed proposal.');
 const source=JSON.parse(decode(sourceBytes)),pin=pinRuntime(runtimeDescriptor,{allowPreview:true});
 requireThat(proposal.runtimeVersion===pin.runtimeVersion&&proposal.runtimeSha256===pin.runtimeSha256,'The proposal runtime pin changed.');
 requireThat(proposal.version==='tanjug-cache-review-v1'&&proposal.siteId==='tanjug-cache-test','Unknown pilot proposal.');
 requireThat(JSON.stringify(proposal.includedUnits)==='["Billboard","Sticky"]','The pilot scope requires its own explicit review.');
 requireThat(proposal.modes.control==='fresh-only'&&proposal.modes.cache==='auction-with-cache'&&proposal.maxAgeSeconds===60&&proposal.takeOver?.enabled===false,'The reviewed cache rules or TakeOver choice changed.');
 requireThat(await sha256(prebidBytes)===source.prebid.sha256&&source.prebid.sha256===PREBID_SHA256&&prebidBytes.length===source.prebid.byteSize,'The reviewed Prebid bytes changed.');
 const header=parsePrebidHeader(decode(prebidBytes));
 requireThat(header.version===source.prebid.version&&JSON.stringify(header.modules)===JSON.stringify(source.prebid.modules),'The Prebid declarations changed.');
 const full=structuredClone(source.snapshot),fullConfig=JSON.parse(full.config.config_json);
 fullConfig.runtimeControls.bidCache={mode:'auction-with-cache',maxAgeSeconds:proposal.maxAgeSeconds};full.config.config_json=JSON.stringify(fullConfig);
 let fullError=null;try{previewInput(full,runtimeDescriptor,proposal.buildTimestamp,proposal.takeOver);}catch(error){fullError=error.message;}
 const blockers=unsupportedMaps(full);
 requireThat(blockers.length>0&&fullError==='The cache candidate supports concrete banner sizes only.','Re-review full-source compatibility instead of silently changing the pilot scope.');
 const base=structuredClone(source.snapshot),included=new Set(proposal.includedUnits);
 requireThat(base.units.filter(u=>included.has(u.code)&&u.enabled===1).length===included.size,'A proposed position is missing or disabled.');
 base.site={...base.site,id:proposal.siteId,name:proposal.siteName};
 base.units=base.units.filter(u=>included.has(u.code));
 const maps=new Set(base.units.map(u=>u.size_map_key));base.maps=base.maps.filter(m=>maps.has(m.name));
 base.rules=base.rules.filter(r=>r.rule_key.startsWith('__')||included.has(r.rule_key));
 base.overrides=base.overrides.filter(r=>r.scope_type!=='adunit'||included.has(r.scope_key));
 const candidates={},arms={},snapshots={};
 for(const [arm,mode] of Object.entries(proposal.modes)){
  const snapshot=structuredClone(base),config=JSON.parse(snapshot.config.config_json);
  config.runtimeControls.bidCache={mode,maxAgeSeconds:proposal.maxAgeSeconds};snapshot.config.config_json=JSON.stringify(config);snapshots[arm]=snapshot;
  const requirements=prebidRequirements(previewInput(snapshot,runtimeDescriptor,proposal.buildTimestamp,proposal.takeOver),config);
  const build={id:'tanjug-cache-reviewed-prebid',publisher_id:proposal.siteId,status:'current',version:header.version,modules_json:JSON.stringify(header.modules),file_key:`publishers/${proposal.siteId}/prebid-builds/tanjug-cache-reviewed-prebid/prebid.js`};
  const report=await inspectPrebidArtifact({siteId:proposal.siteId,builds:[build],requirements},{get:async key=>{
   requireThat(key===build.file_key,'Unexpected Prebid key.');return {size:prebidBytes.length,customMetadata:{sha256:PREBID_SHA256,version:header.version},arrayBuffer:async()=>prebidBytes.slice().buffer};
  }});
  requireThat(report.status==='checked','The proposed Prebid configuration did not validate.');
  const candidate=await buildArtifactCandidate({snapshot,pin,buildTimestamp:proposal.buildTimestamp,takeOver:proposal.takeOver,prebid:{report,bytes:prebidBytes.slice().buffer}});
  const {descriptor}=await describeCandidate(proposal.siteId,candidate);
  const zip=zipSync(Object.fromEntries(Object.entries(candidate.files).map(([name,bytes])=>[name,[bytes,{level:0,mtime:new Date(1980,0,1,0,0,0)}]])),{level:0});
  candidates[arm]={...candidate,zip};arms[arm]={mode,maxAgeSeconds:proposal.maxAgeSeconds,packageSha256:descriptor.packageSha256,zipSha256:await sha256(zip),files:descriptor.files};
 }
 // Verify the normalized public configurations differ in exactly one rule.
 const control=JSON.parse(decode(candidates.control.files['config.json'])),cached=JSON.parse(decode(candidates.cache.files['config.json']));
 control.bidCache.mode=cached.bidCache.mode;requireThat(JSON.stringify(control)===JSON.stringify(cached),'The arms differ beyond cache mode.');
 const experiment=(id,testPin)=>({profile:'experiment-preview-v1',siteId:proposal.siteId,experimentId:id,revision:1,enabled:false,trafficB:50,controlPackageSha256:arms.control.packageSha256,testPackageSha256:testPin});
 const result={version:proposal.version,status:'offline-review-only',source:{file:proposal.sourceFile,sha256:proposal.sourceSha256,version:source.version,liveConfigurationVerified:false},runtime:pin,prebidSha256:PREBID_SHA256,
  fullSource:{supported:false,reason:fullError,blockers},scope:{includedUnits:proposal.includedUnits,excludedUnits:source.snapshot.units.filter(u=>!included.has(u.code)).map(u=>u.code),includedMaps:[...maps],takeOver:false},
  unchanged:{gamPath:base.site.gam_path,bidders:base.bidders.map(b=>b.bidder),userSync:true,consent:true,floors:true,currency:true,schain:true,refresh:true},
  refresh:{global:control.core.globalRefresh,stickySeconds:control.options.sticky.refreshSeconds,maximumBidAgeSeconds:proposal.maxAgeSeconds,note:'Bidder TTL can be shorter. Offers aged 60 seconds or more are excluded; longer scheduled refresh intervals may have no reusable bids. No refresh interval was shortened.'},
  arms,plans:{aa:experiment('tanjug-cache-aa-review',arms.control.packageSha256),ab:experiment('tanjug-cache-ab-review',arms.cache.packageSha256)},
  blockersBeforeHostedPilot:['Marko selected live Tanjug for real testing on 18 September 2026; no separate test page is required. Inspect the active entry point and Google Funding Choices before a controlled live visit.','Capture the exact current live files and delivery route for rollback: this proposal uses the frozen 14 September TEST source, not verified current live settings.','Replace the original wrapper before it loads on a controlled visit; never run both wrappers together. Resolve the two-position scope before ordinary traffic, since this package omits 17 positions.','Prepare small-cohort eligibility separately from trafficB. Experiment Stop serves the new control package; rollback must restore the captured old live entry point for new loads.','Verify real CMP/GPT, actual BFCache return, long sessions and A/A reporting before any revenue comparison.'],
  limitations:['Both modes still call bidders; this is not cache-first.','Control is new 3.13.0 with reuse off, not the old live script.','The two-position result cannot establish whole-site revenue impact.','Full 19-position support remains blocked by fluid/1x1 InText sizes.','Both proposed experiments are disabled. Preparing files neither starts delivery nor writes hosted storage.']};
 return {report:result,candidates,snapshots};
}

export function cacheReviewHtml(report){
 const list=items=>items.map(value=>`<li>${escape(value)}</li>`).join('');
 return `<!doctype html><html lang="sr-Latn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Tanjug · predlog cache pilota</title><style>body{font:16px system-ui;line-height:1.6;margin:24px auto;padding:0 16px;max-width:900px;color:#202a3b}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #ccd2dc}code{overflow-wrap:anywhere}.note{background:#fff4df;padding:16px;border-radius:12px}a{color:#965000}</style></head><body><h1>Tanjug · predlog cache pilota</h1><p class="note">Pripremljeno za pregled. Nije objavljeno niti aktivirano. Ova stranica ne pokreće oglase.</p><p>Billboard i Sticky · ads.js 3.13.0 · Prebid 11.34.0 · TakeOver OFF.</p><table><tr><th>Varijanta</th><th>Ponašanje</th><th>Paket</th></tr><tr><td>A · kontrola</td><td>Nova aukcija, keš isključen</td><td><a href="${escape(report.version)}-control.zip">Preuzmi ZIP</a></td></tr><tr><td>B · keš</td><td>Nova aukcija + validni keširani bidovi, najviše 60 s</td><td><a href="${escape(report.version)}-cache.zip">Preuzmi ZIP</a></td></tr></table><p>Obe varijante zovu bidere i imaju iste ostale postavke. Kontrola je nova 3.13.0, a ne postojeća živa skripta. ZIP primeri ugradnje mogu pozivati stvarne oglase ako se naknadno posluže na sajtu.</p><h2>Zašto samo dve pozicije?</h2><p>Sačuvana mapa InText sadrži fluid i 1×1 veličine, koje 3.13.0 ne podržava. Originalna postavka ostaje netaknuta. Iz ovog predloga isključeno je ${report.scope.excludedUnits.length} pozicija:</p><p>${report.scope.excludedUnits.map(escape).join(', ')}</p><h2>Refresh i važnost ponude</h2><p>Zadržana su originalna pravila osvežavanja. Limit keša je 60 s, uz kraći bidder TTL gde postoji. Na dužim intervalima stare ponude mogu već isteći; intervali nisu skraćivani radi boljeg cache hit-a.</p><h2>Pre aktiviranja</h2><ul>${list(['Test je dogovoren na živom Tanjugu; posebna test stranica nije potrebna. Prvo proveriti njegov aktivni Google Funding Choices.','Uporediti sa aktuelnom Tanjug konfiguracijom; izvor je sačuvani TEST paket od 14. septembra.','Sačuvati tačne aktivne fajlove i pripremiti povratak na njih. Stop ovog testa vraća novu A varijantu, ne staru živu skriptu.','Prvo jedna kontrolisana poseta sa zamenom skripte pre učitavanja. Ne pokretati obe skripte zajedno. Pre šireg testa rešiti ostalih 17 pozicija.'])}</ul><p>Pripremljeni A/A i A/B planovi su isključeni. Za kasniji mali deo saobraćaja tek treba pripremiti izbor učesnika; raspodela 50/50 deli A i B unutar testa. Najpre A/A, zatim A/B i merenje. Nije potvrđena podrška za pravi CMP, stvarni BFCache povratak ili bolji prihod.</p><details><summary>Identitet pripreme</summary><p>Izvor: <code>${escape(report.source.sha256)}</code></p><p>Runtime: <code>${escape(report.runtime.runtimeSha256)}</code></p><p><a href="review.json">Preuzmi potpuni izveštaj</a></p></details></body></html>\n`;
}
