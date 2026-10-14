import type { PreviewSnapshot, PreviewSnapshotWithPrebid, RuntimeDescriptor, RuntimeServiceEnv, SnapshotDatabase } from './contracts';
export const runtimeDescriptor: RuntimeDescriptor;
export function readPreviewSnapshot(db: SnapshotDatabase | undefined, siteId: string, options: { includePrebid: true }): Promise<PreviewSnapshotWithPrebid>;
export function readPreviewSnapshot(db: SnapshotDatabase | undefined, siteId: string, options?: { includePrebid?: false }): Promise<PreviewSnapshot>;
export function handleBuiltinPreview(request: Request, env: RuntimeServiceEnv, siteId: string): Promise<Response>;
