import {requireRevenueRuntime as previousGuard} from '../runtime-321/settings-guard.mjs';
export {hasRevenueSettings, requireCountryRules} from '../runtime-321/settings-guard.mjs';
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.22.0' && descriptor.version === '3.22.0') return;
  previousGuard(config, descriptor);
}
