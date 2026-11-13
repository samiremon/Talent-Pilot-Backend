/**
 * Changing a candidate's CONTACT details: email and profile link. Shared by:
 *   - the Edit button on the job's Candidates tab / in the candidate popup
 *     (PATCH /jobs/:id/candidates/:candidateId)
 *   - the AI's "Edit contact" card in the chat (after the recruiter presses Confirm)
 * so both behave and log exactly the same.
 *
 * Typical use: people found by web search have a profile link but never an email; the
 * recruiter adds it once they have it.
 *
 * Rules:
 *   - only the fields sent are changed; send "" (or null) to remove one
 *   - the email must look like an email, the link like a web address (both are saved in
 *     the same normalised form as on import: lowercase email, clean link)
 *   - a candidate keeps at least one of the two (same rule as when adding someone)
 *   - two candidates in the same job can't share an email or a profile link
 */
import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { resolveJob } from '../jobs/service.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { normalizeEmail, normalizeProfileUrl } from './normalize.js';

const optionalContact = z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(500).nullable().optional());

export const contactInput = z
  .object({ email: optionalContact, profileUrl: optionalContact })
  .refine((v) => v.email !== undefined || v.profileUrl !== undefined, { message: 'Send an email or a profile link to change.' });
export type ContactInput = z.infer<typeof contactInput>;

/** MongoDB's error code for "this would break a unique index" (same email/link in the job). */
const DUPLICATE_KEY = 11000;

export async function updateCandidateContact(
  jobRef: string,
  candidateId: string,
  raw: unknown,
  { userId, actor = 'recruiter' }: { userId: string; actor?: 'recruiter' | 'ai' },
) {
  const input = contactInput.parse(raw);
  const job = await resolveJob(jobRef);
  if (!Types.ObjectId.isValid(candidateId)) throw AppError.notFound('Candidate not found');
  const candidate = await CandidateModel.findOne({ _id: candidateId, jobId: job._id });
  if (!candidate) throw AppError.notFound('Candidate not found (maybe it was removed).');

  // Check and normalise what was sent (null = remove it).
  const changes: { email?: string | null; profileUrl?: string | null } = {};
  if (input.email !== undefined) {
    const email = input.email === null ? null : normalizeEmail(input.email);
    if (input.email !== null && !email) {
      throw new AppError(400, 'VALIDATION_ERROR', 'This email address is not valid. Please check it.', [{ path: 'email', message: 'is not a valid email' }]);
    }
    changes.email = email;
  }
  if (input.profileUrl !== undefined) {
    const url = input.profileUrl === null ? null : normalizeProfileUrl(input.profileUrl);
    if (input.profileUrl !== null && !url) {
      throw new AppError(400, 'VALIDATION_ERROR', 'This profile link is not a valid web address.', [{ path: 'profileUrl', message: 'is not a valid link' }]);
    }
    changes.profileUrl = url;
  }

  const email = changes.email !== undefined ? changes.email : candidate.email;
  const profileUrl = changes.profileUrl !== undefined ? changes.profileUrl : candidate.profileUrl;
  if (!email && !profileUrl) {
    throw new AppError(400, 'CANDIDATE_INVALID', 'Keep an email address or a profile link (or both), so we can tell people apart and contact them.');
  }

  // Nothing actually different? Then nothing to save or log.
  const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter((k) => (changes[k] ?? null) !== (candidate[k] ?? null));
  if (changed.length === 0) return { candidate: presentContact(candidate), changed: [] as string[] };

  // Someone else in this job already has it?
  const clash = await CandidateModel.findOne({
    jobId: job._id,
    _id: { $ne: candidate._id },
    $or: [...(changes.email ? [{ email: changes.email }] : []), ...(changes.profileUrl ? [{ profileUrl: changes.profileUrl }] : [])],
  }).lean();
  if (clash && (changes.email || changes.profileUrl)) {
    throw new AppError(409, 'CANDIDATE_DUPLICATE', `${clash.name} in this job already has this ${clash.email && clash.email === changes.email ? 'email' : 'profile link'}.`);
  }

  for (const key of changed) candidate.set(key, changes[key] ?? null);
  try {
    await candidate.save();
  } catch (err) {
    // Two people saved the same email at the very same moment.
    if ((err as { code?: number }).code === DUPLICATE_KEY) throw new AppError(409, 'CANDIDATE_DUPLICATE', 'Another candidate in this job already has this email or profile link.');
    throw err;
  }

  const labels = changed.map((k) => (k === 'email' ? 'email' : 'profile link'));
  await ActivityModel.create({
    jobId: job._id,
    candidateId: candidate._id,
    type: 'candidate_updated',
    actor,
    userId: new Types.ObjectId(userId),
    message: `Updated ${candidate.name}'s ${labels.join(' and ')}${actor === 'ai' ? ' (by the AI, confirmed in chat)' : ''}`,
  });
  return { candidate: presentContact(candidate), changed: labels };
}

function presentContact(c: { _id: unknown; name: string; email?: string | null; profileUrl?: string | null }) {
  return { id: String(c._id), name: c.name, email: c.email ?? null, profileUrl: c.profileUrl ?? null };
}
