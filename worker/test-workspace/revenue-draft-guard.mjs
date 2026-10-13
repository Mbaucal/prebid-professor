/** Legacy TEST editors may change their own fields, never orphan saved intent.
 * Demand OFF preserves contracts; it is not permission to invalidate references.
 * This is configuration validation only, outside every frozen runtime source.
 */
import {normalizeDeals,assertManagedDealParams} from '../../shared/deals/contract.mjs';
import {normalizeOutstream,outstreamContext} from '../../shared/outstream/selected-settings.mjs';
import {outstreamSizingReview} from '../../shared/outstream/settings-v3.mjs';
import {WorkspaceError} from './boundary.mjs';
export function assertRevenueDraftPreserved(before,after,{allowResponsiveMapReview=false}={}){
 const previous=JSON.parse(before.config.config_json),next=JSON.parse(after.config.config_json);
 for(const key of ['deals','outstream'])if(JSON.stringify(previous.runtimeControls?.[key])!==JSON.stringify(next.runtimeControls?.[key]))
  throw new WorkspaceError(409,'Reload the editor. Deals and Formats must be changed in their own forms.');
 const referenced=new Set([
  ...(previous.runtimeControls?.deals?.entries??[]).flatMap(entry=>entry.positions??[]),
  ...Object.entries(previous.runtimeControls?.outstream?.units??{}).filter(([,value])=>value?.format!=='banner').map(([code])=>code),
 ]);
 for(const code of referenced){
  const unit=after.units.find(u=>u.code===code);
  if(!unit||!unit.enabled||unit.media_type!=='banner'||unit.type==='DRAFT')throw new WorkspaceError(409,'Remove this position from Deals and set its format to Banner before renaming, disabling or changing it.');
 }
 try{
  const deals=normalizeDeals(next.runtimeControls?.deals,{bidders:after.bidders,units:after.units});
  assertManagedDealParams(deals,after);
  // Explicit OFF is allowed, but all retained video settings must remain usable
  // with the retained partner/file if the operator enables Prebid again.
  const context={...outstreamContext(after),enablePrebid:true};
  const mapsChanged=JSON.stringify(before.maps)!==JSON.stringify(after.maps)||JSON.stringify(before.units.map(u=>[u.code,u.size_map_key]))!==JSON.stringify(after.units.map(u=>[u.code,u.size_map_key]));
  const allowUnresolvedSizing=allowResponsiveMapReview&&context.responsiveSizing&&mapsChanged;
  normalizeOutstream(next.runtimeControls?.outstream,context,{allowUnresolvedSizing});
  return allowUnresolvedSizing?outstreamSizingReview(next.runtimeControls?.outstream,context):[];
 }catch(error){throw new WorkspaceError(422,error.message);}
}
