/* Offline page for running a whole generated ads.js in node:vm.
 *
 * The page has a fake clock, a small DOM, GPT that records every GAM request
 * with the slot targeting it carried, a TCF CMP the test drives, and a Prebid
 * fake that follows Prebid 11.34 bid cache semantics:
 *  - getBidsReceived keeps a bid of an earlier auction only when useBidCache is
 *    true and bidCacheFilterFunction (if set) returns true for it; bids of the
 *    position's latest auction are always kept;
 *  - a bid is usable while responseTimestamp + 1000 * (ttl - 1) > now and its
 *    status is not 'rendered';
 *  - targeting keeps one bid per bidder per position, as getHighestDesirability:
 *    the highest CPM, then the lower timeToRespond, then the earlier bid in the
 *    pool; then, as getAllTargeting, only bids with a CPM above 0 or, with
 *    targetingControls.alwaysIncludeDeals, deal bids at any CPM. The overall
 *    winner gets hb_*, send-all-bids adds hb_*_<bidder>, and deal bids carry
 *    hb_deal / hb_deal_<bidder>; keys are cut to 20 characters;
 *  - presetGPTTargeting (unless false) clears the slots' Prebid keys at auctionInit;
 *  - bidRequested carries the consent data the CMP gave, as Prebid collects it:
 *    gdprConsent with consentManagementTcf; uspConsent only with
 *    consentManagementUsp installed; gppConsent only with consentManagementGpp
 *    installed and consentManagement.gpp not disabled (Tessera disables it).
 * No network, storage or real ad library is used.
 */
import vm from 'node:vm';

const settle = () => new Promise(resolve => setImmediate(resolve));

export function fakeClock(start = 1_700_000_000_000) {
  let now = start, next = 0;
  const pending = new Map();
  const add = (fn, ms, every) => { pending.set(++next, {fn, at: now + Math.max(0, Number(ms) || 0), every}); return next; };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: id => { pending.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 1)), clearInterval: id => { pending.delete(id); },
    /** Runs every timer due within ms, in time order, letting promise callbacks
     * settle after each one, then sets the clock to the end. */
    async tick(ms = 0) {
      const end = now + ms;
      await settle();
      for (let guard = 0; guard < 200000; guard++) {
        let due = null;
        for (const [id, timer] of pending) if (timer.at <= end && (!due || timer.at < due[1].at || (timer.at === due[1].at && id < due[0]))) due = [id, timer];
        if (!due) break;
        now = due[1].at;
        if (due[1].every) due[1].at = now + due[1].every; else pending.delete(due[0]);
        due[1].fn();
        await settle();
      }
      now = end;
    },
  };
}

const TARGETING_KEYS = ['hb_bidder', 'hb_adid', 'hb_pb', 'hb_size', 'hb_deal', 'hb_format', 'hb_source'];
const cut = key => key.slice(0, 20);

/**
 * options.respond(auction) returns the bids of one auction:
 * [{code, bidder, cpm, width, height, ttl = 300, dealId, mediaType = 'banner'}].
 * options.mode: 'full' (default), 'no-filter' (accepts the setting, ignores the
 * function), 'no-cache' (drops both settings), 'no-getconfig' (no getConfig API).
 * options.modules: Prebid modules installed besides consentManagementTcf and the two adapters.
 */
