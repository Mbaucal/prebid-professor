/** TEST workspace Worker: runtime helpers plus its own serialized functions. */
import {installCanonicalText} from './install.mjs';
import {testWorkspaceFunctions} from './functions.mjs';
import * as prebidVersions from '../test-workspace/prebid-versions.mjs';

installCanonicalText(testWorkspaceFunctions, {
  'worker/test-workspace/prebid-versions.mjs': prebidVersions,
});
