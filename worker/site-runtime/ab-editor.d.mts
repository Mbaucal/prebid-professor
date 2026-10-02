import type { RuntimeServiceEnv } from '../runtime/contracts';
export function abEditorResponse(request: Request, env: RuntimeServiceEnv, siteId: string, resource: string | null, actor: string): Promise<Response>;
