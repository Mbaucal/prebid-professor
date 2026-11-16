import {hasRevenueSettings, requireRevenueRuntime as previousGuard} from '../runtime-3161/settings-guard.mjs';
export {hasRevenueSettings};
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.16.2' && descriptor.version === '3.16.2') return;
  previousGuard(config, descriptor);
}
