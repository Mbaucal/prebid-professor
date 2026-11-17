import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {instrumentFullRuntime} from '../../worker/experiments/static-aa-v1.mjs';
import {finalizeJavaScript} from '../../worker/runtime/artifact-minifier.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const integrity=bytes=>'sha256-'+createHash('sha256').update(bytes).digest('base64');
const encoder=new TextEncoder();
function once(source,from,to) {
  assert.equal(source.split(from).length,2,'Review canonical A/B fixture loader anchor: '+from);
  return source.replace(from,()=>to);
}
/**
 * QA-only delivery adapter. It reuses the canonical static assignment/SRI/owned
 * slot Variant implementation, with distinct newly generated arm bytes. It is
 * not a product A/B builder and does not alter any legacy saved-script profile.
 */
export async function runtime325ABFixture({arms,prebid,prebidVersion,positions,release,runtimeVersion='3.25.0'}) {
  const source=await readFile(new URL('../../worker/experiments/static-aa-v1.mjs',import.meta.url),'utf8');
  const declaration=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.find(node=>
    node.type==='ExportNamedDeclaration'&&node.declaration?.id?.name==='bootStaticAA')?.declaration;
  assert(declaration,'Missing canonical assignment loader');
  let boot=source.slice(declaration.start,declaration.end);
  // These diagnostic adaptations belong only to this new QA fixture profile.
  boot=once(boot,'scriptSha256:config.armSha256','scriptSha256:assigned?config.arms[assigned].sha256:null');
  boot=once(boot,"mode:'fresh-only',","mode:assigned?config.modes[assigned]:null,");
  const files={},config={release,baseRuntime:runtimeVersion,prebidVersion,positions,
    modes:{A:'fresh-only',B:'auction-with-cache'},arms:{},prebidPath:'../prebid.js',prebidIntegrity:integrity(prebid)};
  for(const arm of ['A','B']) {
    assert.equal(typeof arms[arm],'string');
    const output=await finalizeJavaScript(instrumentFullRuntime(arms[arm],release));
    for(const [program,text]of [['ads.js',output.adsJs],['ads.min.js',output.adsMinJs]]) {
      const path=`arms/${arm}/${program}`,bytes=encoder.encode(text);files[path]=bytes;
    }
    config.arms[arm]={path:`../arms/${arm}/ads.js`,sha256:hash(files[`arms/${arm}/ads.js`]),integrity:integrity(files[`arms/${arm}/ads.js`])};
  }
  for(const program of ['ads.js','ads.min.js']) {
    const programConfig=structuredClone(config);
    for(const arm of ['A','B']) {
      const path=`arms/${arm}/${program}`;
      Object.assign(programConfig.arms[arm],{path:'../'+path,sha256:hash(files[path]),integrity:integrity(files[path])});
    }
    files[`loader/${program}`]=encoder.encode(`(${boot})(${JSON.stringify(programConfig).replace(/</g,'\\u003c')});\n`);
  }
  return {config,files,canonicalLoaderSha256:hash(source),
    scope:'QA-only new-runtime delivery adapter; the existing 3.9.1 saved-script UI and accepted Tanjug bytes are unchanged.'};
}
