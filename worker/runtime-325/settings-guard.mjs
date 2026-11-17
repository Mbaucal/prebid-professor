import {requireRevenueRuntime as previousGuard} from '../runtime-324/settings-guard.mjs';
export {hasRevenueSettings, requireCountryRules} from '../runtime-324/settings-guard.mjs';
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.25.0' && descriptor.version === '3.25.0') return;
  previousGuard(config, descriptor);
}
