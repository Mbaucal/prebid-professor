import {requireRevenueRuntime as previousGuard} from '../runtime-319/settings-guard.mjs';
export {hasRevenueSettings, requireCountryRules} from '../runtime-319/settings-guard.mjs';
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.19.1' && descriptor.version === '3.19.1') return;
  previousGuard(config, descriptor);
}
