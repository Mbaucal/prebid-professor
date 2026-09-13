import { WorkspaceError } from './boundary.mjs';
/** Shared with the browser fallback. Only public version names cross this boundary. */
export async function fetchPrebidVersions() {
    const response=await fetch('https://js-download.prebid.org/versions',{method:'GET',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw Error('catalog');
    const reader=response.body.getReader();let text='',size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();throw Error('size');}text+=new TextDecoder().decode(value);}}finally{reader.releaseLock();}
    const versions=JSON.parse(text).versions;
    if(!Array.isArray(versions)||!versions.length||versions.length>500||versions.some(v=>typeof v!=='string'||!/^\d+\.\d+\.\d+$/.test(v)))throw Error('versions');
    const supported=versions.filter(v=>Number(v.split('.')[0])>=9);
    if(!supported.length)throw Error('versions');
    return {versions:supported,source:'https://js-download.prebid.org/versions'};
}
/** Fixed, read-only public catalog; never fetch a caller-provided URL. */
export async function prebidVersions() {
  try{return await fetchPrebidVersions();}
  catch{throw new WorkspaceError(503,'The Prebid version list is temporarily unavailable. Your entered version and saved settings are unchanged.');}
}
