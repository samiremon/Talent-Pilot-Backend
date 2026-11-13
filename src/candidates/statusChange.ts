/**
 * The ONE way to change a candidate's status.
 *
 * Buttons in the UI, the AI chat ("mark Rahim as hired") and background jobs all call
 * changeCandidateStatus(). It:
 *   1. checks the move against the pipeline rules (pipeline/status.ts);
 *      if not allowed, it throws a 409 error whose message explains why
 *   2. saves the new status
 *   3. writes an Activity row: who, from what, to what, when
 *
 * undoStatusChange() reverses a change using that Activity row.
 */
import { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { ActivityModel, type Actor } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { STATUS_LABELS, checkMove, type CandidateStatus } from '../pipeline/status.js';

export interface StatusChangeInput {
  candidateId: string | Types.ObjectId;
  to: CandidateStatus;
  actor: Actor;
  /** The recruiter's id when actor is 'recruiter'. */
  userId?: string | Types.ObjectId | null;
}

export async function changeCandidateStatus({ candidateId, to, actor, userId = null }: StatusChangeInput) {
  const candidate = await CandidateModel.findById(candidateId);
  if (!candidate) throw AppError.notFound('Candidate not found');

  const from = candidate.status as CandidateStatus;
  const check = checkMove(from, to, candidate.name);
  if (!check.allowed) throw new AppError(409, 'STATUS_NOT_ALLOWED', check.reason, { from, to });

  // Save only if the status is STILL what we just read. If something else changed it in
  // the meantime (e.g. a background job), we don't overwrite their change blindly.
  const updated = await CandidateModel.findOneAndUpdate(
    { _id: candidate._id, status: from },
    { $set: { status: to } },
    { new: true },
  );
  if (!updated) {
    throw AppError.conflict(`${candidate.name}'s status changed a moment ago. Please refresh and try again.`);
  }

  // Note: MongoDB transactions need a replica set, which the demo setup doesn't run.
  // If the server crashed between these two writes, the status would change without
  // a log entry. Acceptable for this project; mentioned in the README trade-offs.
  const activity = await ActivityModel.create({
    jobId: candidate.jobId,
    candidateId: candidate._id,
    type: 'status_changed',
    actor,
    userId,
    message: `${candidate.name}: ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`,
    fromStatus: from,
    toStatus: to,
  });

  return { candidate: updated, activity };
}

/**
 * Undo: put the candidate back to the status they had before `activityId`.
 *
 * This deliberately skips the normal rules (going backwards is the whole point), but
 * it's only allowed if:
 *   - the activity is a status change that hasn't been undone already, and
 *   - the candidate is still in the status that change put them in
 *     (if they've moved on since, undoing the older change would be confusing).
 */
export async function undoStatusChange({
  activityId,
  actor,
  userId = null,
}: {
  activityId: string | Types.ObjectId;
  actor: Actor;
  userId?: string | Types.ObjectId | null;
}) {
  const original = await ActivityModel.findById(activityId);
  if (!original || original.type !== 'status_changed' || !original.candidateId) {
    throw AppError.notFound('Status change not found');
  }
  if (original.undone) throw AppError.conflict('This change has already been undone');

  const from = original.toStatus as CandidateStatus;
  const back = original.fromStatus as CandidateStatus;

  const candidate = await CandidateModel.findOneAndUpdate(
    { _id: original.candidateId, status: from },
    { $set: { status: back } },
    { new: true },
  );
  if (!candidate) {
    throw AppError.conflict("Can't undo: the candidate's status has changed since. Undo the newer change first.");
  }

  // Mark the original as undone only if nobody beat us to it.
  await ActivityModel.updateOne({ _id: original._id, undone: false }, { $set: { undone: true } });

  const activity = await ActivityModel.create({
    jobId: original.jobId,
    candidateId: original.candidateId,
    type: 'status_undone',
    actor,
    userId,
    message: `${candidate.name}: undo, back to ${STATUS_LABELS[back]}`,
    fromStatus: from,
    toStatus: back,
    undoOf: original._id,
  });

  return { candidate, activity };
}
