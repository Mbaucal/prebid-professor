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
      detach(active);invalidate();
      const record = active = {api,live:true,id:null,removed:new Set(),generation:++generation};
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
  facade.__tcfapi = (command,version,fn) => {
    if (command !== 'addEventListener' || callback || disposed) return;
    callback=fn;poll();
  };
  return {facade, snapshot:()=>({...metrics,generation,pendingTimer:timer!==null,disposed}),
    dispose() { if(disposed)return;disposed=true;host.clearTimeout(timer);timer=null;detach(active);invalidate();callback=null;active=null; }};
}
