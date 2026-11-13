/**
 * Adding ONE candidate by hand. Shared by:
 *   - the "Add candidate" form on the job page (POST /jobs/:id/candidates)
 *   - the AI's "Add candidate" card in the chat (after the recruiter presses Confirm)
 * so both behave and log exactly the same.
 *
 * Rules (same as a CSV row): a name, and at least an email or a profile link. Duplicates
 * (same email or profile link already in the job) are refused with a clear message.
 * After adding, AI scoring starts in the background, like after a CSV upload.
 */
import { z } from 'zod';
import { addCandidates, planCandidates } from '../candidates/addCandidates.js';
import { AppError } from '../errors.js';
import { CandidateModel } from '../models/candidate.js';
import { startScoring, type SourcingDeps } from './service.js';

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().default(null));

export const manualCandidateInput = z.object({
  name: z.string().trim().min(1, 'is required').max(200),
  email: optionalText(320),
  profileUrl: optionalText(500),
  headline: optionalText(300),
  location: optionalText(200),
  // What we know about them: what the AI scores. E.g. "2 years of experience with FastAPI".
  profileText: optionalText(10_000),
});
export type ManualCandidateInput = z.infer<typeof manualCandidateInput>;

export async function addManualCandidate(deps: SourcingDeps, jobId: string, raw: unknown, userId: string) {
  const input = manualCandidateInput.parse(raw);

  // Check first, so the recruiter gets a precise reason instead of "0 added".
  const plan = await planCandidates(jobId, [input]);
  if (plan.invalid) {
    throw new AppError(400, 'CANDIDATE_INVALID', 'Add an email address or a profile link (or both), so we can tell people apart and contact them.', [
      { path: 'email', message: 'or a profile link is needed' },
    ]);
  }
  if (plan.duplicates) {
    throw new AppError(409, 'CANDIDATE_DUPLICATE', `${input.name} is already a candidate for this job (same email or profile link).`);
  }

  const result = await addCandidates(jobId, 'manual', [input], 'recruiter', userId);
  if (result.added === 0) throw new AppError(409, 'CANDIDATE_DUPLICATE', `${input.name} is already a candidate for this job.`);

  const candidate = await CandidateModel.findOne({ jobId, name: input.name, source: 'manual' }).sort({ createdAt: -1 }).lean();
  const task = await startScoring(deps, jobId, userId);
  return { candidateId: candidate ? String(candidate._id) : null, name: input.name, task };
}
