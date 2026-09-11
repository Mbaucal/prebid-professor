/** Reserved IDs cannot use legacy promotion/deletion/dispatch paths.
 * A stored review package is not a production-approved release.
 */
export function isStoredBuiltinDraft(release) {
  return [release?.id, release?.version].some((value) => typeof value === 'string' && value.startsWith('builtin-draft-'));
}
export const STORED_DRAFT_BLOCK = 'This built-in draft is a review package. Publication, rollback and deletion require the dedicated verified release workflow; legacy actions are blocked.';

/** Prevent direct public CDN URLs from bypassing the draft publication guard. */
export function blockStoredDraftCdn(request) {
  const match = new URL(request.url).pathname.match(/^\/cdn\/[^/]+\/releases\/([^/]+)\//);
  if (!match) return null;
  let version;
  try { version = decodeURIComponent(match[1]); } catch { return new Response('Not found.', { status: 404, headers: { 'cache-control': 'private, no-store' } }); }
  if (!isStoredBuiltinDraft({ version })) return null;
  return new Response(request.method === 'HEAD' ? null : 'Not found.', {
    status: 404, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  });
}
