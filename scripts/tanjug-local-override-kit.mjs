import {zipSync} from 'fflate';
import {describeCandidate} from '../worker/runtime/draft-release-store.mjs';
import {LIVE_SCRIPTS,hash} from './capture-tanjug-live-baseline.mjs';
const encode=text=>new TextEncoder().encode(text);
const requireThat=(ok,message)=>{if(!ok)throw Error(message);};
const zip=files=>zipSync(Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,[bytes,{level:0,mtime:new Date(1980,0,1,0,0,0)}]])),{level:0});

/** Packages response replacements for a developer's local browser only.
 * Never a proxy, extension, public loader or automatic traffic switch. */
export async function buildOverrideKits(review){
 review=structuredClone(review);
 const result={};
 for(const arm of ['control','cache']){
  const candidate=review.candidates[arm],{descriptor}=await describeCandidate('tanjug-cache-test',candidate);
  requireThat(descriptor.packageSha256===review.report.arms[arm].packageSha256,'Candidate identity changed');
  requireThat(hash(candidate.zip)===review.report.arms[arm].zipSha256,'Candidate archive changed');
  const mappings=Object.entries(LIVE_SCRIPTS).map(([name,url])=>{
   const sourceFile=name==='ads.js'?'ads.min.js':name,bytes=candidate.files[sourceFile];
   requireThat(bytes instanceof Uint8Array&&bytes.length>0,'Missing candidate script');
   return {url,path:'overrides/tanjug.pages.dev/'+name,sourceFile,byteSize:bytes.length,sha256:hash(bytes)};
  });
  const report={schemaVersion:1,arm,packageSha256:descriptor.packageSha256,sourceZipSha256:hash(candidate.zip),mappings,
   scope:'One operator browser profile; overrides persist until disabled. Not automatically single-use.',
   positions:['Billboard','Sticky'],omittedPositions:review.report.scope.excludedUnits,
   readiness:'prepared-not-executed',liveBaselineRequired:true,automaticRollback:false,
   unchanged:['Existing CMP and GPT responses','Publisher HTML','Response security headers','All archived runtime and package bytes'],
   remaining:['Capture current live script bytes and check source loading order.','Verify both response overrides before assessing runtime behavior.','Use one arm at a time and reload between arms.','Disable Local Overrides and reload to return to current CDN delivery.']};
  const files=Object.fromEntries(mappings.map(m=>[m.path,candidate.files[m.sourceFile]]));
  files['mapping.json']=encode(JSON.stringify(report,null,2)+'\n');
  files['README.md']=encode(`# Tanjug local check — ${arm}\n\nThese are local response overrides for one operator browser, not a deployment. The live page can make real ad requests during this check. Only Billboard and Sticky are included; other positions are absent in this local test.\n\n1. Use a dedicated Chrome profile with no other Tanjug tabs. Capture the current live files and inspect the initial script tags/loading order first.\n2. Extract this ZIP. In DevTools, Sources > Overrides, select its overrides folder. Map exactly the two URLs in mapping.json; do not select the parent folder or combine both arms. Check the files before reloading.\n3. Keep original publisher HTML, Funding Choices, GPT and response security headers. Do not paste another wrapper in the console, override CSP/CORS, or disable integrity checks. If either mapping does not apply, disable overrides and stop.\n4. Reload the live page with DevTools open. Network must mark both mapped responses as overridden; verify their content against mapping.json. Check only the intended runtime is running, the expected Prebid is loaded, CMP signals, GPT rendering, Sticky/refresh and the existing Tessera inspector. A script tag or iframe alone does not prove successful initialization, consent or a filled impression.\n5. End this local check by clearing Enable Local Overrides, then reload. Confirm the two response overrides are gone and the page uses current CDN files again. Closing a tab alone does not remove saved override rules. A/B Stop is not this rollback.\n\nOverrides persist across reloads and disable browser cache, so this is a functional check, not a speed or revenue benchmark. To test another arm, first disable the current folder, select the other arm's folder and reload; never run both wrappers on one page. Actual CMP/auction behavior has not been verified for this kit.\n\nOfficial setup and disable instructions: https://developer.chrome.com/docs/devtools/overrides\n`);
  result[arm]={files,report,zip:zip(files)};
 }
 return result;
}
