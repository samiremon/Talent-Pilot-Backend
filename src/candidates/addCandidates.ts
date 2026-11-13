/**
 * Adding candidates to a job while skipping duplicates.
 *
 * Used by the web search and the CSV upload. Duplicates are caught at three levels:
 *   1. inside the new batch itself (the CSV lists someone twice)
 *   2. against candidates already saved for this job
 *   3. by the database's unique indexes, as a last line of defence if two imports
 *      run at the same moment (see models/candidate.ts)
 * A candidate counts as a duplicate if the email OR the profile link matches.
 */
import { Types } from 'mongoose';
import { ActivityModel, type Actor } from '../models/activity.js';
import { CandidateModel, type CANDIDATE_SOURCES } from '../models/candidate.js';
import { normalizeEmail, normalizeProfileUrl } from './normalize.js';

export interface NewCandidate {
  name: string;
  email?: string | null;
  profileUrl?: string | null;
  headline?: string | null;
  location?: string | null;
  profileText?: string | null;
}

export interface AddResult {
  added: number;
  duplicates: number;
  /** Rows we couldn't use at all (no name, or neither a valid email nor a profile link). */
  invalid: number;
}

/** MongoDB's error code for "this would break a unique index". */
const DUPLICATE_KEY = 11000;

/**
 * Works out what an import WOULD do, without saving anything: which people are new,
 * which are duplicates (of each other or of candidates already in the job) and which rows
 * are unusable. Used by addCandidates() and by the chat's "Import CSV?" preview card.
 */
export async function planCandidates(jobId: string | Types.ObjectId, people: NewCandidate[]) {
  const jobObjectId = new Types.ObjectId(String(jobId));
  let invalid = 0;
  let duplicates = 0;

  // Emails and links already used in this job (lowercase/normal forms).
  const existing = await CandidateModel.find({ jobId: jobObjectId }, { email: 1, profileUrl: 1 }).lean();
  const seenEmails = new Set(existing.map((c) => c.email).filter(Boolean));
  const seenUrls = new Set(existing.map((c) => c.profileUrl).filter(Boolean));

  const fresh: (NewCandidate & { name: string; email: string | null; profileUrl: string | null })[] = [];
  for (const person of people) {
    const name = person.name?.trim();
    const email = normalizeEmail(person.email);
    const profileUrl = normalizeProfileUrl(person.profileUrl);

    // We need a name and at least one way to identify / reach the person.
    if (!name || (!email && !profileUrl)) {
      invalid++;
      continue;
    }
    if ((email && seenEmails.has(email)) || (profileUrl && seenUrls.has(profileUrl))) {
      duplicates++;
      continue;
    }
    if (email) seenEmails.add(email);
    if (profileUrl) seenUrls.add(profileUrl);
    fresh.push({ ...person, name, email, profileUrl });
  }
  return { fresh, duplicates, invalid };
}

export async function addCandidates(
  jobId: string | Types.ObjectId,
  source: (typeof CANDIDATE_SOURCES)[number],
  people: NewCandidate[],
  actor: Actor = 'system',
  /** The recruiter behind it (e.g. who uploaded the CSV), for the activity log. */
  userId?: string | null,
): Promise<AddResult> {
  const jobObjectId = new Types.ObjectId(String(jobId));
  const plan = await planCandidates(jobObjectId, people);
  const invalid = plan.invalid;
  let duplicates = plan.duplicates;

  const rows = plan.fresh.map((person) => ({
    jobId: jobObjectId,
    source,
    name: person.name,
    email: person.email,
    profileUrl: person.profileUrl,
    headline: person.headline?.trim() || null,
    location: person.location?.trim() || null,
    profileText: person.profileText?.trim() || null,
  }));

  let added = 0;
  if (rows.length > 0) {
    try {
      // ordered:false = keep inserting the others even if one row hits a duplicate.
      const inserted = await CandidateModel.insertMany(rows, { ordered: false });
      added = inserted.length;
    } catch (err) {
      // Level 3: someone else saved the same person a moment ago. Count those as duplicates.
      const writeErrors = (err as { writeErrors?: { code?: number; err?: { code?: number } }[] }).writeErrors;
      const insertedDocs = (err as { insertedDocs?: unknown[] }).insertedDocs;
      if (!writeErrors || !writeErrors.every((e) => (e.code ?? e.err?.code) === DUPLICATE_KEY)) throw err;
      duplicates += writeErrors.length;
      added = insertedDocs?.length ?? rows.length - writeErrors.length;
    }
  }

  if (added > 0) {
    await ActivityModel.create({
      jobId: jobObjectId,
      type: 'candidates_added',
      actor,
      userId: userId ? new Types.ObjectId(userId) : null,
      message: `Added ${added} candidate${added === 1 ? '' : 's'} from ${source === 'csv' ? 'CSV upload' : source === 'web' ? 'web search' : 'manual entry'}${duplicates ? ` (${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped)` : ''}`,
    });
  }

  return { added, duplicates, invalid };
}
