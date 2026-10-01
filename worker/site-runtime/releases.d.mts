import type { RuntimeServiceEnv } from '../runtime/contracts';
export function packageResponse(request: Request, env: RuntimeServiceEnv, siteId: string, actor: string, options?: { testOnly?: boolean }): Promise<Response>;
export function packageAssetResponse(request: Request, env: RuntimeServiceEnv, siteId: string, id: string, name: string | null): Promise<Response>;
export function builtInCdn(request: Request, env: RuntimeServiceEnv): Promise<Response | null>;
