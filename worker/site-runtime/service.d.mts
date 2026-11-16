import type { PrebidBuildSnapshot, PreviewSnapshotWithPrebid, RuntimeServiceEnv } from '../runtime/contracts';
export class SiteRuntimeError extends Error { constructor(message: string, status?: number); status: number; }
export function siteRuntimeResponse(request: Request, env: RuntimeServiceEnv, siteId: string, actor: string): Promise<Response>;
export function commitSiteConfiguration(env: RuntimeServiceEnv, snapshot: PreviewSnapshotWithPrebid, configJson: string, actor: string | null, options?: {
  activation?: PrebidBuildSnapshot | null;
  audit?: { action: string; entityType?: string; entityId?: string; details?: Record<string, unknown> } | null;
}): Promise<{ changed: boolean; persisted: true; publishable: false }>;
