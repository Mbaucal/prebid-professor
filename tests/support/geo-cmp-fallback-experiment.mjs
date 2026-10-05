// EXPERIMENT ONLY: no application imports, public endpoint or runtime registration.
const protectedCountries = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB UK CH'.split(' '));
const knownCountries = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const verified = new WeakSet();
const validId = value => typeof value==='string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const countryCode = value => typeof value==='string' && /^[A-Z]{2}$/.test(value) && knownCountries.has(value) ? value : null;
const ttlMs=60000;
export function handleGeoScopeRequest(request,{siteId,allowCountries=[],allowedOrigin,now=Date.now()}={}) {
  const url=new URL(request.url),origin=request.headers.get('origin');
  const headers={'content-type':'application/json','cache-control':'private, no-store, max-age=0','vary':'Origin'};
  if(origin && origin===allowedOrigin)headers['access-control-allow-origin']=origin;
  const fail=status=>new Response(JSON.stringify({error:'Geo scope unavailable'}),{status,headers});
  const sameOrigin=!origin && url.origin===allowedOrigin;
  if(request.method!=='GET' || !allowedOrigin || (!sameOrigin && origin!==allowedOrigin))return fail(403);
  const pageId=url.searchParams.get('pageId'),nonce=url.searchParams.get('nonce');
  if(!siteId || url.searchParams.get('siteId')!==siteId || !validId(pageId) || !validId(nonce) || !Number.isSafeInteger(now))return fail(400);
  // Cloudflare supplies cf on the incoming edge request. Never read geo headers/query.
  const country=countryCode(request.cf?.country);
  const allowed=!!country && !protectedCountries.has(country) && Array.isArray(allowCountries) && allowCountries.includes(country);
  return new Response(JSON.stringify({schema:1,siteId,pageId,nonce,country,allowed,issuedAt:now,expiresAt:now+ttlMs}),{headers});
}
export async function fetchTrustedGeo({endpoint,siteId,pageId,nonce,now=Date.now,fetchImpl=globalThis.fetch}={}) {
  try {
    const url=new URL(endpoint);
    if(url.protocol!=='https:' || url.username || url.password || !siteId || !validId(pageId) || !validId(nonce))return null;
    url.searchParams.set('siteId',siteId);url.searchParams.set('pageId',pageId);url.searchParams.set('nonce',nonce);
    const response=await fetchImpl(url.href,{credentials:'omit',cache:'no-store',redirect:'error'});
    if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return null;
    if(!response.ok || response.redirected || !response.url || new URL(response.url).origin!==url.origin || new URL(response.url).pathname!==url.pathname)return null;
    if(!response.headers.get('cache-control')?.split(',').map(x=>x.trim()).includes('no-store'))return null;
    const data=await response.json(),time=now();
    if(data.schema!==1 || data.siteId!==siteId || data.pageId!==pageId || data.nonce!==nonce || typeof data.allowed!=='boolean')return null;
    if(!Number.isSafeInteger(data.issuedAt) || !Number.isSafeInteger(data.expiresAt) || data.issuedAt>time || data.expiresAt<=time || data.expiresAt-data.issuedAt>ttlMs || data.expiresAt<=data.issuedAt)return null;
    const country=countryCode(data.country);
    if(data.country!==null && country===null)return null;
    if(data.allowed && (!country || protectedCountries.has(country)))return null;
    const result=Object.freeze({siteId,pageId,nonce,country,allowed:data.allowed,issuedAt:data.issuedAt,expiresAt:data.expiresAt});
    verified.add(result);return result;
  }catch{return null;}
}
export function createGeoCmpFallback({geo,siteId,pageId,nonce,now=Date.now,waitMs,onInvalidate=()=>{}}={}) {
  if(!Number.isFinite(waitMs) || waitMs<0)throw Error('Invalid experimental wait threshold');
  const adoptedAt=now();
  const adoptedGeo=verified.has(geo) && geo.siteId===siteId && geo.pageId===pageId && geo.nonce===nonce && geo.issuedAt<=adoptedAt && adoptedAt<geo.expiresAt;
  let loadingSince=null,cmp=null,scopeTrueSeen=false,selected=null,disposed=false,epoch=0,key='',state;
  function evaluate() {
    const time=now(),fresh=adoptedGeo;
    let ready=false,reason='waiting-for-cmp',source=null,decisionKey='';
    if(disposed)reason='disposed';
    else if(cmp?.ready) {
      if(selected==='static' && cmp.scope===true)reason='native-scope-conflict';
      else {ready=true;reason='cmp-decision';source='cmp';decisionKey=cmp.key;}
    } else if(cmp?.scope===true || scopeTrueSeen)reason='cmp-scope-conflict';
    else if(cmp?.phase==='user-decision')reason='waiting-for-user';
    else if(cmp?.phase!=='loading')reason='waiting-for-cmp';
    else if(!fresh)reason='geo-unavailable';
    else if(!geo.allowed)reason='country-not-enabled';
    else if(loadingSince===null || time-loadingSince<waitMs)reason='waiting-for-stall-threshold';
    else if(selected==='iab')reason='native-mode-locked';
    else {ready=true;reason='regional-scope';source='geo';decisionKey='scope-false';}
    const nextKey=JSON.stringify([ready,source,decisionKey]);
    const changed=!!key && key!==nextKey;
    if(changed)epoch++;
    key=nextKey;state={ready,reason,source,epoch,nativeMode:selected};
    if(changed)onInvalidate({epoch,reason});
    return {...state};
  }
  function observeCmp(data,success) {
    if(disposed)return evaluate();
    if(success!==true || !data || typeof data!=='object'){cmp={ready:false,phase:'error'};return evaluate();}
    const scope=typeof data.gdprApplies==='boolean'?data.gdprApplies:null;
    if(scope===true)scopeTrueSeen=true;
    const ready=scope===false || scope===true && data.cmpStatus==='loaded' && ['tcloaded','useractioncomplete'].includes(data.eventStatus) && typeof data.tcString==='string' && !!data.tcString;
    const phase=data.eventStatus==='cmpuishown'?'user-decision':data.cmpStatus==='loading'?'loading':'incomplete';
    if(phase==='loading' && cmp?.phase!=='loading')loadingSince=now();
    else if(phase!=='loading')loadingSince=null;
    cmp={scope,ready,phase,key:ready?JSON.stringify([scope,data.tcString||'',data.addtlConsent||'']):''};return evaluate();
  }
  evaluate();
  return {observeCmp,snapshot:evaluate,
    selectNativeMode(){const s=evaluate();if(!s.ready)return null;if(!selected)selected=s.source==='geo'?'static':'iab';return selected==='static'?{mode:'static',consentData:{gdprApplies:false}}:{mode:'iab'};},
    canRequest(expectedEpoch){const s=evaluate();return s.ready && selected!==null && (expectedEpoch===undefined || expectedEpoch===s.epoch);},
    dispose(){disposed=true;evaluate();}
  };
}
// Pre-initialization contract only. Never hide/remove an existing publisher CMP.
export function planRegionalStartup({geo,siteId,pageId,nonce,now=Date.now,publisherOwnsCmpStartup,existingTcfApi,existingPrebidInitialized,existingGptInitialized,hasObservedCmp}={}) {
  const time=now();
  const fresh=verified.has(geo) && geo.siteId===siteId && geo.pageId===pageId && geo.nonce===nonce && geo.issuedAt<=time && time<geo.expiresAt;
  if(!fresh || !geo.allowed || publisherOwnsCmpStartup!==true || existingTcfApi!==false || existingPrebidInitialized!==false || existingGptInitialized!==false || hasObservedCmp!==false)return {route:'cmp'};
  return {route:'regional',consentData:{gdprApplies:false}};
}