export function fakePrebid(clock, {respond = () => [], latencyMs = 50, mode = 'full', version = 'v11.34.0', consent = () => ({}), modules = []} = {}) {
  const handlers = new Map(), bids = [], auctions = [], latest = Object.create(null), log = [];
  let config = {useBidCache: false, targetingControls: {}}, sequence = 0;
  const emit = (name, event) => { for (const fn of [...(handlers.get(name) || [])]) fn(event); };
  const usable = bid => bid.responseTimestamp + 1000 * (bid.ttl - 1) > clock.now() && bid.status !== 'rendered';
  function received() {
    return bids.filter(bid => {
      const isLatest = latest[bid.adUnitCode] === bid.auctionId;
      const filter = config.bidCacheFilterFunction, useCache = config.useBidCache === true;
      const allowed = !(useCache && !isLatest && typeof filter === 'function' && mode !== 'no-filter') || !!filter(bid);
      return (useCache || isLatest) && allowed && usable(bid);
    });
  }
  // Prebid's reducers keep the current bid unless the next one is strictly better.
  const better = (next, current) => next.cpm > current.cpm || (next.cpm === current.cpm && next.timeToRespond < current.timeToRespond);
  function bestPerBidder(list) {
    const best = new Map();
    for (const bid of list) {
      const current = best.get(bid.bidderCode);
      if (!current || better(bid, current)) best.set(bid.bidderCode, bid);
    }
    return [...best.values()];
  }
  const targetable = bid => bid.cpm > 0 || ((config.targetingControls || {}).alwaysIncludeDeals === true && !!bid.dealId);
  function targetingFor(code, pool = received()) {
    const top = bestPerBidder(pool.filter(bid => bid.adUnitCode === code)).filter(targetable);
    if (!top.length) return {};
    const winner = top.reduce((a, b) => (better(b, a) ? b : a));
    const out = {};
    const keys = bid => ({hb_bidder: bid.bidderCode, hb_adid: bid.adId, hb_pb: bid.cpm.toFixed(2), hb_size: `${bid.width}x${bid.height}`,
      hb_format: bid.mediaType, hb_source: 'client', ...(bid.dealId ? {hb_deal: bid.dealId} : {})});
    Object.assign(out, keys(winner));
    if (config.enableSendAllBids !== false) for (const bid of top) for (const [key, value] of Object.entries(keys(bid))) out[cut(`${key}_${bid.bidderCode}`)] = value;
    return out;
  }
  function consentFields() {
    const data = consent() || {}, fields = {};
    if (data.gdpr) fields.gdprConsent = {...data.gdpr, vendorData: {large: 'object'}, apiVersion: 2};
    if (data.usp !== undefined && pb.installedModules.includes('consentManagementUsp')) fields.uspConsent = data.usp;
    const gpp = (config.consentManagement || {}).gpp;
    if (data.gpp && pb.installedModules.includes('consentManagementGpp') && !(gpp && gpp.enabled === false)) fields.gppConsent = {...data.gpp, parsedSections: {}};
    return fields;
  }
  const pb = {
    version, que: {push: fn => fn()}, installedModules: ['consentManagementTcf', 'pubmaticBidAdapter', 'openxBidAdapter', ...modules], bidderSettings: {}, adUnits: [],
    setConfig(value) {
      log.push(value);
      for (const [key, item] of Object.entries(value || {})) {
        if (mode === 'no-cache' && (key === 'useBidCache' || key === 'bidCacheFilterFunction')) continue;
        config[key] = item;
      }
    },
    onEvent(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    offEvent(name, fn) { const list = handlers.get(name) || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
    getEvents: () => [], removeAdUnit() {}, getUserIdsAsync: () => Promise.resolve({}), getUserIds: () => ({}),
    requestBids(request) {
      const id = request.auctionId || `pb-auction-${++sequence}`;
      const units = request.adUnits || [], codes = units.map(unit => unit.code);
      const auction = {id, codes, units, index: auctions.length, at: clock.now(), consent: consentFields(), timeout: request.timeout};
      auctions.push(auction);
      for (const code of codes) latest[code] = id;
      emit('auctionInit', {auctionId: id, adUnitCodes: codes.slice(), adUnits: units, timeout: request.timeout});
      if ((config.targetingControls || {}).presetGPTTargeting !== false) {
        auction.preset = true;
        for (const slot of (globalThis.__bidCachePage?.gptSlots() || [])) if (codes.includes(slot.getSlotElementId())) slot.clearPrebid();
      }
      const bidders = [...new Set(units.flatMap(unit => (unit.bids || []).map(bid => bid.bidder)))];
      for (const bidder of bidders) emit('bidRequested', {auctionId: id, bidderCode: bidder, bids: [], ...auction.consent});
      clock.setTimeout(() => {
        const fresh = (respond(auction) || []).filter(bid => codes.includes(bid.code)).map(bid => ({
          adUnitCode: bid.code, bidderCode: bid.bidder, bidder: bid.bidder, cpm: bid.cpm, width: bid.width ?? 300, height: bid.height ?? 250,
          ttl: bid.ttl ?? 300, mediaType: bid.mediaType ?? 'banner', dealId: bid.dealId, auctionId: id, adId: `ad-${auction.index}-${bid.code}-${bid.bidder}-${bid.cpm}`,
          responseTimestamp: clock.now(), requestTimestamp: auction.at, timeToRespond: bid.timeToRespond ?? clock.now() - auction.at, netRevenue: true, currency: 'EUR', status: undefined, adserverTargeting: {}}));
        for (const bid of fresh) { bids.push(bid); emit('bidResponse', bid); }
        emit('auctionEnd', {auctionId: id, adUnitCodes: codes});
        const grouped = {};
        for (const code of codes) grouped[code] = {bids: fresh.filter(bid => bid.adUnitCode === code)};
        if (typeof request.bidsBackHandler === 'function') request.bidsBackHandler(grouped, false, id);
      }, latencyMs);
    },
    getAdserverTargetingForAdUnitCode: code => targetingFor(code),
    getBidResponses() { const out = {}; for (const bid of bids) (out[bid.adUnitCode] ||= {bids: []}).bids.push(bid); return out; },
    getHighestCpmBids: code => bestPerBidder(received().filter(bid => bid.adUnitCode === code)),
    renderAd(doc, adId) {
      const bid = bids.find(item => item.adId === adId);
      if (!bid || bid.status === 'rendered') return;
      bid.status = 'rendered'; emit('bidWon', bid);
    },
  };
  if (mode !== 'no-getconfig') {
    pb.getConfig = key => {
      if (key === undefined) return {...config};
      return String(key).split('.').reduce((value, part) => (value == null ? undefined : value[part]), config);
    };
  }
  return {pb, bids, auctions, latest, log, config: () => config, received, targetingFor};
}

class FakeElement {
  constructor(doc, tag, id = '') {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.nodeType = 1;
    this.id = id; this.children = []; this.parentNode = null; this.style = {}; this.dataset = {}; this.attrs = new Map(); this.listeners = new Map();
    this.className = ''; this.textContent = ''; this.innerHTML = '';
    const element = this;
    this.classList = {
      add: (...names) => { const set = new Set(element.className.split(/\s+/).filter(Boolean)); names.forEach(n => set.add(n)); element.className = [...set].join(' '); },
      remove: (...names) => { element.className = element.className.split(/\s+/).filter(n => n && !names.includes(n)).join(' '); },
      contains: name => element.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const on = force ?? !element.classList.contains(name); if (on) element.classList.add(name); else element.classList.remove(name); return on; },
    };
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get offsetWidth() { return 300; } get offsetHeight() { return 250; } get clientWidth() { return 300; } get clientHeight() { return 250; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.documentElement; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); if (key === 'id') this.id = String(value); if (key === 'class') this.className = String(value); }
  getAttribute(key) { return key === 'class' ? this.className : this.attrs.has(key) ? this.attrs.get(key) : null; }
  hasAttribute(key) { return this.attrs.has(key); }
  removeAttribute(key) { this.attrs.delete(key); }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, ref) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, child); return child; }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
  removeEventListener(name, fn) { const list = this.listeners.get(name) || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
  dispatchEvent() { return true; }
  getBoundingClientRect() { const top = this.top ?? 0; return {top, bottom: top + 250, left: 0, right: 300, width: 300, height: 250, x: 0, y: top}; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector) {
    return selector.split(',').map(s => s.trim()).some(part => {
      if (part.startsWith('#')) return this.id === part.slice(1);
      if (part.startsWith('.')) return part.slice(1).split('.').every(name => this.classList.contains(name));
      const attribute = part.match(/^([a-z]*)\[([^=\]]+)(?:="?([^"\]]*)"?)?\]$/i);
      if (attribute) return (!attribute[1] || this.tagName === attribute[1].toUpperCase()) && this.hasAttribute(attribute[2]) && (attribute[3] === undefined || this.getAttribute(attribute[2]) === attribute[3]);
      return this.tagName === part.toUpperCase();
    });
  }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { let node = this; while (node && node.nodeType === 1) { if (node.matches(selector)) return node; node = node.parentNode; } return null; }
  contains(other) { let node = other; while (node) { if (node === this) return true; node = node.parentNode; } return false; }
}

