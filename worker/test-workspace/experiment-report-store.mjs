import { WorkspaceError } from './boundary.mjs';
import { assertUniqueValues } from '../experiments/reporting.mjs';

export const REPORT_KEY='test-experiments/v1/reporting.json';
const check=(ok,message,status=409)=>{if(!ok)throw new WorkspaceError(status,message);};
export async function readReporting(bucket) {
  check(bucket,'TEST storage unavailable.',503);
  const object=await bucket.get(REPORT_KEY);
  if(!object)return {plans:[],etag:null};
  check(object.size<=1024*1024&&object.httpEtag,'Invalid reporting history.');
  const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await object.arrayBuffer()));
  check(state.schemaVersion===1&&Array.isArray(state.plans)&&state.plans.length<=100,'Invalid reporting history.');
  return {plans:state.plans,etag:object.httpEtag};
}
// Separate append-only registry; preparing a report never starts/stops a preview.
export async function storeReporting(bucket,plan) {
  for(let attempt=0;attempt<5;attempt++) {
    const {plans,etag}=await readReporting(bucket);
    const previous=plans.find(p=>p.experimentId===plan.experimentId);
    if(previous) {
      check(JSON.stringify(previous)===JSON.stringify(plan),'Delivery changed since this report was prepared. Save a new experiment; the original mapping is retained.');
      return previous;
    }
    check(plans.length<100,'Reporting history is full. Existing mappings are retained.');
    try {assertUniqueValues([...plans,plan]);}catch(e){throw new WorkspaceError(409,e.message);}
    const bytes=new TextEncoder().encode(JSON.stringify({schemaVersion:1,plans:[...plans,plan]}));
    check(bytes.length<=1024*1024,'Reporting history is full.');
    const saved=await bucket.put(REPORT_KEY,bytes,{onlyIf:new Headers(etag?{'If-Match':etag}:{'If-None-Match':'*'}),
      httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
    if(saved)return plan;
  }
  throw new WorkspaceError(409,'Reporting history changed. Refresh and try again.');
}
