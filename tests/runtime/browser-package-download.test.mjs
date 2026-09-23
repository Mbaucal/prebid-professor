import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {downloadStoredPackage} from '../../src/download/saved-package.mjs';
import {sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
for(const reporting of [false,true])test(`browser assembles exact saved files including an 8 MiB Prebid (reporting=${reporting}), and rejects corruption before download`,async()=>{
 const names=['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','manifest.json','min-height.css','sticky.css','prebid.js',...(reporting?['gam-reporting.json']:[])].sort();
 const bytes=Object.fromEntries(names.map(n=>[n,n==='prebid.js'?new Uint8Array(8*1024*1024).fill(37):new TextEncoder().encode(n)]));
 const inventory=[];for(const name of names)inventory.push({name,byteSize:bytes[name].length,sha256:await sha256(bytes[name])});
 const siteId='test-site',id='builtin-draft-'+await sha256(new TextEncoder().encode(JSON.stringify({siteId,inventory})));
 const original={fetch:globalThis.fetch,document:globalThis.document,create:URL.createObjectURL,revoke:URL.revokeObjectURL,timeout:globalThis.setTimeout};
 let blob,clicked=0,corrupt=false;
 globalThis.fetch=async url=>url.endsWith('/index')?Response.json({descriptor:{releaseId:id,siteId,files:inventory}}):new Response(corrupt?new Uint8Array([0]):bytes[url.split('/').pop()]);
 globalThis.document={body:{append(){}},createElement(){return {click(){clicked++},remove(){}}}};
 URL.createObjectURL=value=>{blob=value;return 'blob:local'};URL.revokeObjectURL=()=>{};globalThis.setTimeout=fn=>{fn();return 0};
 try{await downloadStoredPackage(id);assert.equal(clicked,1);const zip=unzipSync(new Uint8Array(await blob.arrayBuffer()));for(const name of names)assert.deepEqual(zip[name],bytes[name]);corrupt=true;await assert.rejects(downloadStoredPackage(id),/checksum/);assert.equal(clicked,1);}
 finally{globalThis.fetch=original.fetch;globalThis.document=original.document;URL.createObjectURL=original.create;URL.revokeObjectURL=original.revoke;globalThis.setTimeout=original.timeout;}
});
