export function deploymentManifestPin(bucket: R2Bucket | undefined, siteId: string, release: {
  id: string; version: string; manifest_key: string | null; config_hash: string | null;
}): Promise<string>;
