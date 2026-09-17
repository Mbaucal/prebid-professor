import { WorkspaceError } from './boundary.mjs';
import { summarizeAssignments } from '../experiments/assignments.mjs';
const check=(ok,message,status=409)=>{if(!ok)throw new WorkspaceError(status,message);};
export const MAX_ASSIGNMENTS=1000;
const storageKey=hash=>{check(/^[a-f0-9]{64}$/.test(hash),'Invalid collection identity.');return 'test-experiments/assignments-v1/'+hash+'.json';};
export async function readAssignments(bucket,hash) {
  check(bucket,'TEST storage unavailable.',503);
  const object=await bucket.get(storageKey(hash));
  if(!object)return {records:[],etag:null};
  check(object.size<=1024*1024&&object.httpEtag,'Invalid assignment collection.');
  const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await object.arrayBuffer()));
  check(state.schemaVersion===1&&state.deliverySha256===hash&&Array.isArray(state.records)&&state.records.length<=MAX_ASSIGNMENTS,'Invalid assignment collection.');
  return {records:state.records,etag:object.httpEtag};
}
export async function storeAssignment(bucket,plan,claim,types) {
  check(claim.experimentId===plan.experimentId&&claim.siteId===plan.siteId&&claim.deliverySha256===plan.deliverySha256,'Assignment does not match this report.',403);
  check(Array.isArray(types)&&types.length>=1&&types.length<=4&&types.includes('assigned')
    &&types.every(t=>['assigned','script-loaded','load-error','conflict'].includes(t))&&new Set(types).size===types.length,'Invalid assignment outcomes.',422);
  const record={assignmentId:claim.assignmentId,variant:claim.variant,packageSha256:claim.packageSha256,assignedAt:claim.assignedAt,types:[...types].sort()};
  // Use the same strict attribution rules as offline analysis.
  const event=t=>({assignmentId:record.assignmentId,variant:record.variant,packageSha256:record.packageSha256,
    assignedAt:record.assignedAt,deliverySha256:plan.deliverySha256,type:t});
  try {summarizeAssignments(plan,record.types.map(event));}catch(e){throw new WorkspaceError(422,e.message);}
  for(let attempt=0;attempt<5;attempt++) {
    const {records,etag}=await readAssignments(bucket,plan.deliverySha256);
    const previous=records.find(r=>r.assignmentId===record.assignmentId);
    if(previous) {
      check(previous.variant===record.variant&&previous.packageSha256===record.packageSha256&&previous.assignedAt===record.assignedAt,'Conflicting assignment identity.');
      if(record.types.every(t=>previous.types.includes(t)))return;
      previous.types=[...new Set([...previous.types,...record.types])].sort();
    }else {
      check(records.length<MAX_ASSIGNMENTS,'TEST assignment sample is full. Existing events are retained.',429);
      records.push(record);
    }
    const bytes=new TextEncoder().encode(JSON.stringify({schemaVersion:1,deliverySha256:plan.deliverySha256,records}));
    check(bytes.length<=1024*1024,'TEST assignment sample is full.',429);
    const saved=await bucket.put(storageKey(plan.deliverySha256),bytes,{onlyIf:new Headers(etag?{'If-Match':etag}:{'If-None-Match':'*'}),
      httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
    if(saved)return;
  }
  throw new WorkspaceError(409,'Assignment collection is busy. Retry this same assignment.');
}
export async function assignmentSummary(bucket,plan) {
  const {records}=await readAssignments(bucket,plan.deliverySha256);
  const events=records.flatMap(({types,...r})=>types.map(type=>({...r,type,deliverySha256:plan.deliverySha256})));
  return {...summarizeAssignments(plan,events),scope:'private-test-preview',
    collectionLimit:MAX_ASSIGNMENTS,atCapacity:records.length>=MAX_ASSIGNMENTS};
}
