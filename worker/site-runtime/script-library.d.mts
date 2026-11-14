import type { RuntimeServiceEnv } from '../runtime/contracts';
export function scriptLibraryResponse(request: Request, env: RuntimeServiceEnv, siteId: string, collection: string | null, id: string | null, actor: string): Promise<Response>;
