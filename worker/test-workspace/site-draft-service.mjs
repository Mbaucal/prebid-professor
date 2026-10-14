import { descriptorForPin, previewInput } from './runtime-catalog.mjs';
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { readSiteDraft, planSiteDraft } from './site-draft.mjs';
import { commitSiteDraft } from './site-draft-store.mjs';
import { selectedWorkspacePin } from './runtime-selection.mjs';
import { TEST_SITE, WorkspaceError } from './boundary.mjs';
import { takeOverForBuild } from './takeover-settings.mjs';
import { assertRevenueDraftPreserved } from './revenue-draft-guard.mjs';
import {outstreamSizingReview,outstreamContext} from '../../shared/outstream/settings-v3.mjs';
const reviews=snapshot=>outstreamSizingReview(JSON.parse(snapshot.config.config_json).runtimeControls?.outstream,outstreamContext(snapshot));
const read=(env)=>readPreviewSnapshot(env.DB.withSession('first-primary'),TEST_SITE,{includePrebid:true});
export async function getSiteDraft(env) {
  const saved=await read(env),draft=readSiteDraft(saved);
  // Only editor-owned fields leave the service, never raw config or connector data.
  return {draft,revision:await digest(saved),siteId:TEST_SITE,publishable:false,prebidEditable:false,
    formatReviewRequired:reviews(saved),
    needsRuntimeSelection:!JSON.parse(saved.config.config_json).builtinRuntimeSelection};
}
export async function saveSiteDraft(env,actor,body) {
  const plan=await planSiteDraft(await read(env),body);
  const formatReviewRequired=assertRevenueDraftPreserved(plan.before,plan.after,{allowResponsiveMapReview:true});
  // Validate all remaining generator/Prebid constraints without fabricating sizes.
  // Only already validated pending video intent is excluded from this read-only
  // compatibility check. The persisted plan retains every original format field.
  let compatibility=plan.after;
  if(formatReviewRequired.length){
    const config=JSON.parse(plan.after.config.config_json),pending=new Set(formatReviewRequired.map(issue=>issue.code));
    config.runtimeControls.outstream={...config.runtimeControls.outstream,units:Object.fromEntries(Object.entries(config.runtimeControls.outstream.units).filter(([code])=>!pending.has(code)))};
    compatibility={...plan.after,config:{...plan.after.config,config_json:JSON.stringify(config)}};
  }
  const pin=JSON.parse(plan.after.config.config_json).builtinRuntimeSelection.runtime;
  try{previewInput(compatibility,descriptorForPin(pin),'20260913_000000',takeOverForBuild(compatibility));}
  catch(error){throw new WorkspaceError(422,error.message);}
  await selectedWorkspacePin(compatibility,env.BUILDS);
  return {...await commitSiteDraft({isolation:'explicit-test-store',db:env.DB},plan,actor),formatReviewRequired};
}
