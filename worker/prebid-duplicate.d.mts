export function prepareDuplicatedPrebid(
  env: { DB?: D1Database; BUILDS?: R2Bucket }, sourceId: string, siteId: string,
  config: Record<string, unknown>, copyBuild: boolean,
): Promise<{
  build: { id: string; version: string; file_key: string; file_url: string; modules_json: string } | null;
  sourceRows: Array<Record<string, unknown>>;
}>;
