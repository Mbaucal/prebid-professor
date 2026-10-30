/** Standalone page-console inspector. Keep all dependencies inside this function:
 * the dashboard serializes it, and executes nothing on the publisher's behalf.
 */
export function inspectSchain(options) {
  'use strict';
  options = options || {};
  const scope = { adUnit: options.adUnit || '', bidder: options.bidder || '' };
  const LIMIT = 200;
  const MAX_BYTES = 512 * 1024;
  const MAX_TOTAL = 8 * 1024 * 1024;
  const warnings = [];
  const requests = [];
  const network = [];
  let retainedBytes = 0;
  let reservedBytes = 0;
  let droppedRequests = 0;
  let droppedNetwork = 0;
  let active = false;
  let timer;
  const pending = new Set();
  const cleanups = [];
  const startedAt = new Date().toISOString();
  const pbjs = window.pbjs;
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  const read = (fn, fallback, label) => {
    try { return fn(); } catch { warn(label + ' unavailable'); return fallback; }
  };
  if (window.__TESSERA_SCHAIN_DEBUG?.stop) window.__TESSERA_SCHAIN_DEBUG.stop();

  function clone(value) {
    const ancestors = [];
    let incomplete = false;
    const json = JSON.stringify(value, function (key, item) {
      if (typeof item === 'bigint' || typeof item === 'function') {
        incomplete = true;
        return '[Unsupported ' + typeof item + ']';
      }
      if (!item || typeof item !== 'object') return item;
      while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(item)) { incomplete = true; return '[Circular]'; }
      ancestors.push(item);
      return item;
    });
    if (typeof json !== 'string') throw Error('Not serializable');
    if (json.length * 2 > MAX_BYTES) throw Error('Snapshot exceeds size limit');
    return { value: JSON.parse(json), bytes: json.length * 2, incomplete };
  }

  function chains(object, prefix) {
    if (!object || typeof object !== 'object') return [];
    const candidates = [
      ['schain.config', object.schain?.config],
      ['schain', object.schain?.config ? null : object.schain],
      ['ortb2.source.schain', object.ortb2?.source?.schain],
      ['ortb2.source.ext.schain', object.ortb2?.source?.ext?.schain],
      ['source.schain', object.source?.schain],
      ['source.ext.schain', object.source?.ext?.schain],
    ];
    return candidates.filter(([, value]) => value != null).map(([path, value]) => ({ path: prefix + path, value }));
  }

  function storeRequest(request, elapsedTime, source) {
    if (!request || typeof request !== 'object') return;
    const bidder = request.bidderCode || request.bidder || '';
    if (scope.bidder && bidder !== scope.bidder) return;
    if (scope.adUnit && !(Array.isArray(request.bids) && request.bids.some(bid => bid?.adUnitCode === scope.adUnit))) return;
    try {
      const saved = clone(request);
      while (requests.length && (requests.length >= LIMIT || retainedBytes + reservedBytes + saved.bytes > MAX_TOTAL)) {
        retainedBytes -= requests.shift().bytes;
        droppedRequests++;
      }
      if (retainedBytes + reservedBytes + saved.bytes > MAX_TOTAL) { droppedRequests++; return; }
      requests.push({ ...saved, elapsedTime: elapsedTime ?? null, source, observedAt: new Date().toISOString() });
      retainedBytes += saved.bytes;
    } catch {
      droppedRequests++;
      warn('Some Prebid requests could not be serialized or exceeded the 512 KiB snapshot limit.');
    }
  }

  const config = read(() => clone(pbjs?.getConfig?.() || {}).value, {}, 'Global configuration');
  const bidderConfig = read(() => {
    if (typeof pbjs?.getBidderConfig !== 'function') return null;
    return clone(pbjs.getBidderConfig()).value;
  }, null, 'Bidder configuration');
  const configured = {
    global: chains(config, 'config.'),
    bidderConfigAvailable: bidderConfig !== null,
    bidders: Object.entries(bidderConfig || {}).filter(([bidder]) => !scope.bidder || bidder === scope.bidder)
      .map(([bidder, value]) => ({ bidder, schain: chains(value?.config || value, 'bidderConfig.' + bidder + '.') })),
  };
  if (!pbjs) warn('Prebid is not loaded. Run the snapshot again after it loads.');
  else if (typeof pbjs.getEvents !== 'function') warn('Prebid event history is unavailable.');
  const history = read(() => pbjs?.getEvents?.() || [], [], 'Prebid history');
  if (!Array.isArray(history)) warn('Prebid event history has an unsupported format.');
  for (const event of Array.isArray(history) ? history : []) {
    if (event?.eventType === 'bidRequested') read(() => storeRequest(event.args, event.elapsedTime, 'prebid-history'), null, 'Prebid event');
  }

  function requestReport(entry) {
    const request = entry.value;
    const requestChains = chains(request, 'request.');
    return {
      source: entry.source, observedAt: entry.observedAt, elapsedTime: entry.elapsedTime,
      bidder: request.bidderCode || request.bidder || null,
      auctionId: request.auctionId || null, bidderRequestId: request.bidderRequestId || null,
      serialization: entry.incomplete ? 'incomplete: unsupported values replaced' : 'complete JSON snapshot',
      requestSchain: requestChains,
      filteredBids: (Array.isArray(request.bids) ? request.bids : []).flatMap((bid, index) => {
        if (!bid || (scope.adUnit && bid.adUnitCode !== scope.adUnit)) return [];
        const found = [...chains(bid, 'request.bids[' + index + '].'), ...requestChains];
        return [{ adUnitCode: bid.adUnitCode || null, bidId: bid.bidId || null,
          schainStatus: found.length ? 'present in Prebid request' : 'not found in captured Prebid fields',
          schain: found, bid }];
      }),
      // A batch is deliberately kept intact, even when a position is selected.
      originalRequest: request,
    };
  }

  // These exact ad endpoints are covered by this first network decoder.
  const endpoints = [
    { host: 'rtb.openx.net', path: '/openrtbb/prebidjs', bidder: 'openx' },
    { host: 'hbopenbid.pubmatic.com', path: '/translator', bidder: 'pubmatic' },
  ];
  function endpoint(value) {
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.href.length * 2 > MAX_BYTES) return null;
      const known = endpoints.find(e => e.host === url.hostname && e.path === url.pathname);
      if (known && (!scope.bidder || scope.bidder === known.bidder)) return { url, bidder: known.bidder };
      return null;
    } catch { return null; }
  }

  function parseText(text) {
    try { return { format: 'json', value: JSON.parse(text) }; } catch { /* query/form next */ }
    if (text.includes('=')) {
      const entries = Array.from(new URLSearchParams(text), ([key, value]) => {
        try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
      });
      return { format: 'url-encoded', value: entries };
    }
    return { format: 'text', value: text };
  }

  async function limitedStream(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw Error('Body exceeds 512 KiB');
        chunks.push(value);
      }
    } finally { reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  function prepareBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') {
      if (body.length * 2 > MAX_BYTES) throw Error('Body too large');
      return body;
    }
    if (body instanceof URLSearchParams) return prepareBody(body.toString());
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      if (body.byteLength > MAX_BYTES) throw Error('Body too large');
      return body instanceof ArrayBuffer ? new Uint8Array(body.slice(0)) : new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      if (body.size > MAX_BYTES) throw Error('Body too large');
      return body;
    }
    throw Error('Unsupported body type');
  }

  async function decodeBody(body) {
    if (body == null) return { status: 'no body', raw: null, parsed: null };
    if (typeof body === 'string') return { status: 'decoded', raw: body, ...parseText(body) };
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
    const raw = { encoding: 'base64', value: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) };
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') return { status: 'gzip: decoder unavailable', raw };
      try {
        const decoded = await limitedStream(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
        return { status: 'decoded gzip', raw, ...parseText(new TextDecoder().decode(decoded)) };
      } catch { return { status: 'gzip: invalid or exceeds size limit', raw }; }
    }
    return { status: 'decoded', raw, ...parseText(new TextDecoder().decode(bytes)) };
  }

  function networkChains(value, path = 'payload', found = [], depth = 0) {
    if (!value || typeof value !== 'object' || depth > 30) return found;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'schain' && item != null) found.push({ path: path + '.' + key, value: item });
      else if (Array.isArray(value) && value.length === 2 && value[0] === 'schain' && key === '1') found.push({ path, value: item });
      else networkChains(item, path + '.' + key, found, depth + 1);
    }
    return found;
  }

  function mapNetwork(record) {
    // Only exact per-bid impression IDs support auction/position attribution.
    // GPID/slot names alone recur across refreshes and cannot identify an auction.
    const payload = record.body?.value;
    const ids = new Set(Array.isArray(payload?.imp) ? payload.imp.map(imp => imp?.id).filter(Boolean) : []);
    const matches = [];
    for (const entry of requests) {
      const request = entry.value;
      if ((request.bidderCode || request.bidder) !== record.bidder) continue;
      for (const bid of Array.isArray(request.bids) ? request.bids : []) {
        if (bid?.bidId && ids.has(bid.bidId)) matches.push({ adUnitCode: bid.adUnitCode, bidId: bid.bidId, auctionId: request.auctionId, evidence: 'imp.id = bidId' });
      }
    }
    const unique = [...new Map(matches.map(match => [JSON.stringify(match), match])).values()];
    const ambiguous = unique.some(a => unique.some(b => a.bidId === b.bidId && (a.auctionId !== b.auctionId || a.adUnitCode !== b.adUnitCode)));
    return { ...record, matches: ambiguous ? [] : unique, candidates: ambiguous ? unique : [],
      mapping: ambiguous ? 'ambiguous reused bid ID; inspect full batch in DevTools' : unique.length ? 'exact bid ID match' : 'unresolved; inspect full batch in DevTools' };
  }

  function capture(meta, method, body, bodyError) {
    if (!active) return;
    const reservation = 4 * MAX_BYTES;
    if (network.length >= LIMIT || retainedBytes + reservedBytes + reservation > MAX_TOTAL) { droppedNetwork++; return; }
    reservedBytes += reservation;
    const record = { observedAt: new Date().toISOString(), source: 'page fetch/XHR call',
      bidder: meta.bidder, url: meta.url.href, method,
      query: Array.from(meta.url.searchParams), body: { status: 'decoding' }, schain: [] };
    network.push(record);
    const job = (async () => {
      try {
        const decoded = bodyError ? { status: 'unavailable: unsupported or oversized body' } : await decodeBody(body);
        const size = (JSON.stringify(decoded).length + record.url.length + JSON.stringify(record.query).length) * 2;
        if (retainedBytes + reservedBytes - reservation + size > MAX_TOTAL) { record.body = { status: 'unavailable: total capture size limit' }; droppedNetwork++; return; }
        retainedBytes += size;
        record.body = decoded;
        record.schain = [...networkChains(decoded.value, 'body'), ...networkChains(parseText(meta.url.search.slice(1)).value, 'query')];
        console.log('[Tessera] Captured ad request (full batch; inspect mapping)', mapNetwork(record));
      } catch { record.body = { status: 'unavailable: decoding failed' }; }
      finally { reservedBytes -= reservation; }
    })();
    pending.add(job);
    job.finally(() => pending.delete(job));
  }

  function stop() {
    active = false;
    clearTimeout(timer);
    while (cleanups.length) read(cleanups.pop(), null, 'Capture cleanup');
  }

  function startCapture() {
    active = true;
    if (typeof pbjs?.onEvent === 'function' && typeof pbjs?.offEvent === 'function') {
      const onRequest = request => { if (active) read(() => storeRequest(request, null, 'prebid-live'), null, 'Prebid event'); };
      read(() => {
        pbjs.onEvent('bidRequested', onRequest);
        cleanups.push(() => pbjs.offEvent('bidRequested', onRequest));
      }, null, 'Prebid live listener');
    } else warn('Live Prebid listener unavailable; captured network requests may remain unmapped.');
    if (typeof window.fetch === 'function') {
      const original = window.fetch;
      const wrapped = function (input, init) {
        let meta, body, bodyError = false, method = 'GET';
        // Do not consume/clone Request streams or invoke caller-supplied init
        // accessors a second time. The native call remains the only consumer.
        try {
          if (active) {
            const isRequest = typeof Request !== 'undefined' && input instanceof Request;
            const url = typeof input === 'string' || input instanceof URL ? String(input) : isRequest ? input.url : null;
            meta = url && endpoint(url);
            if (meta) {
              method = isRequest ? input.method : 'GET';
              const ownBody = init && Object.getOwnPropertyDescriptor(init, 'body');
              const ownMethod = init && Object.getOwnPropertyDescriptor(init, 'method');
              if (ownMethod) method = typeof ownMethod.value === 'string' ? ownMethod.value : 'unavailable';
              else if (init && 'method' in init) method = 'unavailable';
              if (ownBody && 'value' in ownBody) body = prepareBody(ownBody.value);
              else if ((init && 'body' in init) || (isRequest && input.body)) bodyError = true;
            }
          }
        } catch { bodyError = true; }
        const result = Reflect.apply(original, this, arguments);
        if (meta) read(() => capture(meta, method, body, bodyError), null, 'Fetch observation');
        return result;
      };
      read(() => {
        window.fetch = wrapped;
        cleanups.push(() => { if (window.fetch === wrapped) window.fetch = original; });
      }, null, 'Fetch capture');
    }
    const proto = window.XMLHttpRequest?.prototype;
    if (proto) {
      const originalOpen = proto.open;
      const originalSend = proto.send;
      const metadata = new WeakMap();
      const open = function (method, url) {
        const result = Reflect.apply(originalOpen, this, arguments);
        if (active) read(() => metadata.set(this, { meta: typeof url === 'string' || url instanceof URL ? endpoint(url) : null, method: typeof method === 'string' ? method : 'unavailable' }), null, 'XHR URL');
        return result;
      };
      const send = function (body) {
        const info = active && metadata.get(this);
        let saved, bodyError = false;
        if (info?.meta) { try { saved = prepareBody(body); } catch { bodyError = true; } }
        const result = Reflect.apply(originalSend, this, arguments);
        if (info?.meta) read(() => capture(info.meta, info.method, saved, bodyError), null, 'XHR observation');
        return result;
      };
      read(() => {
        proto.open = open;
        cleanups.push(() => { if (proto.open === open) proto.open = originalOpen; });
        proto.send = send;
        cleanups.push(() => { if (proto.send === send) proto.send = originalSend; });
      }, null, 'XHR capture');
    }
    timer = setTimeout(stop, 5 * 60 * 1000);
  }

  function snapshot() {
    const mapped = network.map(mapNetwork);
    return { schemaVersion: 1, startedAt, generatedAt: new Date().toISOString(), scope,
      prebidVersion: pbjs?.version || null, configured,
      requests: requests.map(requestReport),
      network: mapped.filter(record => !scope.adUnit || record.matches.some(m => m.adUnitCode === scope.adUnit)),
      // Keep unmapped batches available without pretending they belong to the selected unit.
      unmappedNetwork: scope.adUnit ? mapped.filter(record => !record.matches.length) : [],
      capture: { active, pending: pending.size, supportedEndpoints: endpoints,
        droppedRequests, droppedNetwork, limits: { recordsPerKind: LIMIT, bytesPerBody: MAX_BYTES, totalBytes: MAX_TOTAL, seconds: 300 } },
      warnings: [...warnings],
      notes: [
        'Prebid events are internal adapter inputs, not the final HTTP payload. Config is not proof of transmission.',
        'Network records observe calls to page fetch/XHR, not delivery, SSP acceptance or downstream forwarding.',
        'Only the listed OpenX/PubMatic endpoints are captured. Other endpoints, frames, workers, beacons and saved API references require DevTools/HAR.',
        'Only future calls are captured. Request stream bodies are unavailable. Missing or undecoded evidence is not a missing SChain.',
        'originalRequest and network bodies retain the full batch, which may contain other positions. filteredBids contains only the selected position.',
        'Reports stay in this browser. Full requests may contain identifiers and consent strings; review before sharing.',
      ] };
  }

  function print() {
    const report = snapshot();
    console.group('[Tessera] SChain and requests');
    console.table(report.requests.flatMap(request => request.filteredBids.map(bid => ({
      auctionId: request.auctionId, bidder: request.bidder, adUnit: bid.adUnitCode,
      schain: bid.schainStatus, paths: bid.schain.map(s => s.path).join(', '),
    }))));
    console.log(report);
    if (!report.requests.length) console.info('No matching Prebid requests in the available history. Check the scope or run again after an auction.');
    console.info('Helpers: __TESSERA_SCHAIN_DEBUG.print(), .snapshot(), .copy(), .download(), .stop()');
    console.groupEnd();
    return report;
  }

  const api = { snapshot, print, stop,
    async ready() { await Promise.allSettled([...pending]); return snapshot(); },
    async copy() {
      const json = JSON.stringify(snapshot(), null, 2);
      if (typeof copy === 'function') { copy(json); return; }
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(json); return; }
      console.info('Clipboard unavailable. Use .download() or copy the returned JSON.');
      return json;
    },
    download() {
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'tessera-schain-debug.json';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
  window.__TESSERA_SCHAIN_DEBUG = api;
  if (options.captureNetwork) startCapture();
  return print();
}

export function schainInspectCommand(scope, captureNetwork = false) {
  return '/* Tessera SChain / request inspector */\n(' + inspectSchain.toString() + ')(' +
    JSON.stringify({ adUnit: scope.adUnit || '', bidder: scope.bidder || '', captureNetwork }) + ');\n';
}
