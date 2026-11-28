export const REVENUE_RUNTIME_ID='tessera-revenue-preview-1';
export function hasRevenueSettings(config) {
  if(config?.enablePrebid!==true)return false;
  return !!config.runtimeControls?.deals?.entries?.some(entry=>entry?.enabled===true) ||
    Object.values(config.runtimeControls?.outstream?.units??{}).some(unit=>unit?.format!=='banner');
}
/** Old saved packages stay readable; new generation must not discard saved intent. */
export function requireRevenueRuntime(config,descriptor) {
  if(hasRevenueSettings(config)&&descriptor?.id!==REVENUE_RUNTIME_ID)
    throw Error('Active Deals or Outstream require the explicitly selected revenue preview. Existing packages remain available in Releases.');
}
