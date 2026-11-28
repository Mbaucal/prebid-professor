import {hasRevenueSettings, requireRevenueRuntime as previousGuard} from '../runtime-316/settings-guard.mjs';
export {hasRevenueSettings};
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.16.1' && descriptor.version === '3.16.1') return;
  previousGuard(config, descriptor);
}
