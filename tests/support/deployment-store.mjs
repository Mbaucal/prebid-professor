import assert from 'node:assert/strict';
import { workspaceStore } from './test-workspace-store.mjs';
import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';
import { STATE_KEY } from '../../worker/test-workspace/deployment-store.mjs';

export const TRANSFER_SECRET = 'Synthetic-TEST-transfer-only-not-a-live-key-12345';
export const TARGET = {accountId:'1'.repeat(32),projectName:'tessera-fixture',previewBranch:'tessera-test',secretName:'CLOUDFLARE_API_TOKEN_FIXTURE'};
export function deploymentStore() {
  const f=workspaceStore(), base=f.env.BUILDS, objects=new Map(), puts=[];
  const owns=key => key === STATE_KEY || /^test-experiments\/assignments-v1\/[a-f0-9]{64}\.json$/.test(key) || key === 'test-experiments/v1/state.json' || key === 'test-experiments/v1/reporting.json' || /^test-deployments\/v1\/packages\/[a-f0-9]{64}\.zip$/.test(key);
  const bucket={
    async get(key) {
      if(!owns(key))return base.get(key);
      const value=objects.get(key);if(!value)return null;
      const copy=value.bytes.slice();return {size:copy.length,httpEtag:value.etag,async arrayBuffer(){return copy.buffer;}};
    },
    async put(key,value,options) {
      if(!owns(key))return base.put(key,value,options);
      assert.equal(options.httpMetadata.cacheControl,'private, no-store');
      assert(options.onlyIf instanceof Headers);
      const bytes=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value).slice();
      const hash=await sha256(bytes);if(options.sha256)assert.equal(hash,options.sha256);
      // No await after checking the condition: fake R2 has atomic CAS semantics.
      const current=objects.get(key);
      const condition=options.onlyIf.get('If-Match'), absent=options.onlyIf.get('If-None-Match');
      assert(condition || absent==='*');
      if((condition && current?.etag!==condition)||(absent==='*'&&current))return null;
      const etag='"'+hash+'"';objects.set(key,{bytes,etag});puts.push(key);return {httpEtag:etag};
    },
    delete(){assert.fail('No automatic deletion');},list(){assert.fail('No bucket-wide listing');},
  };
  f.env.BUILDS=bucket;f.env.TEST_DEPLOY_SECRET=TRANSFER_SECRET;f.env.TEST_GITHUB_ACTIONS_TOKEN='Synthetic-GitHub-token-not-a-live-key-12345';
  return {...f,deliveryObjects:objects,deliveryPuts:puts};
}
