import { descriptorForPin, previewInput } from './private-runtime-catalog.mjs';
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { readSiteDraft, planSiteDraft } from './site-draft.mjs';
import { commitSiteDraft } from './site-draft-store.mjs';
import { selectedWorkspacePin } from './runtime-selection.mjs';
import { TEST_SITE, WorkspaceError } from './boundary.mjs';
import { takeOverForBuild } from './takeover-settings.mjs';
const read=(env)=>readPreviewSnapshot(env.DB.withSession('first-primary'),TEST_SITE,{includePrebid:true});
export async function getSiteDraft(env) {
  const saved=await read(env),draft=readSiteDraft(saved);
  // Only editor-owned fields leave the service, never raw config or connector data.
  return {draft,revision:await digest(saved),siteId:TEST_SITE,publishable:false,prebidEditable:false,
    needsRuntimeSelection:!JSON.parse(saved.config.config_json).builtinRuntimeSelection};
}
export async function saveSiteDraft(env,actor,body) {
  const plan=await planSiteDraft(await read(env),body);
  const pin=JSON.parse(plan.after.config.config_json).builtinRuntimeSelection.runtime;
  try{previewInput(plan.after,descriptorForPin(pin),'20260913_000000',takeOverForBuild(plan.after));}
  catch(error){throw new WorkspaceError(422,error.message);}
  await selectedWorkspacePin(plan.after,env.BUILDS);
  return commitSiteDraft({isolation:'explicit-test-store',db:env.DB},plan,actor);
}
