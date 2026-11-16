import type { RuntimeServiceEnv } from '../runtime/contracts';
export function packageTestPageResponse(request: Request, env: RuntimeServiceEnv, siteId: string, releaseId: string, options?: { testOnly?: boolean }): Promise<Response>;
