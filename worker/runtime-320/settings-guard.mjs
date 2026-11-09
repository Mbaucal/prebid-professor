import {hasRevenueSettings, requireRevenueRuntime as previousGuard} from '../runtime-319/settings-guard.mjs';
export {hasRevenueSettings};
export {requireCountryRules} from '../runtime-319/settings-guard.mjs';
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.20.0' && descriptor.version === '3.20.0') return;
  previousGuard(config, descriptor);
}
