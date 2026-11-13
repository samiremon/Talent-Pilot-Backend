/**
 * One-off data fixes, run at startup (safe to run again: they only touch what still needs it).
 *
 * migrateReviewRejections(): "Rejected" used to also mean "not a fit" at REVIEW time.
 * Now review uses "Not accepted" and "Rejected" is for after the interview. Candidates
 * who were rejected straight from Sourced or Accepted become "Not accepted", and that
 * activity-log line is updated to match (so the timeline and Undo stay consistent).
 */
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';

export async function migrateReviewRejections(): Promise<number> {
  const rows = await ActivityModel.find({
    type: 'status_changed',
    toStatus: 'rejected',
    fromStatus: { $in: ['sourced', 'accepted'] },
    undone: { $ne: true },
  }).lean();
  let moved = 0;
  for (const row of rows) {
    if (!row.candidateId) continue;
    // Only if they're still Rejected (i.e. this was their latest move).
    const updated = await CandidateModel.updateOne({ _id: row.candidateId, status: 'rejected' }, { $set: { status: 'not_accepted' } });
    await ActivityModel.updateOne(
      { _id: row._id },
      { $set: { toStatus: 'not_accepted', message: row.message.replace(/→ Rejected$/, '→ Not accepted') } },
    );
    moved += updated.modifiedCount;
  }
  return moved;
}
