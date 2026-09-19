import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {parse} from 'acorn';
import {waitForCmpEntry,instrumentCmpRuntime} from '../../worker/experiments/cmp-aa-v1.mjs';
import {sha256,verifyStaticAAPackage} from '../../scripts/static-aa-package.mjs';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url));
test('new minified release preserves prior archives and complete native dependency',()=>{
 assert.equal(sha256(read('.generated/tanjug-aa/tanjug-aa-1.0.0.zip')),'bb66d583573099f46795e9e3cd9f700a5fad1581cafa7a62212b041882319993');
 assert.equal(sha256(read('.generated/tanjug-compact/tanjug-aa-1.0.1.zip')),'73380e0980801a628f44f9218d31d75137511516aac80ba0c39bb0bc14840895');
 const m=JSON.parse(read('.generated/tanjug-cmp/release.json')),f=unzipSync(read('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip'));
 verifyStaticAAPackage(m,f);assert.equal(m.config.positions.length,19);
 assert.equal(sha256(f['prebid.js']),'384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b');
 for(const p of ['ads.js',m.config.arms.A.path,m.config.arms.B.path]){const comments=[];parse(Buffer.from(f[p]).toString(),{ecmaVersion:'latest',onComment:comments});assert.equal(comments.length,0);}
 const source=instrumentCmpRuntime(read('.generated/tanjug-pilot/ads.js').toString());
 assert(source.includes('var gdprConsentConfig = {\n                enabled: true,'));
 assert(!source.includes('hasTcfCmp'));assert(source.includes('defaultGdprScope: true'));
});
function fixture(){
 let now=0,started=0;const callbacks=[],win={};
 const context=vm.createContext({Date:{now:()=>now},setTimeout:cb=>{callbacks.push(cb);return callbacks.length;},clearTimeout(){},win,start:()=>started++});
 const run=()=>vm.runInContext('('+waitForCmpEntry.toString()+')(start,win)',context);
 return {win,run,started:()=>started,tick:ms=>{now+=ms;callbacks.shift()?.();}};
}
test('late API is discovered before starting, duplicate pending loaders do not start twice',()=>{
 const f=fixture();f.run();f.run();assert.equal(f.started(),0);f.tick(1500);assert.equal(f.started(),0);
 f.win.__tcfapi=()=>{};f.tick(50);assert.equal(f.started(),1);assert.equal(f.win.AdConsent.snapshot().status,'available');
});
test('missing API times out with explicit diagnostic, without manufacturing CMP or consent',()=>{
 const f=fixture();f.run();f.tick(8000);assert.equal(f.started(),1);assert.equal(f.win.AdConsent.snapshot().status,'api-timeout');
 assert.equal(f.win.__tcfapi,undefined);
});
test('already present API starts immediately',()=>{
 const f=fixture();f.win.__tcfapi=()=>{};f.run();assert.equal(f.started(),1);assert.equal(f.win.AdConsent.snapshot().waitedMs,0);
});
