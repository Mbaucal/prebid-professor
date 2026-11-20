export const DEFAULT_ADAPTIVE_TIMEOUT = Object.freeze({enabled:false,minMs:800,maxMs:4000,mobileAdjustmentMs:200,slowConnectionAdjustmentMs:500,videoAdjustmentMs:300,additionalPositionMs:100,maxPositionAdjustmentMs:500});
export function normalizeAdaptiveTimeout(value) {
  if(value===undefined||value===null)return {...DEFAULT_ADAPTIVE_TIMEOUT};
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Adaptive auction timeout must be an object.');
  if(Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_ADAPTIVE_TIMEOUT,key)))throw Error('Adaptive auction timeout contains an unsupported field.');
  const out={...DEFAULT_ADAPTIVE_TIMEOUT,...value};
  if(typeof out.enabled!=='boolean')throw Error('Adaptive auction timeout enabled must be a boolean.');
  for(const key of Object.keys(DEFAULT_ADAPTIVE_TIMEOUT).filter(key=>key!=='enabled')) {
    const min=key==='minMs'||key==='maxMs'?100:0,max=key==='minMs'||key==='maxMs'?10000:5000;
    if(!Number.isInteger(out[key])||out[key]<min||out[key]>max)throw Error(`Adaptive auction timeout ${key} must be an integer between ${min} and ${max}.`);
  }
  if(out.minMs>out.maxMs)throw Error('Adaptive auction timeout minimum must not exceed maximum.');
  return out;
}
export function requireAdaptiveTimeoutRuntime(config,runtime) {
  if(config?.adaptiveAuctionTimeout?.enabled!==true)return;
  if(!runtime?.capabilities?.includes('adaptive-auction-timeout'))throw Error('Adaptive auction timeout requires script 3.26.0. Select it in Script setup and save, or turn off adaptive timeout. Your saved rules are kept.');
  normalizeAdaptiveTimeout(config.adaptiveAuctionTimeout);
}
