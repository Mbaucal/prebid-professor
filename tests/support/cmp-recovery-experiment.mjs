// EXPERIMENT ONLY. Not imported by any runtime, compiler, registry or application.
// Supply this facade only to the existing readiness helper; never replace publisher globals.
export function createCmpRecoveryExperiment(host) {
  let active = null, timer = null, disposed = false, callback = null, generation = 0;
  const metrics = {registrations:0, removals:0, staleCallbacks:0, registrationErrors:0};
  function remove(record, id) {
    if (!Number.isSafeInteger(id) || id < 0 || record.removed.has(id)) return;
    record.removed.add(id);metrics.removals++;
    try { record.api('removeEventListener', 2, () => {}, id); } catch {}
  }
  function invalidate() { if (callback) callback({}, false); }
  function detach(record) {
    if (!record) return;
    record.live = false;
    if (record.id !== null) remove(record,record.id);
  }
  function inspect() {
    if (disposed) return;
    const api = typeof host.__tcfapi === 'function' ? host.__tcfapi : null;
    if (!active || active.api !== api) {
      const previous = active;
      const record = active = {api,live:true,id:null,removed:new Set(),generation:++generation};
      detach(previous);invalidate();
      if(active!==record || (typeof host.__tcfapi==='function'?host.__tcfapi:null)!==api) { inspect();return; }
      if (api) {
        metrics.registrations++;
        try {
          api('addEventListener',2,(data,success) => {
            const id = data?.listenerId;
            if (Number.isSafeInteger(id) && id >= 0) record.id = id;
            if (disposed || !record.live || active !== record || host.__tcfapi !== record.api) {
              metrics.staleCallbacks++;remove(record,id);
              // Detection can also happen at callback delivery, before polling.
              if (!disposed && active === record && host.__tcfapi !== record.api) inspect();
              return;
            }
            if (callback) callback(data,success);
          });
        } catch {
          metrics.registrationErrors++;detach(record);invalidate();
          // A throw may happen after registration. Do not queue another listener
          // on this same function without proof the previous registration ended.
        }
      }
    }
  }
  function poll() { inspect();if(!disposed)timer=host.setTimeout(poll,250); }
  const facade = Object.create(host);
  // Scheduled readiness work must observe replacement before using cached consent.
  facade.setTimeout = (fn, ms) => host.setTimeout(() => { inspect(); if (!disposed) fn(); }, ms);
  facade.clearTimeout = id => host.clearTimeout(id);
  facade.__tcfapi = (command,version,fn) => {
    if (command !== 'addEventListener' || callback || disposed) return;
    callback=fn;poll();
  };
  function createReadiness(factory, options) {
    let gate, nativePb = null, guardedPb = null;
    const requestState = Symbol('experiment request epoch');
    const dispatchState = new WeakMap();
    Object.defineProperty(facade,'pbjs',{get() {
      if (nativePb === host.pbjs) return guardedPb;
      nativePb=host.pbjs;
      if (!nativePb) return guardedPb=nativePb;
      const pb=nativePb;guardedPb=Object.create(pb);
      guardedPb.getAdserverTargetingForAdUnitCode=(...args)=>{
        inspect();const before=generation,epoch=gate.snapshot().consent.epoch;
        const values=pb.getAdserverTargetingForAdUnitCode(...args);
        inspect();
        return !disposed && generation===before && gate.snapshot().consent.ready && gate.snapshot().consent.epoch===epoch ? values : {};
      };
      return guardedPb;
    }});
    const wrappedOptions = {...options,
      alive(slot) {
        inspect();
        dispatchState.set(slot,{generation,epoch:gate.snapshot().consent.epoch});
        return !options.alive || options.alive(slot);
      },
      rawRequest(pb, input) {
        const epoch = gate.snapshot().consent.epoch;
        if(input[requestState])input[requestState].epoch=epoch;
        inspect();
        if (disposed || !gate.snapshot().consent.ready || gate.snapshot().consent.epoch !== epoch) return;
        const guarded = Object.create(pb);
        guarded.requestBids = next => {
          inspect();
          if (disposed || !gate.snapshot().consent.ready || gate.snapshot().consent.epoch !== epoch) return;
          const callback = next.bidsBackHandler;
          return pb.requestBids({...next,bidsBackHandler(...args) {
            inspect();
            if (!disposed) return callback?.apply(this,args);
          }});
        };
        return options.rawRequest(guarded,input);
      },
      rawDispatch(service, slots, settings) {
        inspect();
        if (disposed) return;
        const consent=gate.snapshot().consent;
        const current=slots.every(slot=>{const state=dispatchState.get(slot);return state && state.generation===generation && state.epoch===consent.epoch;});
        if (!current || !consent.ready) {
          gate.dispatch(service,slots,settings);return;
        }
        return options.rawDispatch(service,slots,settings);
      }
    };
    gate = factory(facade,wrappedOptions);
    return Object.fromEntries(Object.entries(gate).map(([name,fn]) => [name,(...args) => {
      inspect();
      if (disposed && name !== 'snapshot' && name !== 'targeting') return;
      if(name==='request') {
        const [pb,input]=args,state={epoch:null},callback=input.bidsBackHandler;
        return fn(pb,{...input,[requestState]:state,bidsBackHandler(...values) {
          inspect();
          if(disposed)return;
          const current=gate.snapshot().consent;
          return callback?.(...(current.ready && current.epoch===state.epoch ? values : [undefined,undefined,undefined]));
        }});
      }
      return fn(...args);
    }]));
  }
  return {facade, createReadiness, snapshot:()=>({...metrics,generation,pendingTimer:timer!==null,disposed}),
    dispose() { if(disposed)return;disposed=true;host.clearTimeout(timer);timer=null;detach(active);invalidate();callback=null;active=null; }};
}
