import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {parse} from 'acorn';
import {cacheArm,CACHE_RELEASE} from '../../worker/experiments/full-cache-v2.mjs';
import {instrumentCmpRuntime,CMP_RELEASE} from '../../worker/experiments/cmp-aa-v1.mjs';
import {sha256,integrity} from '../../scripts/static-aa-package.mjs';
const read=p=>readFileSync(p);
test('control keeps the accepted CMP runtime and all previous release bytes',()=>{
 const base=read('.generated/tanjug-pilot/ads.js').toString();
 assert.equal(cacheArm(base,'A'),instrumentCmpRuntime(base).replaceAll(CMP_RELEASE,CACHE_RELEASE));
 assert.equal(sha256(read('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip')),'bd0d9a6973903a3ec585f88e4b815eefb7a061ec8a32593f671b53ce211dfb1e');
 const b=cacheArm(base,'B');assert.match(b,/mode:'auction-with-cache',maxAgeSeconds:60/);
 // Timer configuration is unchanged even though auction selection is different.
 const timers=s=>[...s.matchAll(/var ([A-Z_]*(?:REFRESH|DWELL)[A-Z_]*) = ([^;]*);/g)].map(m=>[m[1],m[2]]);
 assert.deepEqual(timers(b),timers(base));
});
test('complete cache archive contains only public files and pins both different arms',()=>{
 const m=JSON.parse(read('.generated/tanjug-cache-fixed/release.json'));
 const f=unzipSync(read('.generated/tanjug-cache-fixed/'+CACHE_RELEASE+'.zip'));
 assert.equal(Object.keys(f).length,9);assert.deepEqual(Object.keys(f).sort(),Object.keys(m.files).sort());
 assert.equal(m.config.positions.length,19);assert.equal(new Set(m.config.positions).size,19);
 assert.notEqual(m.config.arms.A.sha256,m.config.arms.B.sha256);
 assert.equal(sha256(f['prebid.js']),'384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b');
 for(const [n,e] of Object.entries(m.files)){assert.equal(f[n].length,e.bytes);assert.equal(sha256(f[n]),e.sha256);}
 for(const p of ['ads.js',m.config.arms.A.path,m.config.arms.B.path]){
  const comments=[];parse(Buffer.from(f[p]).toString(),{ecmaVersion:'latest',onComment:comments});assert.equal(comments.length,0);
 }
 for(const v of ['A','B'])assert.equal(integrity(f[m.config.arms[v].path]),m.config.arms[v].integrity);
 assert.deepEqual(f[m.config.prebidPath],f['prebid.js']);
});
