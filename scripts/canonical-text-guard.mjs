/** LOCAL verification only: runs a sealed Worker bundle in Miniflare behind a
 * guard that records every Function.prototype.toString call on a non-native
 * function.
 *
 * Every function that generated code embeds has an installed own toString
 * (worker/runtime-canonical), so the prototype method runs only for a function
 * serialized without canonical text or through a bypass such as
 * Function.prototype.toString.call(fn). Those calls embed bundler-renamed source
 * whatever form the serialization takes, which a static scan cannot prove.
 *
 * The bundle bytes are unchanged. The guard module is evaluated before the
 * bundle and returns the native text, so behaviour is unchanged; a wrapper entry
 * adds one route that reports and clears the recorded calls.
 */
export const GUARD_ROUTE = '/__local-canonical-text-guard';

const guard = `const nativeText = Function.prototype.toString;
export const calls = [];
Object.defineProperty(Function.prototype, 'toString', {configurable: true, enumerable: false, writable: true, value: function toString() {
  const text = nativeText.call(this);
  if (typeof this === 'function' && !/\\{\\s*\\[native code\\]\\s*\\}$/.test(text)) {
    calls.push({name: this.name, source: text.slice(0, 160), stack: String(new Error().stack).split('\\n').slice(2, 8).map(line => line.trim())});
  }
  return text;
}});
`;
const entry = `import {calls} from './canonical-text-guard.mjs';
import worker from './index.js';
export * from './index.js';
export default {...worker, async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === ${JSON.stringify(GUARD_ROUTE)}) return Response.json(calls.splice(0));
  return worker.fetch(request, env, ctx);
}};
`;

/** Miniflare `modules` for the sealed bundle text, with the guard evaluated first. */
export function guardedModules(script) {
  return [
    {type: 'ESModule', path: 'guard-entry.mjs', contents: entry},
    {type: 'ESModule', path: 'canonical-text-guard.mjs', contents: guard},
    {type: 'ESModule', path: 'index.js', contents: script},
  ];
}

/** Recorded calls since the last report (and clears them). */
export async function guardCalls(mf, origin) {
  const response = await mf.dispatchFetch(new URL(GUARD_ROUTE, origin));
  if (response.status !== 200) throw Error(`Canonical text guard report failed: ${response.status}`);
  return response.json();
}

export function describeCalls(calls) {
  return calls.map(call => `${call.name || '(anonymous)'} [${call.source.split('\n')[0].slice(0, 80)}] from ${call.stack.find(line => !line.includes('canonical-text-guard')) ?? '?'}`);
}
