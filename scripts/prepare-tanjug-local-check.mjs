import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {prepareTanjugCacheReview} from '../worker/pilots/tanjug-cache-review.mjs';
import {buildOverrideKits} from './tanjug-local-override-kit.mjs';
const root=new URL('../',import.meta.url),read=path=>readFileSync(new URL(path,root));
const proposal=JSON.parse(read('worker/pilots/tanjug-cache-review-v1.json'));
const review=await prepareTanjugCacheReview({proposal,sourceBytes:read(proposal.sourceFile),prebidBytes:read('vendor/prebid/tanjug-11.34.0/prebid.js')});
const kits=await buildOverrideKits(review),out=new URL('.generated/tanjug-local-check/',root);mkdirSync(out,{recursive:true});
for(const [arm,kit] of Object.entries(kits)){
 writeFileSync(new URL(`tanjug-local-${arm}.zip`,out),kit.zip);
 writeFileSync(new URL(`${arm}-mapping.json`,out),JSON.stringify(kit.report,null,2)+'\n');
}
console.log('Prepared separate local override ZIPs. No browser execution, deployment or live traffic selection.');
