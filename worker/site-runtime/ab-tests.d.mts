import type {RuntimeServiceEnv} from '../runtime/contracts';
/** Receives an authenticated administrator email; the router enforces same-origin mutations. */
export function mainAbTestsResponse(request: Request, env: RuntimeServiceEnv, site: string, actor: string): Promise<Response>;
