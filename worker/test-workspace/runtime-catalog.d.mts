import type { PreviewSnapshotWithPrebid, RuntimeDescriptor, RuntimePin } from '../runtime/contracts';
export const runtimeCatalog: RuntimeDescriptor[];
export const runtimeDescriptor: RuntimeDescriptor;
export function prepareSiteRuntimeSelection(args: {
  siteId: string;
  snapshot: PreviewSnapshotWithPrebid;
  catalog: readonly RuntimeDescriptor[];
  expectedRevision: string;
  selection: { runtime: RuntimePin; allowPreview: boolean; enablePrebid: boolean; prebidBuildId: string | null };
}, bucket?: R2Bucket): Promise<{
  siteId: string; basedOnRevision: string; configJson: string;
  selection: {
    schemaVersion: 1; runtime: RuntimePin;
    prebid: { id: string; version: string; sha256: string; byteSize: number; modules: string[] } | null;
  };
  changed: boolean; persisted: false; publishable: false;
}>;
