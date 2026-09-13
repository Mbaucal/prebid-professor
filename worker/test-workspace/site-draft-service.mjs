import { readPreviewSnapshot, runtimeDescriptor } from '../runtime/builtin-preview-service.mjs';
import { digest, previewInput } from '../runtime/preview-snapshot.mjs';
import { readSiteDraft, planSiteDraft } from './site-draft.mjs';
import { commitSiteDraft } from './site-draft-store.mjs';
import { selectedWorkspacePin } from './runtime-selection.mjs';
import { TEST_SITE, WorkspaceError } from './boundary.mjs';
const read=(env)=>readPreviewSnapshot(env.DB.withSession('first-primary'),TEST_SITE,{includePrebid:true});
export async function getSiteDraft(env) {
  const saved=await read(env),draft=readSiteDraft(saved);
  // Only editor-owned fields leave the service, never raw config or connector data.
  return {draft,revision:await digest(saved),siteId:TEST_SITE,publishable:false,prebidEditable:false,
    needsRuntimeSelection:!JSON.parse(saved.config.config_json).builtinRuntimeSelection};
}
export async function saveSiteDraft(env,actor,body) {
  const plan=await planSiteDraft(await read(env),body);
  await selectedWorkspacePin(plan.after,env.BUILDS);
  try{previewInput(plan.after,runtimeDescriptor,'20260913_000000',{enabled:false});}
  catch{throw new WorkspaceError(422,'These settings are not supported by the selected script. Review the positions, size maps and existing advanced rules.');}
  return commitSiteDraft({isolation:'explicit-test-store',db:env.DB},plan,actor);
}
