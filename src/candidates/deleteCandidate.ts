/**
 * Removing ONE candidate from a job. Shared by:
 *   - the trash button on the job's Candidates tab / in the candidate popup
 *     (DELETE /jobs/:id/candidates/:candidateId)
 *   - the AI's red "Remove candidate" card in the chat (after the recruiter presses Confirm)
 * so both behave and log exactly the same.
 *
 * The person is deleted for good, but the activity log keeps a line saying who removed
 * whom (and the AI sees that line in its context). Pending chat cards about this person
 * are cancelled so they can't be confirmed later.
 */
import { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { resolveJob } from '../jobs/service.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { PendingActionModel } from '../models/chat.js';
import { jobCode } from '../models/counter.js';

export async function deleteCandidate(
  jobRef: string,
  candidateId: string,
  { userId, actor = 'recruiter' }: { userId: string; actor?: 'recruiter' | 'ai' },
) {
  const job = await resolveJob(jobRef);
  if (!Types.ObjectId.isValid(candidateId)) throw AppError.notFound('Candidate not found');
  // Only delete it if it really belongs to THIS job (a wrong pair is a 404, not a surprise delete).
  const candidate = await CandidateModel.findOneAndDelete({ _id: candidateId, jobId: job._id }).lean();
  if (!candidate) throw AppError.notFound('Candidate not found (maybe it was already removed).');

  await PendingActionModel.updateMany(
    { status: 'pending', 'payload.candidateId': String(candidate._id) },
    { $set: { status: 'cancelled', decidedAt: new Date() } },
  );
  const scoreText = candidate.score !== null && candidate.score !== undefined ? ` (score ${candidate.score})` : '';
  await ActivityModel.create({
    jobId: job._id,
    candidateId: candidate._id,
    type: 'candidate_deleted',
    actor,
    userId: new Types.ObjectId(userId),
    message: `Removed candidate ${candidate.name}${scoreText}${actor === 'ai' ? ' by the AI (confirmed in chat)' : ''}`,
  });
  return { jobId: String(job._id), jobCode: jobCode(job.jobNumber), candidateId: String(candidate._id), name: candidate.name };
}
