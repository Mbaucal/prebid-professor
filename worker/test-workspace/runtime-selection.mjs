import { runtimeCatalog, prepareSiteRuntimeSelection, readPinnedSiteRuntime } from './private-runtime-catalog.mjs';
import { assertWorkspaceSiteScope } from './site-draft.mjs';
/** Authenticated TEST settings service. The router enforces host, session,
 * same-origin, methods and request size before calling these functions.
 * No Prebid upload, production-site editing, schema migration or publication.
 */
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { pinRuntime } from '../runtime/version-pin.mjs';
import { RuntimeSelectionError } from '../runtime/site-runtime-selection.mjs';
import { inspectTestSchema } from './schema.mjs';
import { WorkspaceError, TEST_SITE } from './boundary.mjs';
import { commitTestRuntimeSelection } from './selection-transaction.mjs';
import { describeRuntimeReleases } from '../runtime/runtime-release-history.mjs';

async function savedSettings(env) {
  if (!(await inspectTestSchema(env.DB)).ready) throw new WorkspaceError(409,'Prepare the empty test database on the Generate screen first.');
  const saved = await readPreviewSnapshot(env.DB.withSession('first-primary'),TEST_SITE,{includePrebid:true});
  const config=assertWorkspaceSiteScope(saved);
  return {saved,config};
}
export async function readRuntimeSelectionSettings(env) {
  const {saved,config} = await savedSettings(env);
  let selected = null, validationIssue = null;
  if (Object.hasOwn(config,'builtinRuntimeSelection')) {
    try {
      const resolved = await readPinnedSiteRuntime({siteId:TEST_SITE,snapshot:saved,catalog:runtimeCatalog},env.BUILDS);
      selected = {runtime:resolved.pin,prebid:resolved.prebid?.report?{...resolved.prebid.report.build,modules:resolved.prebid.report.declaredModules}:null};
    } catch(error) {
      if (!(error instanceof RuntimeSelectionError)) throw error;
      validationIssue = error.message;
    }
  }
  // Do not return saved configJson, arbitrary fields, connector data or a file URL.
  return {site:{id:TEST_SITE,name:saved.site.name,domain:saved.site.domain,gamPath:saved.site.gam_path},
    revision:await digest(saved),selected,validationIssue,publishable:false,prebidEditable:false,enablePrebid:config.enablePrebid,prebidBuildId:config.builtinRuntimeSelection?.prebid?.id??null,
    releaseHistory:describeRuntimeReleases(runtimeCatalog,config.builtinRuntimeSelection?.runtime),
    runtimes:runtimeCatalog.map(r=>({id:r.id,version:r.version,channel:r.channel,pin:pinRuntime(r,{allowPreview:true})}))};
}
export async function saveRuntimeSelectionSettings(env,actor,body) {
  const {saved,config} = await savedSettings(env);
  if(body?.selection?.enablePrebid!==config.enablePrebid || body?.selection?.prebidBuildId!==(config.builtinRuntimeSelection?.prebid?.id??null))throw new WorkspaceError(422,'Use Prebid and bidders to change Prebid mode or file. The script-version form preserves that choice.');
  const plan = await prepareSiteRuntimeSelection({siteId:TEST_SITE,snapshot:saved,catalog:runtimeCatalog,
    expectedRevision:body.expectedRevision,selection:body.selection},env.BUILDS);
  const result = await commitTestRuntimeSelection({isolation:'explicit-test-store',db:env.DB},
    {snapshot:saved,configJson:plan.changed?plan.configJson:saved.config.config_json,actor});
  return {...result,runtimeVersion:plan.selection.runtime.runtimeVersion};
}

/** Compatibility is ONLY for the original, unpinned synthetic GPT-only demo.
 * Once a selection exists, all generations must use and validate that exact pin.
 * Invalid/unavailable saved selections never fall back to the bootstrap default.
 */
export async function selectedWorkspaceRuntime(settings,bucket) {
  const config = JSON.parse(settings.config.config_json);
  if (!Object.hasOwn(config,'builtinRuntimeSelection')) {
    if (settings.site?.id !== TEST_SITE || settings.site?.domain !== 'example.invalid'
      || settings.site?.gam_path !== '/123/test/' || config.enablePrebid !== false) {
      throw new WorkspaceError(409,'Choose an exact runtime for this site before generating.');
    }
    return {pin:pinRuntime(runtimeCatalog[1],{allowPreview:true}),prebid:null};
  }
  return readPinnedSiteRuntime({siteId:TEST_SITE,snapshot:{...settings,prebidBuilds:settings.prebidBuilds??[]},catalog:runtimeCatalog},bucket);
}

export async function selectedWorkspacePin(settings,bucket){return (await selectedWorkspaceRuntime(settings,bucket)).pin;}
