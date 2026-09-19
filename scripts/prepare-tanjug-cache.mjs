import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {minify} from 'terser';
import {zipSync,unzipSync} from 'fflate';
import {CACHE_RELEASE,cacheArm,fullCacheLoader} from '../worker/experiments/full-cache-v1.mjs';
import {sha256,integrity} from './static-aa-package.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url));
const previous=read('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip');
assert.equal(sha256(previous),'bd0d9a6973903a3ec585f88e4b815eefb7a061ec8a32593f671b53ce211dfb1e');
const prior=JSON.parse(read('.generated/tanjug-cmp/release.json')),old=unzipSync(previous);
const base=read('.generated/tanjug-pilot/ads.js');assert.equal(sha256(base),prior.baseReadableSha256);
const compact=async source=>Buffer.from((await minify(source,{ecma:2020,compress:true,mangle:true,sourceMap:false,format:{comments:false}})).code+'\n');
const arms={A:await compact(cacheArm(base.toString(),'A')),B:await compact(cacheArm(base.toString(),'B'))};
const folder='releases/'+CACHE_RELEASE+'-'+sha256(Buffer.concat([arms.A,arms.B])).slice(0,16)+'/';
const config={...prior.config,release:CACHE_RELEASE,prebidPath:folder+'prebid.js',arms:{}};
delete config.armSha256;
for(const [variant,bytes] of Object.entries(arms))config.arms[variant]={path:folder+variant+'.js',sha256:sha256(bytes),integrity:integrity(bytes)};
const files={};for(const name of ['prebid.js','sticky.css','min-height.css','_headers','404.html'])files[name]=old[name];
files['ads.js']=await compact(fullCacheLoader(config));
files[config.prebidPath]=files['prebid.js'];
for(const [v,b] of Object.entries(arms))files[config.arms[v].path]=b;
const manifest={schemaVersion:1,kind:'static-production-ab-cache',release:CACHE_RELEASE,config,key:'Variant',values:['A','B'],
  allocation:'50/50 per document',previousArchiveSha256:sha256(previous),baseReadableSha256:sha256(base),
  modes:{A:'fresh-only',B:'auction-with-cache'},maxAgeSeconds:60,refreshChanged:false,
  files:Object.fromEntries(Object.keys(files).sort().map(n=>[n,{bytes:files[n].length,sha256:sha256(files[n])}]))};
const archive=zipSync(Object.fromEntries(Object.keys(files).sort().map(n=>[n,[files[n],{level:6,mtime:new Date(1980,0,1)}]])),{level:6});
const unpacked=unzipSync(archive);assert.deepEqual(Object.keys(unpacked).sort(),Object.keys(files).sort());
for(const [n,e] of Object.entries(manifest.files))assert.equal(sha256(unpacked[n]),e.sha256);
const out=new URL('../.generated/tanjug-cache/',import.meta.url);
function put(path,bytes){const target=new URL(path,out);mkdirSync(new URL('.',target),{recursive:true});if(existsSync(target))assert.deepEqual(readFileSync(target),Buffer.from(bytes),'Existing new release differs: '+path);else writeFileSync(target,bytes,{flag:'wx'});}
put(CACHE_RELEASE+'.zip',archive);put('release.json',JSON.stringify(manifest,null,2)+'\n');
for(const [n,b] of Object.entries(unpacked))put('deploy/'+n,b);
const summary={release:CACHE_RELEASE,sha256:sha256(archive),bytes:archive.length,positions:config.positions.length,...{modes:manifest.modes,maxAgeSeconds:60,refreshChanged:false}};
put('build.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
