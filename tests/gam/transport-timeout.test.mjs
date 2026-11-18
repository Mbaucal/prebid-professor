import test from 'node:test';
import assert from 'node:assert/strict';
import { GamClient } from '../../worker/integrations/gam-client.mjs';
import { GamTrafficClient } from '../../worker/integrations/gam-traffic-client.mjs';
import { GamError } from '../../shared/gam/plan.mjs';

const soap = operation => `<Envelope><Body><${operation}Response><rval><id>123</id></rval></${operation}Response></Body></Envelope>`;

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  // Model native timeout signals against the same virtual clock as Google.
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
}

function delayedResponse(signal, milliseconds, operation) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    setTimeout(() => resolve(new Response(soap(operation))), milliseconds);
  });
}

test('a successful 40-second creative batch is acknowledged without replay', async t => {
  clock(t);
  let calls = 0;
  const client = new GamClient('123456', 'synthetic-token', async (_url, init) => {
    calls++;
    return delayedResponse(init.signal, 40_000, 'createCreatives');
  });
  const pending = client.call('CreativeService', 'createCreatives');
  const observed = pending.then(value => ({ value }), error => ({ error }));
  t.mock.timers.tick(40_000);
  const result = await observed;
  assert.equal(result.error, undefined);
  assert.equal(result.value.id, '123');
  assert.equal(calls, 1);
});

test('slow reads remain bounded and a create timeout stays unconfirmed without retry', async t => {
  clock(t);
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  for (const [operation, delay] of [['getCreativesByStatement', 25_000], ['createCreatives', 60_000]]) {
    let calls = 0;
    const client = new GamClient('123456', 'synthetic-token', async (_url, init) => {
      calls++;
      return delayedResponse(init.signal, 70_000, operation);
    });
    const pending = client.call('CreativeService', operation);
    const rejected = assert.rejects(pending, error => {
      assert(error instanceof GamError);
      assert.equal(error.status, 502);
      assert.match(error.message, /isteklo/i);
      if (operation.startsWith('create')) assert.match(error.message, /Proverite ishod u GAM-u/);
      return true;
    });
    t.mock.timers.tick(delay);
    await rejected;
    assert.equal(calls, 1);
    assert.equal(logs.at(-1)[1].reason, 'timeout');
    assert.equal(logs.at(-1)[1].elapsedMs, delay);
  }
});

test('a response body interruption becomes a safe actionable transport error', async t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  const secret = 'synthetic-token-and-private-creative-snippet';
  const client = new GamClient('123456', secret, async () => ({
    status: 200,
    ok: true,
    async text() { throw new TypeError(secret); },
  }));
  const traffic = new GamTrafficClient(client);
  await assert.rejects(traffic.create('creative', [{ name: 'One' }, { name: 'Two' }]), error => {
    assert(error instanceof GamError);
    assert.equal(error.status, 502);
    assert.match(error.message, /prekinuta/i);
    assert.match(error.message, /Proverite ishod u GAM-u/);
    assert(!error.message.includes(secret));
    return true;
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].stage, 'body');
  assert.equal(logs[0][1].reason, 'network');
  assert.equal(logs[0][1].entityCount, 2);
  assert.equal(logs[0][1].operation, 'createCreatives');
  assert(!JSON.stringify(logs).includes(secret));
});

test('the deadline also covers an incomplete response body', async t => {
  clock(t);
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  const client = new GamClient('123456', 'synthetic-token', async (_url, init) => ({
    status: 200, ok: true,
    text: () => delayedResponse(init.signal, 70_000, 'createCreatives').then(response => response.text()),
  }));
  const rejected = assert.rejects(client.call('CreativeService', 'createCreatives'), error => {
    assert(error instanceof GamError);
    assert.match(error.message, /isteklo/);
    assert.match(error.message, /Proverite ishod u GAM-u/);
    return true;
  });
  await Promise.resolve(); // The headers arrived; reading the body is pending.
  t.mock.timers.tick(60_000);
  await rejected;
  assert.equal(logs[0][1].stage, 'body');
  assert.equal(logs[0][1].reason, 'timeout');
});

test('connection failures never leak raw exceptions or retry a create', async t => {
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  let calls = 0;
  const client = new GamClient('123456', 'synthetic-token', async () => {
    calls++;
    throw new TypeError('synthetic-private-request-data');
  });
  await assert.rejects(client.call('CreativeService', 'createCreatives'), error => {
    assert(error instanceof GamError);
    assert.match(error.message, /prekinuta/i);
    assert(!error.message.includes('synthetic-private-request-data'));
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(logs[0][1].stage, 'headers');
  assert.equal(logs[0][1].reason, 'network');
  assert(!JSON.stringify(logs).includes('synthetic-private-request-data'));
});

test('explicit Google rejection remains a rejection, not a transport timeout', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const client = new GamClient('123456', 'synthetic-token', async () => new Response(
    '<Envelope><Body><Fault><detail><ApiExceptionFault><errors><reason>PERMISSION_DENIED</reason></errors></ApiExceptionFault></detail></Fault></Body></Envelope>',
    { status: 500 },
  ));
  await assert.rejects(client.call('CreativeService', 'createCreatives'), /PERMISSION_DENIED/);
  assert.equal(warn.mock.callCount(), 0);
});
