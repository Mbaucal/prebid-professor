const check=(ok,message,status=409)=>{if(!ok)throw Object.assign(Error(message),{status});};
/** A separate marker changes visibility, never the immutable record/ZIP bytes. */
export async function deletedPackage(bucket,key) {
  const object=await bucket.get(key);if(!object)return null;
  check(object.size<4096,'Deletion record is invalid.');
  const record=JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
  check(record.schemaVersion===1&&typeof record.id==='string'&&/^[a-f0-9]{64}$/.test(record.sha256)
    &&Number.isFinite(Date.parse(record.deletedAt)),'Deletion record is invalid.');
  return record;
}
export async function changePackageDeletion(bucket,key,{id,sha256,actor},body,remove) {
  check(body&&Object.keys(body).sort().join(',')==='confirmId,sha256'&&body.confirmId===id&&body.sha256===sha256,
    'Confirm the exact saved version before deleting or restoring.',422);
  const existing=await deletedPackage(bucket,key);
  if(existing)check(existing.id===id&&existing.sha256===sha256,'Deleted version differs.');
  if(remove){
    if(!existing)await bucket.put(key,new TextEncoder().encode(JSON.stringify({schemaVersion:1,id,sha256,deletedAt:new Date().toISOString(),deletedBy:actor})),
      {onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
    const saved=await deletedPackage(bucket,key);check(saved?.id===id&&saved.sha256===sha256,'Deletion was not confirmed. Retry.');
  }else {await bucket.delete(key);check(!await deletedPackage(bucket,key),'Restore was not confirmed. Retry.');}
  return {ok:true,id,deleted:remove};
}
