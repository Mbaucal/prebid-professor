export const CACHE_POSITIONS: readonly string[];
export function positionCacheOverrides(value: unknown): Record<string, boolean>;
export function hasBidCache(settings: {
  enabled: boolean;
  positionOverrides?: Record<string, boolean>;
}): boolean;
