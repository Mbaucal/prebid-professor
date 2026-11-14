/** TEST workspace Worker: runtime helpers plus its own serialized functions. */
import {installCanonicalText} from './install.mjs';
import {testWorkspaceFunctions} from './functions.mjs';
import * as staticAA from '../experiments/static-aa-v1.mjs';
import * as cmpAA from '../experiments/cmp-aa-v1.mjs';
import * as configurableCache from '../experiments/configurable-cache-v1.mjs';
import * as fullLifecycle from '../runtime-cache/full-lifecycle-v1.mjs';
import * as fullPolicy from '../runtime-cache/full-policy-v1.mjs';
import * as consentEpoch from '../runtime-cache/consent-epoch.mjs';
import * as positionPolicy from '../runtime-cache/position-policy-v2.mjs';
import * as prebidVersions from '../test-workspace/prebid-versions.mjs';

installCanonicalText(testWorkspaceFunctions, {
  'worker/experiments/static-aa-v1.mjs': staticAA,
  'worker/experiments/cmp-aa-v1.mjs': cmpAA,
  'worker/experiments/configurable-cache-v1.mjs': configurableCache,
  'worker/runtime-cache/full-lifecycle-v1.mjs': fullLifecycle,
  'worker/runtime-cache/full-policy-v1.mjs': fullPolicy,
  'worker/runtime-cache/consent-epoch.mjs': consentEpoch,
  'worker/runtime-cache/position-policy-v2.mjs': positionPolicy,
  'worker/test-workspace/prebid-versions.mjs': prebidVersions,
});
