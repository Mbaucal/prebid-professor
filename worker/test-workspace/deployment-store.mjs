import { sha256 } from '../runtime/prebid-artifact-check.mjs';
import { WorkspaceError } from './boundary.mjs';
import { REQUEST_ID, MAX_ZIP, requireThat } from './deployment-contract.mjs';

export const STATE_KEY = 'test-deployments/v1/state.json';
export const unsettled = run => ['queued','running','dispatch_unknown','unverified'].includes(run.status);
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const privateOptions = {httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}};
// R2 is the single CAS authority. No D1 migrations and no changes to release storage.
export async function readLedger(bucket) {
  requireThat(bucket, 'TEST delivery storage is not connected.');
  const object = await bucket.get(STATE_KEY);
  if (!object) return {state:{schemaVersion:1,revision:0,targets:{},runs:[]}, etag:null};
  requireThat(object.size <= 1024*1024 && object.httpEtag, 'Invalid delivery ledger.');
  const state = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await object.arrayBuffer()));
  requireThat(state.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision >= 1
    && state.targets && Array.isArray(state.runs) && state.runs.length <= 100, 'Invalid delivery ledger.');
  return {state,etag:object.httpEtag};
}
export async function changeLedger(bucket, expectedRevision, change) {
  for (let attempt=0; attempt<5; attempt++) {
    const {state,etag} = await readLedger(bucket);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new WorkspaceError(409,'Lista objava je promenjena. Osveži prikaz pre sledeće radnje.');
    const result = change(state);
    if (result === false) return state;
    state.revision++;
    const bytes = encode(state);
    requireThat(bytes.length <= 1024*1024, 'Delivery history is full. Existing versions are retained.');
    const saved = await bucket.put(STATE_KEY,bytes,{...privateOptions,onlyIf:new Headers(etag?{'If-Match':etag}:{'If-None-Match':'*'})});
    if (saved) return state;
    if (expectedRevision !== undefined) break;
  }
  throw new WorkspaceError(409,'Druga radnja je promenila objave. Osveži prikaz.');
}
export function deliveryRun(state, id) {
  if (!REQUEST_ID.test(id)) throw new WorkspaceError(404,'Objava nije pronađena.');
  const run = state.runs.find(r => r.id === id);
  if (!run) throw new WorkspaceError(404,'Objava nije pronađena.');
  return run;
}
const zipKey = hash => {requireThat(/^[a-f0-9]{64}$/.test(hash),'Invalid ZIP identity.');return `test-deployments/v1/packages/${hash}.zip`;};
export async function readDeliveryZip(bucket, pin) {
  const object = await bucket.get(zipKey(pin.zipSha256));
  requireThat(object && object.size === pin.zipByteSize && object.size <= MAX_ZIP, 'Original delivery ZIP is unavailable.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  requireThat(bytes.length === pin.zipByteSize && await sha256(bytes) === pin.zipSha256, 'Original delivery ZIP differs.');
  return bytes;
}
export async function cacheDeliveryZip(bucket, bytes) {
  requireThat(bytes.length <= MAX_ZIP, 'Delivery ZIP is too large.');
  const pin = {zipSha256:await sha256(bytes),zipByteSize:bytes.length};
  await bucket.put(zipKey(pin.zipSha256),bytes,{onlyIf:new Headers({'If-None-Match':'*'}),
    sha256:pin.zipSha256,httpMetadata:{contentType:'application/zip',cacheControl:'private, no-store'}});
  await readDeliveryZip(bucket,pin);
  return pin;
}
