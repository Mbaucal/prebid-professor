/** One verified asset set for both the downloaded ZIP and a future Pages upload. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {zipSync,unzipSync} from 'fflate';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const integrity=bytes=>'sha256-'+createHash('sha256').update(bytes).digest('base64');
const LIMIT=8*1024*1024;
const fixed=['ads.js','prebid.js','sticky.css','min-height.css','_headers','404.html'];

export function verifyStaticAAPackage(manifest,files) {
  assert.equal(manifest?.schemaVersion,1);
  assert.equal(manifest?.kind,'static-production-aa-compact');
  assert.match(manifest.release,/^tanjug-aa-\d+\.\d+\.\d+$/);
  const c=manifest.config;
  assert.equal(c?.release,manifest.release);
  assert.equal(manifest.key,'Variant');
  assert.deepEqual(manifest.values,['A','B']);
  assert.equal(manifest.allocation,'50/50 per document');
  assert.deepEqual(Object.keys(c.arms).sort(),['A','B']);
  assert.match(c.armSha256,/^[a-f0-9]{64}$/);
  const folder='releases/'+manifest.release+'-'+c.armSha256.slice(0,16)+'/';
  assert.equal(c.arms.A.path,folder+'A.js');
  assert.equal(c.arms.B.path,folder+'B.js');
  assert.equal(c.prebidPath,folder+'prebid.js');
  assert(Array.isArray(c.positions)&&c.positions.length===19&&new Set(c.positions).size===19);
  assert.equal(c.prebidVersion,'11.34.0');
  const names=[...fixed,c.arms.A.path,c.arms.B.path,c.prebidPath].sort();
  assert.deepEqual(Object.keys(manifest.files).sort(),names,'Only production assets belong in the public package');
  assert.deepEqual(Object.keys(files).sort(),names,'Package files differ from the saved inventory');
  let total=0;
  for(const name of names) {
    const entry=manifest.files[name],bytes=files[name];
    assert(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=LIMIT,'Invalid production asset');
    total+=bytes.length;assert(total<=2*LIMIT,'Production package is too large');
    assert.equal(bytes.length,entry.bytes,name+' length differs');
    assert.equal(sha256(bytes),entry.sha256,name+' checksum differs');
  }
  assert.deepEqual(files[c.arms.A.path],files[c.arms.B.path],'This profile is A/A, not a behavioral A/B test');
  assert.equal(sha256(files[c.arms.A.path]),c.armSha256);
  for(const arm of ['A','B'])assert.equal(integrity(files[c.arms[arm].path]),c.arms[arm].integrity);
  assert.deepEqual(files['prebid.js'],files[c.prebidPath]);
  assert.equal(integrity(files['prebid.js']),c.prebidIntegrity);
  assert.equal(sha256(files['prebid.js']),manifest.prebidSha256);
  return names;
}

export function archiveStaticAAPackage(manifest,files) {
  const names=verifyStaticAAPackage(manifest,files);
  const entries=Object.fromEntries(names.map(name=>[name,[files[name],{level:6,mtime:new Date(1980,0,1)}]]));
  return zipSync(entries);
}

/** Validate before materialization; never extract unchecked ZIP paths to disk. */
export function readStaticAAArchive(manifest,archive,archiveSha256) {
  assert(archive instanceof Uint8Array&&archive.length>0&&archive.length<=LIMIT);
  assert.match(archiveSha256,/^[a-f0-9]{64}$/);
  assert.equal(sha256(archive),archiveSha256,'Saved ZIP checksum differs');
  const seen=new Set();let total=0;
  const files=unzipSync(archive,{filter(entry){
    assert(!seen.has(entry.name),'Duplicate ZIP entry');seen.add(entry.name);
    const expected=Object.hasOwn(manifest.files,entry.name)&&manifest.files[entry.name];
    assert(expected&&entry.originalSize===expected.bytes&&entry.originalSize>0&&entry.originalSize<=LIMIT,'Unexpected ZIP entry');
    total+=entry.originalSize;assert(total<=2*LIMIT,'Unpacked ZIP is too large');
    return true;
  }});
  verifyStaticAAPackage(manifest,files);
  return files;
}
