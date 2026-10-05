/** Generate final JS/CSS candidate fixtures locally, without ad networks or real storage. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildArtifactCandidate } from '../worker/runtime/artifact-candidate.mjs';
import { fixture, configure, takeOver, checkedFixture, pin, TS } from '../tests/runtime/artifact-fixture.mjs';
const output = resolve(process.argv[2] || '.generated/artifact-candidate-verification');
const cases = [
  ['standard', () => {}],
  ['empty-layout', (s) => {s.maps[0].map_json='[{"minViewPort":[0,0],"sizes":[[300,250]]},{"minViewPort":[768,0],"sizes":[]}]';}],
  ['fluid-layout', (s) => {s.maps[0].map_json='[{"minViewPort":[0,0],"sizes":[[300,250]]},{"minViewPort":[768,0],"sizes":["fluid"]}]';}],
  ['short-timeout', (_s,t) => {t.requestTimeoutMs=1000;t.renderFallbackMs=20;}],
  ['custom-takeover', (_s,t) => {t.desktopSize=[640,480];t.mobileSize=[320,100];t.autoCloseDesktopSec=1;t.autoCloseMobileSec=1;}],
  ['timer-disabled', (_s,t) => {t.autoCloseDesktopSec=0;t.autoCloseMobileSec=0;}],
  ['gpt-only', (s) => configure(s,(c)=>{c.enablePrebid=false;})],
  ['no-bidders', (s) => {s.bidders=[];s.overrides=[];}],
  ['sticky-off', (s) => configure(s,(c)=>{c.runtimeControls.sticky.bottomAdUnitId='';})],
  ['takeover-off', (_s,t) => {t.enabled=false;}],
  ['id5-explicit', (s) => configure(s,(c)=>{c.userSync.userIds=[{name:'id5Id',params:{partner:42}}];})],
  ['floor-off', (s) => configure(s,(c)=>{c.runtimeControls.floors.enabled=false;})],
];
const report=[];
for (const variant of ['readable','minified']) await mkdir(join(output,variant),{recursive:true});
for (const [name, change] of cases) {
  const snapshot=fixture(),t=takeOver();change(snapshot,t);
  const candidate=await buildArtifactCandidate({snapshot,takeOver:t,pin:pin(),buildTimestamp:TS,prebid:await checkedFixture(snapshot)});
  for (const [variant,file] of [['readable','ads.js'],['minified','ads.min.js']]) {
    await writeFile(join(output,variant,`${name}.js`),candidate.files[file]);
  }
  const folder=join(output,'packages',name);await mkdir(folder,{recursive:true});
  for (const [name,bytes] of Object.entries(candidate.files)) await writeFile(join(folder,name),bytes);
  report.push({name,passed:true,sourceBytes:candidate.files['ads.js'].byteLength,minifiedBytes:candidate.files['ads.min.js'].byteLength,runtime:candidate.manifest.runtime,completeRelease:false});
}
for (const variant of ['readable','minified']) await writeFile(join(output,variant,'generation-report.json'),JSON.stringify({scope:'Real in-memory candidate output, synthetic Prebid artifact; not published.',cases:report},null,2));
await writeFile(join(output,'artifact-report.json'),JSON.stringify({passed:report.length,failed:0,cases:report},null,2));
console.log(JSON.stringify({output,generated:report.length,variants:2}));
