/* Synthetic native-Prebid/CMP initializer for independent loader transport QA.
 * No publisher data, storage identifier, or real bidder request. Placeholders are rendered by the QA driver. */
(() => {
  // Bid requests still in flight; the virtual clock only moves when there are none.
  window.__inflight = 0;
  const fetch = window.fetch.bind(window);
  window.fetch = (...args) => { window.__inflight++; return fetch(...args).finally(() => { window.__inflight--; }); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    window.__inflight++; this.addEventListener('loadend', () => { window.__inflight--; }, {once: true});
    return send.apply(this, args);
  };
  // The loaders draw one Uint32 per pageview; fix it, or take randomness away. Prebid's own draws are untouched.
  const draw = %DRAW%, real = crypto.getRandomValues.bind(crypto);
  window.__draws = 0;
  const nativeTimeout = window.setTimeout, nativeClear = window.clearTimeout;
  const loaderTimers = window.__loaderTimers = [];
  window.setTimeout = function(callback, delay, ...args) {
    if (delay !== 8000 || typeof callback !== 'function' || !String(new Error().stack).includes('%LOADER%:')) return nativeTimeout.call(this, callback, delay, ...args);
    const record = {id:null,active:true};
    const id = nativeTimeout.call(this, function(...values) { record.active=false; return callback.apply(this,values); }, delay, ...args);
    record.id=id;loaderTimers.push(record);return id;
  };
  window.clearTimeout = function(id) { for(const record of loaderTimers)if(record.id===id)record.active=false;return nativeClear.call(this,id); };
  if (draw !== null) crypto.getRandomValues = array => {
    if (!(array instanceof Uint32Array && array.length === 1) || document.currentScript?.src !== '%LOADER%' || window.__draws) return real(array);
    window.__draws++;
    if (draw === 'none') throw new Error('No randomness on this synthetic page');
    array[0] = draw; return array;
  };
  const cmp = %CMP%, flags = value => Object.fromEntries(Array.from({length: 1000}, (_, i) => [i + 1, value]));
  let decision = cmp === 'pending' ? {gdprApplies: true, listenerId: 1, eventStatus: 'cmpuishown', cmpStatus: 'loaded'}
    : {gdprApplies: true, tcString: '%TC%' + (cmp === 'denied' ? '-denied' : ''), listenerId: 1,
      eventStatus: cmp === 'denied' ? 'useractioncomplete' : 'tcloaded', cmpStatus: 'loaded',
      purpose: {consents: flags(cmp === 'granted'), legitimateInterests: flags(cmp === 'granted')},
      vendor: {consents: flags(cmp === 'granted'), legitimateInterests: flags(cmp === 'granted')},
      specialFeatureOptins: flags(cmp === 'granted'), publisher: {restrictions: {}}};
  const listeners = [];
  window.__fixtureGrantCmp = () => {
    decision = {gdprApplies:true,tcString:'%TC%',listenerId:1,eventStatus:'useractioncomplete',cmpStatus:'loaded',
      purpose:{consents:flags(true),legitimateInterests:flags(true)},vendor:{consents:flags(true),legitimateInterests:flags(true)},
      specialFeatureOptins:flags(true),publisher:{restrictions:{}}};
    for (const callback of listeners) callback(decision,true);
  };
  window.__tcfapi = (command, version, callback) => {
    if (command === 'addEventListener' || command === 'getTCData') { if(command==='addEventListener')listeners.push(callback); callback(decision, true); }
    else if (command === 'ping') callback({cmpLoaded: true, gdprApplies: true}, true);
    else callback(true);
  };
  // Bids per bidder and auction, as in scripts/verify-bidcache323-browser.py.
  const script = %SCRIPT%, rounds = new Map();
  window.pbjs = {que: [() => {
    for (const name of ['pubmatic', 'openx']) window.pbjs.registerBidAdapter(null, name, {
      code: name, supportedMediaTypes: ['banner'], isBidRequestValid: () => true,
      buildRequests(bids) {
        return {method: 'GET', url: '%BID%', options: {withCredentials: false}, data: {payload: JSON.stringify(bids.flatMap(bid => {
          const round = (rounds.get(name + ':' + bid.adUnitCode) || 0) + 1;
          rounds.set(name + ':' + bid.adUnitCode, round);
          const size = bid.mediaTypes.banner.sizes.find(item => Array.isArray(item) && item[0] > 1);
          return (script[name][round - 1] || []).map(cpm => ({requestId: bid.bidId, ttl: 120, width: size[0], height: size[1], round, cpm}));
        }))}};
      },
      interpretResponse: response => response.body.bids,
    });
  }]};
})();
