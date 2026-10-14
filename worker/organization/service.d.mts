export function organizationResponse(request: Request, env: { DB?: D1Database }, actor: string | undefined, options?: {
  prefix?: string; mode?: 'production' | 'test';
}): Promise<Response>;
