import {requireRevenueRuntime as previousGuard} from '../runtime-319/settings-guard.mjs';
export {hasRevenueSettings, requireCountryRules} from '../runtime-319/settings-guard.mjs';
export function requireRevenueRuntime(config, descriptor) {
  if (['3.19.1', '3.20.0', '3.20.1'].some(version => descriptor?.id === 'tessera-' + version && descriptor.version === version)) return;
  previousGuard(config, descriptor);
}
