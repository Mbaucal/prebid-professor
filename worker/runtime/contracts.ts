/** Data crossing the native ESM runtime-service / TypeScript Worker boundary.
 * These are database snapshots, not client-supplied objects. JSON configuration
 * stays encoded until each runtime's own validator reads it.
 */
export type RuntimeDescriptor = Readonly<{
  id: string;
  version: string;
  codeSha256: string;
  configSchemaVersion: number;
  channel: 'stable' | 'preview';
  capabilities: readonly string[];
}>;
export type RuntimePin = Readonly<{
  schemaVersion: 1;
  runtimeId: string;
  runtimeVersion: string;
  runtimeSha256: string;
  configSchemaVersion: number;
  capabilities: readonly string[];
}>;
export type PrebidBuildSnapshot = {
  id: string; publisher_id: string; version: string; file_key: string;
  modules_json: string; status: string; uploaded_at: string;
};
export type PreviewSnapshot = {
  site: { id: string; name: string; domain: string; gam_path: string };
  config: { config_json: string };
  units: Array<{ code: string; type: string; media_type: string; size_map_key: string | null; enabled: number; sort_order: number }>;
  bidders: Array<{ bidder: string; params_json: string; enabled: number }>;
  overrides: Array<{ bidder: string; scope_type: string; scope_key: string; params_json: string; enabled: number }>;
  maps: Array<{ name: string; map_json: string }>;
  rules: Array<{ rule_key: string; rule_json: string }>;
};
export type PreviewSnapshotWithPrebid = PreviewSnapshot & { prebidBuilds: PrebidBuildSnapshot[] };
export type RuntimeServiceEnv = { DB?: D1Database; BUILDS?: R2Bucket };
export type SnapshotDatabase = Pick<D1Database, 'prepare' | 'batch'>;
