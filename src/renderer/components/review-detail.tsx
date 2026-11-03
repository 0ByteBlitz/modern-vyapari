import type { JournalEntry } from "@/lib/api";
import { readReview } from "@/lib/review-entry";
import { DetailModal } from "@/components/detail-modal";

/**
 * One review, in full. The dashboard row is a preview clamped to a few lines;
 * this is where the rest of it is read. The same text is in the Journal.
 */
export function ReviewDetail({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
  const review = readReview(entry);
  return (
    <DetailModal
      kind="Review"
      title={review.name ?? "Review"}
      badge={<span className={`v-${review.outcome.tone}`} style={{ fontWeight: 600 }}>{review.outcome.label}</span>}
      onClose={onClose}
    >
      <div className="review-detail-meta">
        {review.header && <span className="mono">{review.header}</span>}
        <span>{new Date(entry.created_at).toLocaleString()}</span>
      </div>
      <p className="review-detail-text">{review.body}</p>
    </DetailModal>
  );
}
