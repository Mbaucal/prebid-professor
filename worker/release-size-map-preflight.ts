import type { ReleaseEnv } from './releases';
import {
  generateReleaseWithFlexibleSizes,
  validateReleaseWithFlexibleSizes,
} from './release-size-map-compat';

type JsonRecord = Record<string, unknown>;

type TransformState = {
  transformedFirstSizeMapRead: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The legacy release compiler understands only numeric banner sizes. The
 * compatibility layer patches the final artifacts with the real `fluid` and
 * empty-breakpoint values, but the legacy preflight still needs one harmless
 * numeric placeholder so a fluid-only map is not rejected before patching.
 */
function numericPlaceholderMap(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return raw;
    const mapped = parsed.map((entry) => {
      if (!isRecord(entry) || !Array.isArray(entry.sizes)) return entry;
      return {
        ...entry,
        sizes: entry.sizes.map((size) => {
          return typeof size === 'string' && size.trim().toLowerCase() === 'fluid'
            ? [1, 1]
            : size;
        }),
      };
    });
    return JSON.stringify(mapped);
  } catch {
    return raw;
  }
}

function wrapSizeMapStatement(
  statement: D1PreparedStatement,
  state: TransformState,
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...values: unknown[]) => wrapSizeMapStatement(target.bind(...values), state);
      }

      if (property === 'all') {
        return async (...values: unknown[]) => {
          const result = await (target.all as (...args: unknown[]) => Promise<D1Result<JsonRecord>>)(...values);
          if (state.transformedFirstSizeMapRead) return result;
          state.transformedFirstSizeMapRead = true;
          return {
            ...result,
            results: (result.results ?? []).map((row) => {
              if (!isRecord(row) || typeof row.map_json !== 'string') return row;
              return { ...row, map_json: numericPlaceholderMap(row.map_json) };
            }),
          };
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1PreparedStatement;
}

function withLegacyPreflightSizeMapProxy(env: ReleaseEnv): ReleaseEnv {
  if (!env.DB) return env;
  const originalDb = env.DB;
  const state: TransformState = { transformedFirstSizeMapRead: false };

  const proxiedDb = new Proxy(originalDb, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query);
          return /\bfrom\s+size_maps\b/i.test(query)
            ? wrapSizeMapStatement(statement, state)
            : statement;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;

  return { ...env, DB: proxiedDb };
}

export function validateReleaseWithFluidPreflight(env: ReleaseEnv, siteId: string): Promise<Response> {
  return validateReleaseWithFlexibleSizes(withLegacyPreflightSizeMapProxy(env), siteId);
}

export function generateReleaseWithFluidPreflight(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  return generateReleaseWithFlexibleSizes(request, withLegacyPreflightSizeMapProxy(env), siteId);
}
