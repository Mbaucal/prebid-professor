/** Reserved IDs cannot use legacy promotion/deletion/dispatch paths.
 * A stored review package is not a production-approved release.
 */
export function isStoredBuiltinDraft(release) {
  return [release?.id, release?.version].some((value) => typeof value === 'string' && value.startsWith('builtin-draft-'));
}
export const STORED_DRAFT_BLOCK = 'This built-in draft is a review package. Publication, rollback and deletion require the dedicated verified release workflow; legacy actions are blocked.';
