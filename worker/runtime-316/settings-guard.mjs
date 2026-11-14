import {hasRevenueSettings} from '../runtime-revenue-v1/settings-guard.mjs';
export {hasRevenueSettings};
export const REVENUE_RUNTIME_IDS=['tessera-revenue-preview-1','tessera-revenue-preview-2','tessera-revenue-preview-3','tessera-3.16.0'];
export function requireRevenueRuntime(config,descriptor) {
  if(hasRevenueSettings(config)&&!REVENUE_RUNTIME_IDS.includes(descriptor?.id))
    throw Error('Active Deals or Outstream require Tessera 3.16.0 or a saved compatible version. Existing packages remain available in Releases.');
}
