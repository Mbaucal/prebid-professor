/** Authenticated TEST settings service. The router enforces host, session,
 * same-origin, methods and request size before calling these functions.
 * No Prebid upload, production-site editing, schema migration or publication.
 */
import { runtimeDescriptor, readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { pinRuntime } from '../runtime/version-pin.mjs';
import { prepareSiteRuntimeSelection, readPinnedSiteRuntime, RuntimeSelectionError } from '../runtime/site-runtime-selection.mjs';
import { inspectTestSchema } from './schema.mjs';
import { WorkspaceError, TEST_SITE } from './boundary.mjs';
import { commitTestRuntimeSelection } from './selection-transaction.mjs';

async function savedSettings(env) {
  if (!(await inspectTestSchema(env.DB)).ready) throw new WorkspaceError(409,'Prepare the empty test database on the Generate screen first.');
  const saved = await readPreviewSnapshot(env.DB.withSession('first-primary'),TEST_SITE,{includePrebid:true});
  let config;
  try { config = JSON.parse(saved.config.config_json); } catch { throw new WorkspaceError(409,'Saved TEST settings need review.'); }
  if (saved.site.id !== TEST_SITE || saved.site.domain !== 'example.invalid' || saved.site.gam_path !== '/123/test/'
      || config?.enablePrebid !== false || saved.bidders.length || saved.overrides.length || saved.prebidBuilds.length) {
    throw new WorkspaceError(409,'This first settings editor accepts only the synthetic GPT-only test site.');
  }
  return {saved,config};
}
export async function readRuntimeSelectionSettings(env) {
  const {saved,config} = await savedSettings(env);
  let selected = null, validationIssue = null;
  if (Object.hasOwn(config,'builtinRuntimeSelection')) {
    try {
      const resolved = await readPinnedSiteRuntime({siteId:TEST_SITE,snapshot:saved,catalog:[runtimeDescriptor]});
      selected = {runtime:resolved.pin,prebid:null};
    } catch(error) {
      if (!(error instanceof RuntimeSelectionError)) throw error;
      validationIssue = error.message;
    }
  }
  // Do not return saved configJson, arbitrary fields, connector data or a file URL.
  return {site:{id:TEST_SITE,name:saved.site.name,domain:saved.site.domain,gamPath:saved.site.gam_path},
    revision:await digest(saved),selected,validationIssue,publishable:false,prebidEditable:false,
    runtimes:[{id:runtimeDescriptor.id,version:runtimeDescriptor.version,channel:runtimeDescriptor.channel,
      pin:pinRuntime(runtimeDescriptor,{allowPreview:true})}]};
}
export async function saveRuntimeSelectionSettings(env,actor,body) {
  if (body?.selection?.enablePrebid !== false || body?.selection?.prebidBuildId !== null) {
    throw new WorkspaceError(422,'Prebid upload and selection are not enabled in this first TEST editor.');
  }
  const {saved} = await savedSettings(env);
  const plan = await prepareSiteRuntimeSelection({siteId:TEST_SITE,snapshot:saved,catalog:[runtimeDescriptor],
    expectedRevision:body.expectedRevision,selection:body.selection});
  const result = await commitTestRuntimeSelection({isolation:'explicit-test-store',db:env.DB},
    {snapshot:saved,configJson:plan.changed?plan.configJson:saved.config.config_json,actor});
  return {...result,runtimeVersion:plan.selection.runtime.runtimeVersion};
}

/** Compatibility is ONLY for the original, unpinned synthetic GPT-only demo.
 * Once a selection exists, all generations must use and validate that exact pin.
 * Invalid/unavailable saved selections never fall back to the bootstrap default.
 */
export async function selectedWorkspacePin(settings) {
  const config = JSON.parse(settings.config.config_json);
  if (!Object.hasOwn(config,'builtinRuntimeSelection')) {
    if (settings.site?.id !== TEST_SITE || settings.site?.domain !== 'example.invalid'
      || settings.site?.gam_path !== '/123/test/' || config.enablePrebid !== false) {
      throw new WorkspaceError(409,'Choose an exact runtime for this site before generating.');
    }
    return pinRuntime(runtimeDescriptor,{allowPreview:true});
  }
  return (await readPinnedSiteRuntime({siteId:TEST_SITE,snapshot:{...settings,prebidBuilds:[]},catalog:[runtimeDescriptor]})).pin;
}
