import { listUnitRules, createUnitRule, updateUnitRule, duplicateUnitRule, deleteUnitRule } from '../unit-rules.ts';
import { listAdUnits } from '../ad-units.ts';
import { listSizeMaps } from '../size-maps.ts';
import { withAuthenticatedActor } from '../http.ts';
import { siteRuntimeResponse } from '../site-runtime/service.mjs';
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { assertWorkspaceSiteScope } from './site-draft.mjs';
import { inspectTestSchema } from './schema.mjs';
import { jsonBody, TEST_SITE, WorkspaceError } from './boundary.mjs';

const base = `/api/publishers/${TEST_SITE}`;
const item = /^\/api\/publishers\/test-site\/unit-rules\/([A-Za-z0-9_-]{1,128})$/;
const duplicate = /^\/api\/publishers\/test-site\/unit-rules\/([A-Za-z0-9_-]{1,128})\/duplicate$/;

// The outer TEST router permits PATCH/DELETE only for this exact resource.
export function isTestUnitRuleItemPath(path) { return item.test(path); }

// Called only after TEST identity, same-origin and authenticated-session checks.
// This is a fixed TEST-site adapter, never a fallback to the MAIN admin router.
export async function unitRulesResponse(request, env, actor, headers) {
  const url = new URL(request.url), path = url.pathname;
  const itemMatch = path.match(item), duplicateMatch = path.match(duplicate);
  const collection = path === `${base}/unit-rules`;
  const readOnly = [`${base}/ad-units`, `${base}/size-maps`, `${base}/builtin-site-settings`].includes(path);
  if (!collection && !itemMatch && !duplicateMatch && !readOnly) return null;
  if (url.search) throw new WorkspaceError(404, 'This operation is not available in the test workspace.');
  const allowed = readOnly ? ['GET'] : collection ? ['GET', 'POST'] : itemMatch ? ['PATCH', 'DELETE'] : ['POST'];
  if (!allowed.includes(request.method)) throw new WorkspaceError(405, 'Method not allowed.');
  if (!(await inspectTestSchema(env.DB)).ready) throw new WorkspaceError(409, 'Prepare TEST data first.');
  assertWorkspaceSiteScope(await readPreviewSnapshot(env.DB.withSession('first-primary'), TEST_SITE, { includePrebid: true }));

  let verified = request;
  if (request.method === 'POST' || request.method === 'PATCH') {
    const fields = duplicateMatch ? ['ruleKey'] : collection ? ['ruleKey', 'rule', 'followInheritedSchedule'] : ['rule', 'expectedUpdatedAt'];
    const body = await jsonBody(request, fields, 262144);
    verified = new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body) });
  }
  // getActor uses a server-only Symbol; caller identity headers are overwritten.
  verified = withAuthenticatedActor(verified, actor.email);
  let response;
  if (path === `${base}/ad-units`) response = await listAdUnits(env, TEST_SITE);
  else if (path === `${base}/size-maps`) response = await listSizeMaps(env, TEST_SITE);
  else if (path === `${base}/builtin-site-settings`) response = await siteRuntimeResponse(verified, env, TEST_SITE, actor.email, { testOnly: true });
  else if (duplicateMatch) response = await duplicateUnitRule(verified, env, TEST_SITE, duplicateMatch[1]);
  else if (itemMatch) response = request.method === 'PATCH'
    ? await updateUnitRule(verified, env, TEST_SITE, itemMatch[1])
    : await deleteUnitRule(verified, env, TEST_SITE, itemMatch[1]);
  else response = request.method === 'GET' ? await listUnitRules(env, TEST_SITE) : await createUnitRule(verified, env, TEST_SITE);
  return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
}
