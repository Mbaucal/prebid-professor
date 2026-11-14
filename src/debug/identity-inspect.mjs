// Deliberately allow-listed output. Never log ID values, hashes, provider params,
// consent strings, complete events, storage values, or request payloads.
export function inspectIdentity(win, scope = {}) {
  const pb = win.pbjs;
  if (!pb || typeof pb.getConfig !== 'function') return {status:'Prebid is not active on this page.'};
  const sourceName = value => typeof value === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? value : '(unrecognized source)';
  const summarize = eids => {
    if (!Array.isArray(eids)) return {observable:false,sources:[]};
    const sources = new Map();
    for (const eid of eids) {
      if (!eid || typeof eid !== 'object') continue;
      const source=sourceName(eid.source);
      const row=sources.get(source)||{source,usableIds:0,placeholderIds:0};
      for (const uid of Array.isArray(eid.uids)?eid.uids:[]) {
        const id=uid?.id;
        if (id===0||id==='0') row.placeholderIds++;
        else if (typeof id==='string'&&id.trim()) row.usableIds++;
      }
      sources.set(source,row);
    }
    return {observable:true,sources:Array.from(sources.values()).sort((a,b)=>a.source.localeCompare(b.source))};
  };
  const config=pb.getConfig('userSync')||{};
  const installed=Array.isArray(pb.installedModules)?pb.installedModules:[];
  const names=['id5Id','sharedId','criteo','teadsId','lotamePanoramaId'];
  const modules=(Array.isArray(config.userIds)?config.userIds:[]).map(item=>({
    name:names.includes(item.name)?item.name:'Other configured provider',
    preSuppliedValue:Boolean(item.value),
    storageType:['html5','cookie','cookie&html5'].includes(item.storage?.type)?item.storage.type:null,
    refreshInSeconds:Number.isFinite(item.storage?.refreshInSeconds)?item.storage.refreshInSeconds:null,
    externalModuleConfigured:Boolean(item.params?.externalModuleUrl),
    bidderRestricted:Array.isArray(item.bidders)&&item.bidders.length>0,
    id5RefreshWarning:item.name==='id5Id'&&Boolean(item.storage)&&!(item.storage.refreshInSeconds>0&&item.storage.refreshInSeconds<=7200),
  }));
  const requests=[];
  const history=typeof pb.getEvents==='function'?pb.getEvents():[];
  for (const event of Array.isArray(history)?history:[]) {
    if (event.eventType!=='bidRequested') continue;
    const request=event.args||{};
    for (const bid of Array.isArray(request.bids)?request.bids:[]) {
      const position=bid.adUnitCode||bid.code;
      const bidder=bid.bidder||request.bidderCode;
      if(scope.adUnit&&scope.adUnit!==position||scope.bidder&&scope.bidder!==bidder) continue;
      requests.push({position,bidder,auction:request.auctionId||null,
        eidMetadata:summarize(bid.userIdAsEids),
        ortbMetadata:summarize(bid.ortb2?.user?.ext?.eids||request.ortb2?.user?.ext?.eids)});
    }
  }
  const latest=new Map();
  requests.forEach(row=>latest.set(JSON.stringify([row.position,row.bidder]),row));
  const report={
    status:'Metadata snapshot; not proof of SSP transmission or revenue.',
    installed:{userId:installed.includes('userId'),id5IdSystem:installed.includes('id5IdSystem')},
    auctionDelay:Number.isFinite(config.auctionDelay)?config.auctionDelay:null,
    modules,
    current:summarize(typeof pb.getUserIdsAsEids==='function'?pb.getUserIdsAsEids():null),
    retainedRequestCount:requests.length,
    firstRetainedRequests:requests.filter(row=>row.auction===requests[0]?.auction),
    latestRequests:Array.from(latest.values()),
    notes:['Only retained events are available; the first retained auction may not be the first page auction.',
      'Compare current identity with first and latest requests. IDs arriving later cannot enrich an earlier request.',
      'An absent ID does not identify the cause. Check consent, provider response and module timing separately.',
      'Verify serialized SSP requests separately. No ID values or hashes are included.'],
  };
  return report;
}

export function identityInspectCommand(scope={}) {
  return `(function(){var report=(${inspectIdentity.toString()})(window,${JSON.stringify({adUnit:scope.adUnit||'',bidder:scope.bidder||''})});console.info('[Tessera] Identity / EID presence');console.log(report);return report;})();`;
}
