import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from 'acorn';
import { transform } from '../../worker/runtime-3161/refresh-counting.mjs';
import { compileRuntime316 } from '../../worker/runtime-316/compiler.mjs';
import { previewInput } from '../../worker/runtime-316/snapshot.mjs';
import { descriptor } from '../../.generated/runtime-316-manifest.mjs';
import { positionFixture } from '../support/position-runtime-fixture.mjs';

function source(prebid) {
  const snapshot = positionFixture(prebid);
  const c = JSON.parse(snapshot.config.config_json);
  c.runtimeControls.adPositions = {};
  snapshot.config.config_json = JSON.stringify(c);
  snapshot.units = snapshot.units.filter(u => u.code !== 'Overlay');
  snapshot.overrides = [];
  return compileRuntime316(previewInput(snapshot, descriptor, '20261024_140000')).adsJs;
}

for (const prebid of [false, true]) {
  test((prebid ? 'Prebid' : 'GAM-only') + ': generated source counts only the final allowed refresh and rolls back thrown sends', () => {
    const compiled = source(prebid), fixed = transform(compiled);
    parse(fixed, { ecmaVersion: 'latest' });
    assert(compiled.includes('_refreshCounts[id]=(_refreshCounts[id]||0)+1;'));
    assert(fixed.includes('_lastRefreshAt[id]=now(); _tesseraRefreshPending[id]=slot;'));
    const start = fixed.indexOf('          var countedRefreshes=[],previousSendTimes=[];');
    const end = fixed.indexOf('\n        };', start);
    assert(start >= 0 && end > start);
    const body = fixed.slice(start, end);
    const slot = { id: 'P1' }, oldSlot = { id: 'P1' };
    let sends = 0, throws = false, time = 10;
    const env = { allow: [slot], pa: {}, opts: {}, orig() {}, sid: s => s.id,
      window: {adSlots: {P1: slot}}, _takeOverSlot: null, _takeOverCodelessGuardSlot: null, now: () => time,
      _refreshCounts: {}, _tesseraRefreshPending: {}, _tesseraLastRefreshSentAt: Object.create(null),
      _gamReporting: { send() { if (throws) throw Error('synthetic GPT failure'); sends++; } } };
    const send = () => vm.runInNewContext('(function(){if(!allow.length)return;' + body + '})()', env);
    throws = true;
    assert.throws(send, /synthetic GPT failure/);
    assert.equal(Object.hasOwn(env._tesseraLastRefreshSentAt, 'P1'), false, 'a failed first send does not establish a wall-clock timestamp');
    throws = false;
    send();
    assert.equal(env._refreshCounts.P1, undefined, 'initial request is not an automatic refresh');
    assert.equal(env._tesseraLastRefreshSentAt.P1, 10, 'initial request establishes the actual wall-clock boundary');
    env._tesseraRefreshPending.P1 = slot;
    env.allow = [];
    send();
    assert.equal(env._refreshCounts.P1, undefined, 'no allowed GPT dispatch consumes no cap');
    assert.strictEqual(env._tesseraRefreshPending.P1, slot);
    assert.equal(env._tesseraLastRefreshSentAt.P1, 10, 'blocked requests do not move the send timestamp');
    env.allow = [slot];
    time = 20;
    send();
    assert.equal(env._refreshCounts.P1, 1);
    assert.equal(env._tesseraLastRefreshSentAt.P1, 20);
    assert.equal(env._tesseraRefreshPending.P1, undefined);
    time = 30;
    send();
    assert.equal(env._refreshCounts.P1, 1, 'unmarked dispatch does not consume the automatic counter twice');
    assert.equal(env._tesseraLastRefreshSentAt.P1, 30, 'every owned request moves the actual send boundary');
    env._tesseraRefreshPending.P1 = oldSlot;
    time = 40;
    send();
    assert.equal(env._refreshCounts.P1, 1, 'stale slot identity does not consume a new slot counter');
    env._tesseraRefreshPending.P1 = slot;
    throws = true;
    time = 50;
    assert.throws(send, /synthetic GPT failure/);
    assert.equal(env._refreshCounts.P1, 1);
    assert.equal(env._tesseraLastRefreshSentAt.P1, 40, 'throwing send restores the previous actual time');
    assert.strictEqual(env._tesseraRefreshPending.P1, slot);
    throws = false;
    time = 60;
    send();
    assert.equal(env._refreshCounts.P1, 2);
    assert.equal(env._tesseraLastRefreshSentAt.P1, 60);
    env.allow = [{id:'foreign'}];
    send();
    assert.equal(Object.hasOwn(env._tesseraLastRefreshSentAt, 'foreign'), false, 'publisher-owned foreign slots do not enter the wrapper clock');
    assert.equal(sends, 6);
  });
}

test('the source transform refuses missing or duplicate anchors instead of guessing', () => {
  const compiled = source(false);
  assert.throws(() => transform(compiled.replace('  var _refreshCounts = {};', '')), /insertion point changed/);
  assert.throws(() => transform(transform(compiled)), /insertion point changed/);
});
