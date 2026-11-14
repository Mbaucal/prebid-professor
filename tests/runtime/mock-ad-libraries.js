(() => {
  const slots = [];
  const listeners = new Map();
  const observations = { requests: [], bids: [], configs: [], privacy: [], displays: [], destroys: [] };
  const options = window.__testOptions || {};
  const emit = (type, event) => { for (const cb of [...(listeners.get(type) || [])]) cb(event); };
  const service = {
    addEventListener(type, cb) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(cb); return this; },
    removeEventListener(type, cb) { listeners.get(type)?.delete(cb); return this; },
    getSlots() { return [...slots]; },
    getTargeting() { return []; }, setTargeting() {},
    collapseEmptyDivs() {}, setCentering() {}, disableInitialLoad() {}, enableSingleRequest() {},
    setPrivacySettings(value) { observations.privacy.push(value); }, setPublisherProvidedId() {},
    refresh(list) {
      for (const slot of list || []) {
        observations.requests.push({ id: slot.id, path: slot.path, sizes: slot.sizes, at: Date.now() });
        emit('slotRequested', { slot });
        const takeover = slot.id === 'adsx-takeover-slot';
        if (takeover && options.takeoverResult === 'timeout') continue;
        setTimeout(() => {
          if (!slots.includes(slot)) return;
          let size = Array.isArray(slot.sizes[0]) ? slot.sizes[0] : slot.sizes;
          if (slot.mapping) {
            const map = [...slot.mapping].sort((a, b) => b.viewport[0] - a.viewport[0]);
            const row = map.find((r) => innerWidth >= r.viewport[0] && innerHeight >= r.viewport[1]);
            if (row?.sizes?.length) size = row.sizes[0];
          }
          const isEmpty = options.allEmpty === true || (takeover && options.takeoverResult === 'empty');
          if (takeover && options.takeoverResult === 'wrong-size') size = [1, 1];
          const host = document.getElementById(slot.id);
          if (host && !isEmpty) {
            const frame = document.createElement('iframe');
            frame.width = String(size[0]); frame.height = String(size[1]);
            frame.style.border = '0'; frame.title = 'Local test creative — no advertiser';
            frame.srcdoc = '<!doctype html><html><body style="margin:0;background:#ffe6cd;display:grid;place-items:center;height:100vh;font:20px Arial">TEST CREATIVE</body></html>';
            host.querySelectorAll('iframe').forEach((item) => item.remove()); host.appendChild(frame);
          }
          emit('slotResponseReceived', { slot });
          emit('slotRenderEnded', { slot, isEmpty, size, lineItemId: 1, creativeId: 2, advertiserId: 3 });
          if (!isEmpty && !(takeover && options.omitOnload)) emit('slotOnload', { slot });
        }, 10);
      }
    },
  };
  function makeSlot(path, sizes, id) {
    const slot = {
      id, path, sizes, targeting: {}, mapping: null,
      addService() { return this; },
      setConfig(config) { Object.assign(this.targeting, config.targeting || {}); return this; },
      getConfig() { return { targeting: this.targeting }; },
      setTargeting(key, value) { this.targeting[key] = value; return this; },
      getTargeting(key) { const v = this.targeting[key]; return v == null ? [] : Array.isArray(v) ? v : [String(v)]; },
      getTargetingKeys() { return Object.keys(this.targeting); },
      clearTargeting(key) { delete this.targeting[key]; },
      getAdUnitPath() { return path; }, getSlotElementId() { return id; }, getSizes() { return sizes; },
      getResponseInformation() { return { lineItemId: 1, creativeId: 2, advertiserId: 3 }; },
      defineSizeMapping(mapping) { this.mapping = mapping; return this; },
    };
    slots.push(slot); return slot;
  }
  // GPT fills the existing command-queue object; wrappers may retain its reference.
  window.googletag = Object.assign(window.googletag || {}, {
    cmd: { push(callback) { callback(); } }, enums: { OutOfPageFormat: { INTERSTITIAL: 1 } },
    pubads: () => service, enableServices() {}, setConfig() {},
    sizeMapping() { const list = []; return { addSize(viewport, sizes) { list.push({ viewport, sizes }); return this; }, build() { return list; } }; },
    defineSlot(path, sizes, id) { if (id === 'adsx-takeover-slot' && options.takeoverResult === 'define-null') return null; return makeSlot(path, sizes, id); },
    defineOutOfPageSlot(path) { if (slots.some((s) => s.id === 'interstitial-guard')) return null; return makeSlot(path, [1, 1], 'interstitial-guard'); },
    display(slot) { observations.displays.push(typeof slot === 'string' ? slot : slot.id); },
    destroySlots(list) { for (const slot of list) { const i = slots.indexOf(slot); if (i >= 0) slots.splice(i, 1); observations.destroys.push(slot.id); } return true; },
  });
  window.pbjs = {
    version: 'LOCAL-MOCK', installedModules: [], que: { push(callback) { callback(); } }, bidderSettings: {},
    onEvent() {}, getEvents() { return []; }, removeAdUnit() {}, getUserIdsAsync() { return Promise.resolve({}); },
    getAdserverTargetingForAdUnitCode() { return {}; }, getBidResponses() { return {}; },
    setConfig(config) { observations.configs.push(config); }, getConfig() { return {}; },
    requestBids(input) { observations.bids.push(JSON.parse(JSON.stringify(input))); setTimeout(() => input.bidsBackHandler(), 1); },
  };
  window.__tcfapi = (command, version, callback) => {
    if (command === 'addEventListener' || command === 'getTCData') {
      callback({ gdprApplies: false, listenerId: 1, eventStatus: 'tcloaded', cmpStatus: 'loaded' }, true);
    } else callback(true);
  };
  window.__testAds = { observations, emit, service, slots };
})();
