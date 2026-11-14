import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const outputs=['site-ab-baseline.mjs','tanjug-pilot/ads.js','tanjug-aa/tanjug-aa-1.0.0.zip',
  'tanjug-compact/tanjug-aa-1.0.1.zip','tanjug-cmp/tanjug-aa-1.0.2.zip'];

test('named baseline preparation ignores caller cwd and preserves the reviewed root outputs',()=>{
  // CI first runs the real connected-build preparation from ops/runtime-test.
  const before=outputs.map(path=>readFileSync(join(root,'.generated',path)));
  assert.equal(existsSync(join(root,'ops/runtime-test/.generated')),false,'No generated assets under the deployment directory');
  const directory=mkdtempSync(join(tmpdir(),'tessera-build-cwd-'));
  try{
    // A wrong relative read must fail even if the caller happens to have files.
    const decoy=join(directory,'.generated/tanjug-pilot/ads.js');
    mkdirSync(join(directory,'.generated/tanjug-pilot'),{recursive:true});
    writeFileSync(decoy,'foreign-cwd sentinel; never a runtime input');
    const result=spawnSync(process.execPath,[join(root,'scripts/prepare-site-ab-baseline.mjs')],{cwd:directory,encoding:'utf8',maxBuffer:8*1024*1024});
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stderr);
    outputs.forEach((path,index)=>assert.deepEqual(readFileSync(join(root,'.generated',path)),before[index],path+' must stay byte-identical'));
    assert.deepEqual(readdirSync(directory),['.generated']);
    assert.deepEqual(readdirSync(join(directory,'.generated')),['tanjug-pilot'],'No output written relative to caller');
    assert.deepEqual(readdirSync(join(directory,'.generated/tanjug-pilot')),['ads.js']);
    assert.equal(readFileSync(decoy,'utf8'),'foreign-cwd sentinel; never a runtime input');
    assert.equal(existsSync(join(root,'ops/runtime-test/.generated')),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
