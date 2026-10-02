import type { readPreviewSnapshot } from './builtin-preview-service.mjs';
import type { previewInput, digest } from './preview-snapshot.mjs';
import type { RuntimeDescriptor, RuntimeServiceEnv } from './contracts';
export function handlePrebidPreflight(request: Request, env: RuntimeServiceEnv, siteId: string, dependencies: {
  readSnapshot: typeof readPreviewSnapshot;
  normalizeInput: typeof previewInput;
  digest: typeof digest;
  runtime: RuntimeDescriptor;
}): Promise<Response>;
