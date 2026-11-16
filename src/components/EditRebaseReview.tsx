import type { RebaseReview } from '../edit-rebase';
import './edit-rebase-review.css';

/** After a save was refused and rebased: fields both tabs changed, with both values, then the changes kept. */
export default function EditRebaseReview({ review }: { review: RebaseReview }) {
  if (!review.conflicts.length && !review.applied.length) return null;
  return (
    <div className="edit-rebase-review" role="status">
      {review.conflicts.length ? (
        <>
          <strong>Also changed in the other tab. The form keeps your value; check it before saving:</strong>
          <ul>
            {review.conflicts.map((conflict) => (
              <li key={conflict.field}><b>{conflict.field}</b>: yours {conflict.yours}, saved in the other tab {conflict.saved}</li>
            ))}
          </ul>
        </>
      ) : null}
      {review.applied.length ? (
        <p>{review.conflicts.length ? 'Your other changes are applied' : 'Your changes are applied'}: {review.applied.join(', ')}.</p>
      ) : null}
    </div>
  );
}