/**
 * Runs one generated ads.js on a fresh page. containers: ad container ids in the page HTML.
 * cmp: TCF answers come only from page.consent(...). Every GAM request is recorded with the
 * Prebid keys of each slot at that moment in page.requests.
 */
export function bidCachePage(source, {containers = ['Billboard', 'P1'], width = 1280, height = 900, respond, mode, latencyMs, modules, prebid = true, keywords = {category: 'Sports'}} = {}) {
  const clock = fakeClock(), requests = [], errors = [], fetches = [], gptSlots = [];
  const doc = {readyState: 'complete', visibilityState: 'visible', hidden: false, referrer: '', cookie: '', listeners: new Map(),
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); },
    removeEventListener(name, fn) { const list = this.listeners.get(name) || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
    hasFocus: () => true};
  doc.createElement = tag => new FakeElement(doc, tag);
  doc.createTextNode = text => ({nodeType: 3, textContent: text, descendants: () => [], matches: () => false});
  doc.documentElement = new FakeElement(doc, 'html');
  doc.head = doc.documentElement.appendChild(new FakeElement(doc, 'head'));
  doc.body = doc.documentElement.appendChild(new FakeElement(doc, 'body'));
  doc.activeElement = doc.body;
  containers.forEach((id, index) => { const node = new FakeElement(doc, 'div', id); node.className = 'wrapperAd'; node.top = index * 300; doc.body.appendChild(node); });
  doc.getElementById = id => doc.documentElement.descendants().find(node => node.id === id) || null;
  doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
  doc.querySelector = selector => doc.documentElement.querySelector(selector);
  doc.getElementsByTagName = tag => doc.documentElement.querySelectorAll(tag);

  // GPT: one service; refresh records the request with each slot's Prebid keys.
  const gptListeners = new Map(), pageTargeting = new Map();
  const gptEmit = (name, event) => { for (const fn of [...(gptListeners.get(name) || [])]) fn(event); };
  function slot(path, sizes, id) {
    const targeting = new Map();
    const value = {path, sizes, id, targeting,
      addService() { return this; }, defineSizeMapping() { return this; }, setCollapseEmptyDiv() { return this; },
      setConfig(config) { for (const [key, item] of Object.entries((config && config.targeting) || {})) targeting.set(key, [].concat(item).map(String)); return this; },
      setTargeting(key, item) { targeting.set(key, [].concat(item).map(String)); return this; },
      updateTargetingFromMap(map) { for (const [key, item] of Object.entries(map)) targeting.set(key, [].concat(item).map(String)); return this; },
      getTargeting: key => [...(targeting.get(key) || [])], getTargetingKeys: () => [...targeting.keys()],
      clearTargeting(key) { if (key === undefined) targeting.clear(); else targeting.delete(key); return this; },
      clearPrebid() { for (const key of [...targeting.keys()]) if (/^hb_/.test(key)) targeting.delete(key); },
      getSlotElementId: () => id, getAdUnitPath: () => path, getSizes: () => sizes, getResponseInformation: () => null,
      getHtml: () => '', getDomId: () => id};
    gptSlots.push(value);
    return value;
  }
  const service = {
    addEventListener(name, fn) { if (!gptListeners.has(name)) gptListeners.set(name, []); gptListeners.get(name).push(fn); return this; },
    removeEventListener() { return true; }, enableSingleRequest() { return true; }, collapseEmptyDivs() {}, setCentering() {}, disableInitialLoad() {},
    setPrivacySettings() {}, setPublisherProvidedId() {}, getSlots: () => gptSlots.slice(), updateCorrelator() {},
    getTargeting: key => [...(pageTargeting.get(key) || [])], getTargetingKeys: () => [...pageTargeting.keys()],
    setTargeting(key, item) { pageTargeting.set(key, [].concat(item).map(String)); return this; }, clearTargeting(key) { pageTargeting.delete(key); return this; },
    refresh(list) {
      for (const item of list || []) {
        const keys = Object.fromEntries([...item.targeting].filter(([key]) => /^hb_/.test(key)).map(([key, value]) => [key, value.slice()]));
        requests.push({code: item.getSlotElementId(), at: clock.now(), keys});
        gptEmit('slotRequested', {slot: item});
        clock.setTimeout(() => {
          gptEmit('slotResponseReceived', {slot: item});
          gptEmit('slotRenderEnded', {slot: item, isEmpty: false, size: [300, 250], lineItemId: 1, creativeId: 2, advertiserId: 3});
          gptEmit('slotOnload', {slot: item});
          gptEmit('impressionViewable', {slot: item});
        }, 20);
      }
    },
  };
  const googletag = {apiReady: true, pubadsReady: true, cmd: {push: fn => { fn(); return 1; }}, pubads: () => service, companionAds: () => service,
    enableServices() {}, setConfig() {}, destroySlots(list) { for (const item of list || []) { const i = gptSlots.indexOf(item); if (i >= 0) gptSlots.splice(i, 1); } return true; },
    enums: {OutOfPageFormat: {INTERSTITIAL: 5, BOTTOM_ANCHOR: 3, TOP_ANCHOR: 2}},
    sizeMapping() { const rows = []; return {addSize(v, s) { rows.push([v, s]); return this; }, build: () => rows}; },
    defineSlot: (path, sizes, id) => slot(path, sizes, id), defineOutOfPageSlot: (path, format) => slot(path, [1, 1], typeof format === 'string' ? format : 'gpt_out_of_page_' + gptSlots.length),
    display() {}};

  // TCF: the test answers through page.consent().
  let cmpListeners = [], tcData = null;
  const tcfapi = (command, version, callback) => {
    if (command === 'addEventListener') { cmpListeners.push(callback); if (tcData) callback({...tcData, listenerId: cmpListeners.length}, true); }
    else if (command === 'getTCData') callback(tcData ? {...tcData} : {cmpStatus: 'loading'}, !!tcData);
    else if (command === 'ping') callback({cmpLoaded: true, gdprApplies: tcData ? tcData.gdprApplies : undefined}, true);
    else if (typeof callback === 'function') callback(null, false);
  };
  let privacy = {usp: undefined, gpp: undefined};
  const pbState = prebid ? fakePrebid(clock, {respond, mode, latencyMs, modules, consent: () => ({
    gdpr: tcData && tcData.eventStatus !== 'cmpuishown' ? {gdprApplies: tcData.gdprApplies, consentString: tcData.tcString, addtlConsent: tcData.addtlConsent} : null,
    usp: privacy.usp, gpp: privacy.gpp})}) : null;

  class IntersectionObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = []; }
    observe(target) { this.targets.push(target); clock.setTimeout(() => { if (this.targets.includes(target)) this.callback([{target, isIntersecting: true, intersectionRatio: 1,
      boundingClientRect: target.getBoundingClientRect(), intersectionRect: target.getBoundingClientRect(), rootBounds: {top: 0, bottom: height, left: 0, right: width, width, height}, time: clock.now()}], this); }, 0); }
    unobserve(target) { this.targets = this.targets.filter(item => item !== target); }
    disconnect() { this.targets = []; }
    takeRecords() { return []; }
  }
  class MutationObserver { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } }

  const win = {innerWidth: width, innerHeight: height, outerWidth: width, outerHeight: height, devicePixelRatio: 1, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
    location: {href: 'https://bidcache.example.invalid/article', hostname: 'bidcache.example.invalid', protocol: 'https:', search: '', pathname: '/article', hash: '', origin: 'https://bidcache.example.invalid'},
    navigator: {userAgent: 'node-vm', language: 'en', languages: ['en'], sendBeacon: () => true, cookieEnabled: false},
    screen: {width, height}, document: doc, googletag, __tcfapi: tcfapi, adsKeywords: keywords,
    console: {log() {}, info() {}, debug() {}, warn() {}, error: (...args) => errors.push(args.map(String).join(' '))},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    requestAnimationFrame: fn => clock.setTimeout(() => fn(clock.now()), 16), cancelAnimationFrame: id => clock.clearTimeout(id),
    requestIdleCallback: fn => clock.setTimeout(() => fn({timeRemaining: () => 10, didTimeout: false}), 1),
    matchMedia: query => ({matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}),
    getComputedStyle: () => ({getPropertyValue: () => '', display: 'block', visibility: 'visible', position: 'static', height: '250px'}),
    IntersectionObserver, MutationObserver, ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    fetch: (url) => { fetches.push(String(url)); return new Promise(() => {}); },
    performance: {now: () => clock.now() - 1_700_000_000_000, mark() {}, measure() {}, getEntriesByName: () => []},
    listeners: new Map(),
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); },
    removeEventListener(name, fn) { const list = this.listeners.get(name) || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
    dispatchEvent() { return true; }, postMessage() {}, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Event: class { constructor(type) { this.type = type; } }};
  if (pbState) win.pbjs = pbState.pb;
  win.window = win; win.self = win; win.top = win; win.parent = win; win.globalThis = win;
  const FakeDate = class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now()])); } static now() { return clock.now(); } };
  const context = vm.createContext(win);
  Object.assign(context, {Date: FakeDate});
  const page = {
    clock, requests, errors, fetches, context, document: doc, googletag, service, gptSlots: () => gptSlots.slice(), prebid: pbState,
    run() { vm.runInContext(source, context, {filename: 'ads.js'}); return page; },
    /** A TCF decision; gdprApplies true needs a tcString. */
    consent(data, success = true) { tcData = data; for (const fn of cmpListeners.slice()) fn({...data}, success); },
    privacy(next) { privacy = {...privacy, ...next}; },
    // Copied into this realm as plain JSON, as a page script would read them.
    snapshot: () => context.__tesseraBidCache ? JSON.parse(JSON.stringify(context.__tesseraBidCache.snapshot())) : undefined,
    readiness: () => context.__tesseraReadiness ? JSON.parse(JSON.stringify(context.__tesseraReadiness.snapshot())) : undefined,
    requestsFor: code => requests.filter(item => item.code === code),
    /** GAM chose the Prebid line item of the request's hb_adid: Prebid renders it. */
    render(request) { const id = request.keys.hb_adid && request.keys.hb_adid[0]; if (id && pbState) pbState.pb.renderAd({}, id); },
  };
  globalThis.__bidCachePage = page;
  return page;
}

export const decided = (tcString = 'synthetic-tc-a', extra = {}) => ({gdprApplies: true, cmpStatus: 'loaded', eventStatus: 'useractioncomplete', tcString,
  addtlConsent: '1~', purpose: {consents: {1: true, 2: true, 3: true, 4: true, 7: true}, legitimateInterests: {}}, vendor: {consents: {}, legitimateInterests: {}}, ...extra});
