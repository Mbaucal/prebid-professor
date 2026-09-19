import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import vm from 'node:vm';

test('compiled LOCAL Worker serves A/A and Stop with no external calls or production bindings',async()=>{
  const compiled=await build({entryPoints:['tests/support/experiment-worker.mjs'],bundle:true,
    write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  for(const [enabled,percentage,expected] of [['true','0','A'],['true','100','B'],['false','100','A']]) {
    let outbound=0;
    const worker=new Miniflare({name:'local-experiment-aa',modules:true,script:compiled.outputFiles[0].text,
      compatibilityDate:'2025-09-01',host:'127.0.0.1',port:0,cf:false,
      bindings:{LOCAL_EXPERIMENT_FIXTURE:'true',EXPERIMENT_ENABLED:enabled,EXPERIMENT_TEST_PERCENT:percentage},
      outboundService:()=>{outbound++;throw Error('External traffic is forbidden');}});
    try {
      const response=await worker.dispatchFetch('https://experiment.invalid/ads.js');
      assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
      const scripts=[];
      const page=vm.createContext({URL,window:{},document:{currentScript:{src:'https://experiment.invalid/ads.js'},
        createElement:()=>({}),head:{appendChild:s=>scripts.push(s)}}});
      const source=await response.text();vm.runInContext(source,page);vm.runInContext(source,page);
      assert.equal(scripts.length,1);
      assert.equal(page.window.__tesseraExperiments['tanjug-test'].context.variant,expected);
      const asset=await worker.dispatchFetch(scripts[0].src);
      assert.equal(asset.status,200);assert.match(asset.headers.get('cache-control'),/immutable/);
      vm.runInContext(await asset.text(),page);
      assert.equal(page.window.fixtureExecutions,1);assert.equal(page.window.fixtureLabel,'same');
      for(const path of ['/config.json','/ads.js?variant=B','/prebid.js'])
        assert.equal((await worker.dispatchFetch('https://experiment.invalid'+path)).status,404);
      assert.equal((await worker.dispatchFetch('https://tanjug.rs/ads.js')).status,404);
      assert.equal((await worker.dispatchFetch('https://experiment.invalid/ads.js',{method:'POST'})).status,405);
      assert.equal(outbound,0);
    } finally { await worker.dispose(); }
  }
});
