import {OUTSTREAM_PILOT, OUTSTREAM_FORMATS} from './catalog.mjs';
const fail = message => { throw Object.assign(new Error(message), {status:422}); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid ${label} fields.`);
}
export function hasEnabledOutstream(config) {
  return Object.values(config?.runtimeControls?.outstream?.units ?? {}).some(value => value?.format !== 'banner');
}
/** Validate saved intent independently of renderer execution; no implied activation. */
export function normalizeOutstream(value = {schemaVersion:1,units:{}}, context) {
  keys(value,['schemaVersion','units'],'outstream');
  if(value.schemaVersion!==1 || !record(value.units)) fail('Unsupported outstream settings version.');
  const units = {};
  for(const [code,raw] of Object.entries(value.units)) {
    if(!/^[A-Za-z][A-Za-z0-9_:-]*$/.test(code) || ['constructor','prototype','__proto__'].includes(code)) fail('Invalid outstream position.');
    const unit=context.units.find(item=>item.code===code);
    keys(raw,['format','playerSize','minDuration','maxDuration','playbackMethod','placement','plcmt','partner','cacheUrl'],code);
    if(!OUTSTREAM_FORMATS.includes(raw.format)) fail(`${code}: choose Banner, Outstream or Banner + Outstream.`);
    if(raw.format==='banner') continue;
    if(!unit || unit.media_type!=='banner' || unit.type==='DRAFT') fail(`${code}: choose an existing banner position.`);
    if(context.enablePrebid!==true) fail('Enable Prebid before enabling outstream.');
    if(context.prebidVersion!==OUTSTREAM_PILOT.prebidVersion || !context.modules.includes(OUTSTREAM_PILOT.module)) fail('This pilot requires the checked Prebid 11.34.0 build with PubMatic.');
    if(context.blockedCodes?.includes(code)) fail(`${code}: outstream cannot use sticky or TakeOver positions.`);
    if(!unit.enabled) fail(`${code}: enable this position before enabling outstream.`);
    if(!Array.isArray(raw.playerSize)||raw.playerSize.length!==2||!raw.playerSize.every(n=>Number.isInteger(n)&&n>=144&&n<=1920)) fail(`${code}: player width and height must be 144–1920 pixels.`);
    const map=context.maps?.find(row=>row.name===unit.size_map_key);
    let rows;try{rows=JSON.parse(map?.map_json??'null');}catch{rows=null;}
    if(!Array.isArray(rows)||!rows.some(row=>Array.isArray(row.sizes)&&row.sizes.length)||rows.some(row=>!Array.isArray(row.sizes)||row.sizes.length&&!row.sizes.some(size=>Array.isArray(size)&&size.length===2&&size.every((n,index)=>n===raw.playerSize[index]))))
      fail(`${code}: add ${raw.playerSize[0]}×${raw.playerSize[1]} to this position’s size map at each enabled breakpoint or choose a matching player size.`);
    if(!Number.isInteger(raw.minDuration)||!Number.isInteger(raw.maxDuration)||raw.minDuration<1||raw.maxDuration<raw.minDuration||raw.maxDuration>120) fail(`${code}: choose valid durations between 1 and 120 seconds.`);
    if(raw.playbackMethod!==2 || raw.placement!==3 || raw.plcmt!==4) fail(`${code}: this pilot supports muted autoplay standalone outstream only.`);
    keys(raw.partner,['bidder','adapter','outstreamAU','activationConfirmed'],'outstream partner');
    const p=raw.partner;
    if(p.adapter!=='pubmatic'||p.bidder!=='pubmatic'||!context.bidders.some(b=>b.bidder==='pubmatic'&&b.enabled===1)) fail(`${code}: enable the verified PubMatic adapter. Aliases are not supported by this pilot.`);
    if(typeof p.outstreamAU!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(p.outstreamAU)) fail(`${code}: enter the renderer ID supplied by PubMatic.`);
    if(p.activationConfirmed!==true) fail(`${code}: confirm PubMatic has activated this outstream placement.`);
    if(raw.cacheUrl!==OUTSTREAM_PILOT.cacheUrl) fail(`${code}: use the supported Prebid VAST cache endpoint.`);
    units[code]={format:raw.format,playerSize:[...raw.playerSize],minDuration:raw.minDuration,maxDuration:raw.maxDuration,playbackMethod:2,placement:3,plcmt:4,
      partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:p.outstreamAU,activationConfirmed:true},cacheUrl:raw.cacheUrl};
  }
  return {schemaVersion:1,units};
}

export function outstreamContext(snapshot) {
  const config=JSON.parse(snapshot.config.config_json),build=snapshot.prebidBuilds?.length===1?snapshot.prebidBuilds[0]:null;
  const pin=config.builtinRuntimeSelection?.prebid;
  const modules=build?JSON.parse(build.modules_json??'[]'):pin?.modules??[];
  const runtime=config.runtimeControls??{};
  const blockedCodes=Object.keys(runtime.adPositions??{});
  if(runtime.sticky?.bottomAdUnitId)blockedCodes.push(runtime.sticky.bottomAdUnitId);
  else if(snapshot.units.some(u=>u.code==='Sticky'&&u.enabled===1))blockedCodes.push('Sticky');
  if(runtime.sticky?.topAdUnitId)blockedCodes.push(runtime.sticky.topAdUnitId);
  if(runtime.takeOver?.enabled)for(const unit of snapshot.units)blockedCodes.push(unit.code);
  return {units:snapshot.units,maps:snapshot.maps,bidders:snapshot.bidders,enablePrebid:config.enablePrebid,
    prebidVersion:build?.version??pin?.version??null,modules,blockedCodes};
}
export function buildOutstreamInput(snapshot) {
  const config=JSON.parse(snapshot.config.config_json);
  if(config.enablePrebid!==true)return {units:{},disabledRefreshCodes:[],cacheUrl:null};
  const normalized=normalizeOutstream(config.runtimeControls?.outstream,outstreamContext(snapshot));
  const units=Object.fromEntries(Object.entries(normalized.units).filter(([,value])=>value.format!=='banner'));
  return {units,disabledRefreshCodes:Object.keys(units),cacheUrl:Object.values(units)[0]?.cacheUrl??null};
}
