import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import * as current from '../../worker/experiments/ab-loader-1.1.0.mjs';
import * as previous from '../../worker/experiments/ab-loader-1.0.2.mjs';
import {loaderMeasurementPage as page} from '../support/ab-measurement-page.mjs';
import {syntheticDraft} from '../support/ab-synthetic-drafts.mjs';
import {composeAbBundle} from '../../worker/experiments/ab-bundle.mjs';

test('1.1.0 is append-only, ES5 and explicitly registered; no collector, storage or CMP surface',()=>{
  const registry=JSON.parse(readFileSync(new URL('../../worker/experiments/ab-loader-registry.json',import.meta.url),'utf8'));
  parse(current.AB_LOADER_TEMPLATE,{ecmaVersion:5});
  assert.equal(createHash('sha256').update(current.AB_LOADER_TEMPLATE).digest('hex'),registry['1.1.0'].sha256);
  assert.equal(registry['1.0.2'].sha256,'a9a0646a0554e61780cf07243ca0ef7aef701fd14810183b47b939fc12749b98');
  for(const name of ['fetch','XMLHttpRequest','sendBeacon','localStorage','sessionStorage','cookie','__tcfapi','__gpp','__uspapi'])assert.equal(current.AB_LOADER_TEMPLATE.includes(name),false,name);
});

test('legacy loses assignment on exclusion; 1.1 retains original B and separates executed A',()=>{
  const old=page({L:previous});old.load();old.service.setTargeting('Variant','external');assert.equal(old.state().variant,null);assert.equal(old.sandbox.__tesseraAbLoader.measurement,undefined);
  const p=page(),b=p.scripts[0];p.advance(8000);assert.equal(p.runtime(b),false);p.load();p.service.setTargeting('Variant','external');
  const value=p.measurement();assert.equal(p.state().variant,null);assert.equal(p.state().originalVariant,'B');
  assert.equal(value.assignment.variant,'B');assert.match(value.pageId,/^[a-f0-9]{32}$/);
  assert.deepEqual(value.events.filter(row=>row.type==='runtime-started').map(row=>row.arm),['A']);
  assert.deepEqual(value.events.find(row=>row.type==='fallback'),{seq:4,at:value.events[3].at,type:'fallback',fromArm:'B',toArm:'A',reason:'timeout'});
  assert.equal(value.events.at(-1).phase,'after-assignment');assert.equal(p.timers.size,0);assert.equal(p.starts.length,1);
});

test('load success is not a runtime start or impression and snapshots cannot mutate the ledger',()=>{
  const p=page();p.scripts[0].onload();const value=p.measurement();
  assert.equal(value.events.some(row=>row.type==='runtime-started'),false);assert.equal(value.events.some(row=>row.type==='script-loaded'),true);
  value.assignment.variant='A';value.events[0].variant='A';value.arms.B.scriptSha256='forged';
  assert.equal(p.measurement().assignment.variant,'B');assert.equal(p.measurement().events[0].variant,'B');assert.notEqual(p.measurement().arms.B.scriptSha256,'forged');
});

test('pre-assignment conflict and QA override remain outside randomized groups',()=>{
  const conflict=page({keywords:{Variant:'publisher'}}),qa=page({search:'?tessera_ab=B'}),random=page({crypto:false});
  for(const p of [conflict,qa,random]){assert.equal(p.measurement().assignment,null);assert.deepEqual(p.service.getTargeting('TestId'),[]);}
  assert.equal(conflict.measurement().events[0].phase,'before-assignment');
  assert.equal(qa.measurement().events[0].type,'qa-forced');assert.match(qa.measurement().pageId,/^[a-f0-9]{32}$/);
  assert.equal(random.measurement().events[0].type,'random-unavailable');assert.equal(random.measurement().pageId,null);
});

test('GPT readiness timeout keeps randomized group with after-assignment exclusion and control execution',()=>{
  const p=page({ready:false});p.advance(8000);p.flush();p.load();const value=p.measurement();
  assert.equal(value.assignment.variant,'B');assert.equal(p.state().variant,null);assert.equal(value.events.find(row=>row.type==='exclusion').phase,'after-assignment');
  assert.deepEqual(value.events.filter(row=>row.type==='runtime-started').map(row=>row.arm),['A']);assert.equal(p.timers.size,0);
});

test('control terminal failure remains assigned and no duplicate/late runtime is reported',()=>{
  const p=page(),b=p.scripts[0];p.advance(8000);p.error();p.runtime(b);const value=p.measurement();
  assert.equal(value.assignment.variant,'B');assert.equal(value.events.at(-1).type,'terminal-failure');assert.equal(value.events.some(row=>row.type==='runtime-started'),false);
  assert.equal(p.scripts.length,2);assert.equal(p.timers.size,0);assert.equal(p.starts.length,0);
});

test('bounded memory drops observations honestly and never changes serving state',()=>{
  const p=page();p.load();for(let i=0;i<90;i++)p.sandbox.__tesseraAbLoader.duplicate();const value=p.measurement();
  assert.equal(value.events.length,64);assert.equal(value.droppedEvents,30);assert.equal(value.assignment.variant,'B');assert.equal(p.starts.length,1);assert.equal(p.state().variant,'B');
});

test('explicit 1.1.0 compositions retain separate byte identities and unchanged arms',async()=>{
  const a=await syntheticDraft(),b=await syntheticDraft({runtimeVersion:'9.0.1',script:'window.arm="B";'}),input={site:'test-site',a,b,testId:'memory_1',name:'Memory observation',trafficBPercent:50};
  const now=await composeAbBundle({...input,loaderVersion:'1.1.0'}),previousBundle=await composeAbBundle({...input,loaderVersion:'1.0.2'}),legacy=await composeAbBundle({...input,loaderVersion:'1.0.1'});
  assert.equal(now.record.loader.version,'1.1.0');assert.equal(previousBundle.record.loader.version,'1.0.2');assert.equal(legacy.record.loader.version,'1.0.1');
  assert.notEqual(now.id,previousBundle.id);assert.notEqual(now.zipSha256,previousBundle.zipSha256);
  assert.deepEqual(now.files[now.record.arms.A.path],previousBundle.files[previousBundle.record.arms.A.path]);
  assert.match(new TextDecoder().decode(now.files['ads.js']),/"site":"test-site"/);
});
