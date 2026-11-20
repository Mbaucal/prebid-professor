import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** A strict in-memory stand-in for one R2 bucket, NOT real R2. It accepts only keys under
 * `prefix`, refuses an unconditional put (each put needs If-None-Match: * or If-Match: <etag>)
 * and any put without `private, no-store`, caps customMetadata at R2's 2048 bytes, and lists in
 * key order with a limit and an opaque cursor. `pageCap` makes list return fewer objects than
 * the limit asked for, as R2 may, so callers must follow the cursor. Every call yields first,
 * so concurrent callers interleave. `faults.beforePut(key)` and `faults.list(options)` may throw. */
export function memoryR2({prefix = 'site-experiments/v1/', pageCap = 1000} = {}) {
  const objects = new Map(), log = {puts: [], gets: [], lists: [], deletes: [], refused: []};
  const faults = {beforePut: null, list: null};
  let etags = 0;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const inScope = key => assert.ok(typeof key === 'string' && key.startsWith(prefix) && !key.includes('//') && !key.split('/').includes('..'), `memory-r2: key outside ${prefix}: ${key}`);
  const header = (onlyIf, name) => onlyIf instanceof Headers ? onlyIf.get(name) : onlyIf?.[name] ?? onlyIf?.[name.toLowerCase()] ?? null;
  const bytesOf = value => typeof value === 'string' ? new TextEncoder().encode(value)
    : value instanceof Uint8Array ? value.slice() : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : assert.fail('memory-r2: unsupported body');
  const view = (key, stored, include = ['httpMetadata', 'customMetadata']) => ({key, size: stored.bytes.length, etag: stored.etag, uploaded: stored.uploaded,
    ...(include.includes('httpMetadata') ? {httpMetadata: {...stored.httpMetadata}} : {}),
    ...(include.includes('customMetadata') ? {customMetadata: {...stored.customMetadata}} : {})});
  const bucket = {
    async get(key) {
      await tick(); inScope(key); log.gets.push(key);
      const stored = objects.get(key);
      if (!stored) return null;
      const copy = stored.bytes.slice();
      return {...view(key, stored), async arrayBuffer() { return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength); },
        async text() { return new TextDecoder().decode(copy); }};
    },
    async put(key, value, options = {}) {
      await tick(); inScope(key); log.puts.push(key);
      const onlyIf = options.onlyIf, none = header(onlyIf, 'If-None-Match'), match = header(onlyIf, 'If-Match');
      assert.ok(none === '*' || (typeof match === 'string' && match), `memory-r2: unconditional put of ${key}`);
      assert.equal(options.httpMetadata?.cacheControl, 'private, no-store', `memory-r2: ${key} must be private, no-store`);
      const custom = options.customMetadata ?? {};
      const metadataBytes = Object.entries(custom).reduce((n, [k, v]) => { assert.equal(typeof v, 'string', 'memory-r2: customMetadata values are strings'); return n + Buffer.byteLength(k) + Buffer.byteLength(v); }, 0);
      assert.ok(metadataBytes <= 2048, `memory-r2: customMetadata of ${key} is ${metadataBytes} bytes, over R2's 2048`);
      const bytes = bytesOf(value);
      if (options.sha256 !== undefined) assert.equal(createHash('sha256').update(bytes).digest('hex'), options.sha256, `memory-r2: sha256 of ${key} differs`);
      if (faults.beforePut) await faults.beforePut(key);
      const existing = objects.get(key);
      if ((none === '*' && existing) || (match && existing?.etag !== match)) { log.refused.push(key); return null; }
      const stored = {bytes, etag: `etag-${++etags}`, uploaded: new Date(), httpMetadata: {...options.httpMetadata}, customMetadata: {...custom}};
      objects.set(key, stored);
      return view(key, stored);
    },
    async delete(keys) {
      await tick();
      for (const key of [keys].flat()) { inScope(key); log.deletes.push(key); objects.delete(key); }
    },
    async list(options = {}) {
      await tick();
      const {prefix: listed = '', limit = 1000, cursor, include = []} = options;
      inScope(listed); log.lists.push({...options});
      assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'memory-r2: list limit must be 1 to 1000');
      assert.ok(include.every(x => ['httpMetadata', 'customMetadata'].includes(x)), 'memory-r2: unknown include');
      if (faults.list) await faults.list(options);
      const keys = [...objects.keys()].filter(key => key.startsWith(listed)).sort();
      const after = cursor === undefined ? null : JSON.parse(Buffer.from(cursor, 'base64url').toString()).after;
      const rest = after === null ? keys : keys.filter(key => key > after);
      const page = rest.slice(0, Math.min(limit, pageCap)), truncated = rest.length > page.length;
      return {objects: page.map(key => view(key, objects.get(key), include)), truncated, delimitedPrefixes: [],
        ...(truncated ? {cursor: Buffer.from(JSON.stringify({after: page.at(-1)})).toString('base64url')} : {})};
    },
  };
  return {bucket, objects, log, faults};
}
