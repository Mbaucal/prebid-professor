import test from 'node:test';
import assert from 'node:assert/strict';
import {createConsentWaitObserver} from '../../worker/site-runtime/test-page-client.mjs';
const pending = phase => ({status:'available',ready:false,phase});
test('identical loading observations cannot postpone the diagnostic threshold',()=>{
 let time=0;const observe=createConsentWaitObserver(()=>time);
 assert.deepEqual(observe(pending('cmp-loading')),{phase:'cmp-loading',observedSeconds:0,prolonged:false});
 for(time=1000;time<30000;time+=1000)assert.equal(observe(pending('cmp-loading')).prolonged,false);
 assert.deepEqual(observe(pending('cmp-loading')),{phase:'cmp-loading',observedSeconds:30,prolonged:true});
});
test('user decision and missing publisher CMP are never diagnosed as stalled',()=>{
 for(const phase of ['user-decision','cmp-missing']){let time=0;const observe=createConsentWaitObserver(()=>time);observe(pending(phase));time=120000;assert.equal(observe(pending(phase)).prolonged,false);}
});
test('scope/error/loading have separate phase intervals, readiness resets and unavailable hides without losing observation',()=>{
 let time=0;const observe=createConsentWaitObserver(()=>time);
 for(const phase of ['scope-unknown','cmp-error','cmp-loading']) {assert.equal(observe(pending(phase)).observedSeconds,0);time+=30000;assert.equal(observe(pending(phase)).prolonged,true);}
 assert.equal(observe({status:'available',ready:true,phase:'decision-ready'}),null);
 assert.equal(observe(pending('cmp-loading')).observedSeconds,0);
 time+=45000;assert.equal(observe(pending('cmp-loading')).prolonged,true);
 assert.equal(observe({status:'unavailable',ready:null}),null);
 assert.equal(observe(pending('cmp-loading')).observedSeconds,45);
 assert.equal(observe({status:'not-started',ready:null}),null);
});
test('observation does not mutate consent or expose additional runtime fields',()=>{
 const consent=Object.freeze({...pending('cmp-loading'),tcString:'private'});
 assert.deepEqual(createConsentWaitObserver(()=>0)(consent),{phase:'cmp-loading',observedSeconds:0,prolonged:false});
});
