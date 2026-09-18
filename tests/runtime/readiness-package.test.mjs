import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {READINESS_RELEASE,instrumentObservedRuntime} from '../../worker/runtime-readiness/static-profile.mjs';
import {instrumentFullRuntime} from '../../worker/experiments/static-aa-v1.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
test('separate complete release preserves old A/A ZIP, all positions, dependency and identical arms',()=>{
 const zip=unzipSync(read('.generated/tanjug-readiness/'+READINESS_RELEASE+'.zip'));
 const manifest=JSON.parse(Buffer.from(zip['release.json'])),config=manifest.config;
 assert.equal(hash(read('.generated/tanjug-aa/tanjug-aa-1.0.0.zip')),manifest.previousArchiveSha256);
 assert.equal(manifest.previousArchiveSha256,'bb66d583573099f46795e9e3cd9f700a5fad1581cafa7a62212b041882319993');
 assert.equal(config.positions.length,19);assert.deepEqual(zip[config.arms.A.path],zip[config.arms.B.path]);
 assert.equal(hash(zip['prebid.js']),'384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b');
 for(const [name,item] of Object.entries(manifest.files))assert.equal(hash(zip[name]),item.sha256,name);
 assert.equal(manifest.diagnostics.mode,'observe-only');
});
test('observer instrumentation changes no existing auction, targeting, refresh or size code',()=>{
 const source=read('.generated/tanjug-pilot/ads.js').toString();
 const output=instrumentObservedRuntime(source,['P1']);
 const start=output.indexOf('            if(!window.AdBidReadiness){');
 const end=output.indexOf('            var newlyDefinedSlots = [];',start);
 assert(start>0&&end>start);
 assert.equal(output.slice(0,start)+output.slice(end),instrumentFullRuntime(source,READINESS_RELEASE));
});
