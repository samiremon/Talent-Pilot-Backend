/**
 * Reading and creating jobs, plus the numbers the pages show (candidate counts per
 * status, dashboard totals). Routes in jobs/routes.ts call these.
 */
import { Types } from 'mongoose';
import { z } from 'zod';
import { attachExtractionUsage, totalUsage } from '../ai/usage.js';
import { AppError } from '../errors.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { CandidateModel as Candidates } from '../models/candidate.js';
import { jobCode, nextSequence } from '../models/counter.js';
import { JobModel, REMOTE_POLICIES } from '../models/job.js';
import { PendingActionModel } from '../models/chat.js';
import { UserModel } from '../models/user.js';
import { CANDIDATE_STATUSES, type CandidateStatus } from '../pipeline/status.js';

/** { sourced: 3, accepted: 1, ... } with every status present (0 if none). */
export type StatusCounts = Record<CandidateStatus, number>;

function emptyCounts(): StatusCounts {
  return Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0])) as StatusCounts;
}

/**
 * Counts candidates per status, grouped by job, in ONE database query
 * (instead of one query per job per status).
 */
async function countByJob(jobIds?: Types.ObjectId[]): Promise<Map<string, StatusCounts>> {
  const rows = await CandidateModel.aggregate<{ _id: { jobId: Types.ObjectId; status: CandidateStatus }; n: number }>([
    ...(jobIds ? [{ $match: { jobId: { $in: jobIds } } }] : []),
    { $group: { _id: { jobId: '$jobId', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const byJob = new Map<string, StatusCounts>();
  for (const row of rows) {
    const key = String(row._id.jobId);
    const counts = byJob.get(key) ?? emptyCounts();
    counts[row._id.status] = row.n;
    byJob.set(key, counts);
  }
  return byJob;
}

function total(counts: StatusCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/** Turns a URL id into a MongoDB id, or answers 404 for anything malformed. */
export function parseId(id: string, what = 'Job'): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound(`${what} not found`);
  return new Types.ObjectId(id);
}

/** The shape of a job sent to the browser. */
function present<T extends { _id: unknown; description: string; __v?: unknown }>(job: T, counts: StatusCounts) {
  // Generic <T> keeps the real field types (title, status, ...) for whoever calls this.
  const { _id, __v, description, ...rest } = job;
  void __v;
  return {
    id: String(_id),
    ...rest,
    // "JOB-0007": the short id shown in the UI and used by the AI.
    jobCode: jobCode((rest as { jobNumber?: number | null }).jobNumber),
    // The full JD can be long; lists only need a preview. GET /jobs/:id returns it all.
    descriptionPreview: typeof description === 'string' ? description.slice(0, 280) : '',
    counts,
    totalCandidates: total(counts),
  };
}

export async function listJobs() {
  const jobs = await JobModel.find().sort({ createdAt: -1 }).lean();
  const counts = await countByJob(jobs.map((j) => j._id));
  return jobs.map((job) => present(job, counts.get(String(job._id)) ?? emptyCounts()));
}

export async function getJob(id: string) {
  const job = await JobModel.findById(parseId(id)).lean();
  if (!job) throw AppError.notFound('Job not found');
  const counts = (await countByJob([job._id])).get(String(job._id)) ?? emptyCounts();
  return { ...present(job, counts), description: job.description };
}

export async function listCandidates(jobId: string) {
  const id = parseId(jobId);
  if (!(await JobModel.exists({ _id: id }))) throw AppError.notFound('Job not found');
  // Best score first; unscored candidates (null) after the scored ones.
  const rows = await CandidateModel.find({ jobId: id }).sort({ score: -1, createdAt: 1, _id: 1 }).lean();
  // Rejected people: where "Restore" would take them (the status before the rejection).
  const rejected = rows.filter((r) => r.status === 'rejected').map((r) => r._id);
  const restore = new Map<string, string>();
  if (rejected.length) {
    const rejections = await ActivityModel.find({ candidateId: { $in: rejected }, type: 'status_changed', toStatus: 'rejected', undone: { $ne: true } })
      .sort({ createdAt: 1 })
      .lean();
    for (const a of rejections) if (a.fromStatus) restore.set(String(a.candidateId), a.fromStatus); // the latest wins
  }
  return rows.map(({ _id, __v, jobId: job, ...rest }) => {
    void __v;
    return {
      id: String(_id),
      jobId: String(job),
      ...rest,
      // Older rows were flagged only in the reason text ("⚠ Profile contains instructions…").
      flagged: Boolean(rest.flagged) || (rest.scoreReason ?? '').startsWith('⚠'),
      restoreTo: restore.get(String(_id)) ?? null,
    };
  });
}

/**
 * Ranking of a job's candidates by AI score: #1 = best score, then 2, 3, 4, ... with NO
 * shared ranks. People with the same score are ordered by who was added first (the same
 * order as the candidates list). Only scored candidates are ranked; unscored ones have no
 * rank yet. The job page computes the same ranks, so the chat and the table always agree.
 * Returns candidateId -> rank, plus how many candidates are ranked.
 */
export async function candidateRanks(jobId: string | Types.ObjectId) {
  const scored = await CandidateModel.find({ jobId, score: { $ne: null } }, { score: 1, createdAt: 1 })
    .sort({ score: -1, createdAt: 1, _id: 1 })
    .lean();
  const ranks = new Map<string, number>();
  scored.forEach((c, index) => ranks.set(String(c._id), index + 1));
  return { ranks, total: scored.length };
}

/**
 * Candidates the AI hasn't scored yet (no score AND no reason): e.g. a scoring run that hit a
 * problem. People with no profile text DO have a reason ("not enough information"), so they
 * aren't counted: scoring them again wouldn't help.
 */
export function unscoredFilter(jobId: string | Types.ObjectId) {
  return { jobId: new Types.ObjectId(String(jobId)), score: null, scoreReason: null };
}

/** jobId -> number of unscored candidates, for all jobs at once. */
export async function unscoredCounts(): Promise<Map<string, number>> {
  const rows = await CandidateModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { score: null, scoreReason: null } },
    { $group: { _id: '$jobId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/** id -> name for a set of user ids (one query). Deleted users show as "Former user". */
export async function userNames(ids: unknown[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const users = await UserModel.find({ _id: { $in: unique } }, { name: 1 }).lean();
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  for (const id of unique) if (!names.has(id)) names.set(id, 'Former user');
  return names;
}

/**
 * The history log, newest first, with the person's NAME on each line and the job title.
 * Filters: one job; and/or only rows older than `before` (for "load more").
 */
export async function listActivity(filter: { jobId?: string; before?: Date }, limit = 100) {
  const query: Record<string, unknown> = {};
  if (filter.jobId) query.jobId = parseId(filter.jobId);
  if (filter.before) query.createdAt = { $lt: filter.before };
  const rows = await ActivityModel.find(query).sort({ createdAt: -1 }).limit(limit).lean();

  const [names, jobs] = await Promise.all([
    userNames(rows.map((r) => r.userId)),
    JobModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.jobId)))] } }, { title: 1 }).lean(),
  ]);
  const titles = new Map(jobs.map((j) => [String(j._id), j.title]));

  return rows.map(({ _id, __v, jobId, candidateId, userId, undoOf, ...rest }) => {
    void __v;
    return {
      id: String(_id),
      jobId: String(jobId),
      jobTitle: titles.get(String(jobId)) ?? 'Deleted job',
      candidateId: candidateId ? String(candidateId) : null,
      undoOf: undoOf ? String(undoOf) : null,
      userId: userId ? String(userId) : null,
      // The person behind it: the recruiter themself, or the recruiter whose AI did it.
      userName: userId ? (names.get(String(userId)) ?? null) : null,
      ...rest,
    };
  });
}

/** What the recruiter confirms on the job card. Empty strings become null ("Unknown"). */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const skills = z.array(z.string().trim().min(1).max(60)).max(30).default([]);

export const createJobInput = z.object({
  title: z.string().trim().min(1, 'is required').max(200),
  company: z.preprocess(blankToNull, z.string().trim().max(200).nullable().default(null)),
  description: z.string().trim().min(20, 'must be at least 20 characters').max(50_000),
  sourceUrl: z.preprocess(blankToNull, z.url({ protocol: /^https?$/ }).nullable().default(null)),
  mustHaveSkills: skills,
  niceToHaveSkills: skills,
  seniority: z.preprocess(blankToNull, z.string().trim().max(60).nullable().default(null)),
  location: z.preprocess(blankToNull, z.string().trim().max(200).nullable().default(null)),
  salary: z.preprocess(blankToNull, z.string().trim().max(100).nullable().default(null)),
  remotePolicy: z.enum(REMOTE_POLICIES).default('unknown'),
  // Set when the fields came from "Fill from description": that AI call's tokens are
  // then counted on this job.
  extractionId: z.uuid().optional(),
});
export type CreateJobInput = z.infer<typeof createJobInput>;

/**
 * Saves a job the recruiter has confirmed, and logs it.
 * `actor` says who pressed the button: normally the recruiter confirming the AI's card.
 */
export async function createJob(input: CreateJobInput, userId: string) {
  const { extractionId, ...fields } = input;
  const job = await JobModel.create({
    ...fields,
    jobNumber: await nextSequence('job'),
    createdBy: new Types.ObjectId(userId),
  });
  if (extractionId) await attachExtractionUsage(extractionId, job._id);
  await ActivityModel.create({
    jobId: job._id,
    type: 'job_created',
    actor: 'recruiter',
    userId: new Types.ObjectId(userId),
    message: `Job created: ${job.title}`,
  });
  return getJob(String(job._id));
}

// ---------- Finding, editing and deleting a job ----------

/**
 * Finds a job from whatever a person (or the AI) calls it: "JOB-0007", "job-7", "7",
 * or the long database id. Throws 404 if there's no such job.
 */
export async function resolveJob(ref: string) {
  const text = ref.trim();
  const number = /^(?:job[-\s#]*)?0*(\d{1,9})$/i.exec(text)?.[1];
  const job = number
    ? await JobModel.findOne({ jobNumber: Number(number) })
    : Types.ObjectId.isValid(text)
      ? await JobModel.findById(text)
      : null;
  if (!job) throw AppError.notFound(`Job ${text} not found`);
  return job;
}

/** What can be edited: the same fields as creating, all optional. */
const updateFields = createJobInput.omit({ extractionId: true }).partial();
export type UpdateJobInput = z.infer<typeof updateFields>;

/**
 * Checks an edit and keeps ONLY the fields that were actually sent.
 *
 * Why the extra step: the create rules fill in defaults for missing fields (empty skill
 * lists, "unknown" work style). For an edit that would silently wipe real data, e.g.
 * changing just the salary would also clear the skills. So after checking, we drop every
 * field the caller didn't send.
 */
export const updateJobInput = {
  parse(raw: unknown): UpdateJobInput {
    const sent = raw && typeof raw === 'object' ? Object.keys(raw).filter((k) => k in updateFields.shape) : [];
    if (sent.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to change', [{ path: '', message: 'Nothing to change' }]);
    const parsed = updateFields.parse(raw);
    return Object.fromEntries(sent.map((k) => [k, (parsed as Record<string, unknown>)[k]])) as UpdateJobInput;
  },
  safeParse(raw: unknown): { success: true; data: UpdateJobInput } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } {
    try {
      return { success: true, data: updateJobInput.parse(raw) };
    } catch (err) {
      if (err instanceof z.ZodError) return { success: false, error: { issues: err.issues } };
      if (err instanceof AppError) return { success: false, error: { issues: [{ path: [], message: err.message }] } };
      throw err;
    }
  },
};

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  company: 'company',
  description: 'description',
  sourceUrl: 'link',
  mustHaveSkills: 'must-have skills',
  niceToHaveSkills: 'nice-to-have skills',
  seniority: 'seniority',
  location: 'location',
  salary: 'salary',
  remotePolicy: 'work style',
};

/** Which fields really differ (so "edited: salary" doesn't list untouched fields). */
function changedFields(job: Record<string, unknown>, changes: Record<string, unknown>): string[] {
  return Object.entries(changes)
    .filter(([key, value]) => value !== undefined && JSON.stringify(job[key] ?? null) !== JSON.stringify(value ?? null))
    .map(([key]) => key);
}

/**
 * Edits a job. Used by the Edit form AND (after the recruiter confirms) by the AI.
 * Logs which fields changed and who changed them.
 */
export async function updateJob(
  ref: string,
  input: UpdateJobInput,
  { userId, actor = 'recruiter' }: { userId: string; actor?: 'recruiter' | 'ai' },
) {
  const job = await resolveJob(ref);
  const changes = updateJobInput.parse(input);
  const changed = changedFields(job.toObject(), changes);
  if (changed.length === 0) return getJob(String(job._id));

  for (const key of changed) job.set(key, (changes as Record<string, unknown>)[key]);
  await job.save();
  await ActivityModel.create({
    jobId: job._id,
    type: 'job_updated',
    actor,
    userId: new Types.ObjectId(userId),
    message: `Job edited${actor === 'ai' ? ' by the AI (confirmed in chat)' : ''}: ${changed.map((k) => FIELD_LABELS[k] ?? k).join(', ')}`,
  });
  return getJob(String(job._id));
}

/**
 * Deletes a job and its candidates. Used by the Delete button AND (after the recruiter
 * confirms) by the AI. The history (activity log, token usage) is KEPT, so you can still
 * see what happened; it just shows the job as deleted. Pending chat cards about this job
 * are cancelled so they can't be confirmed later.
 */
export async function deleteJob(ref: string, { userId, actor = 'recruiter' }: { userId: string; actor?: 'recruiter' | 'ai' }) {
  const job = await resolveJob(ref);
  const code = jobCode(job.jobNumber) ?? '';
  const { deletedCount: candidates } = await Candidates.deleteMany({ jobId: job._id });
  await PendingActionModel.updateMany(
    { status: 'pending', 'payload.jobId': String(job._id) },
    { $set: { status: 'cancelled', decidedAt: new Date() } },
  );
  await job.deleteOne();
  await ActivityModel.create({
    jobId: job._id,
    type: 'job_deleted',
    actor,
    userId: new Types.ObjectId(userId),
    message: `Job deleted${actor === 'ai' ? ' by the AI (confirmed in chat)' : ''}: ${job.title}${code ? ` (${code})` : ''}, with ${candidates} candidate${candidates === 1 ? '' : 's'}`,
  });
  return { id: String(job._id), jobCode: code, title: job.title, deletedCandidates: candidates };
}

/**
 * Gives a number to jobs created before numbering existed (oldest first). Runs at startup;
 * does nothing once every job has one.
 */
export async function ensureJobNumbers(): Promise<number> {
  const missing = await JobModel.find({ jobNumber: null }).sort({ createdAt: 1 });
  for (const job of missing) {
    job.jobNumber = await nextSequence('job');
    await job.save();
  }
  return missing.length;
}

/**
 * Dashboard numbers across all jobs.
 * Reply rate = candidates who replied (or got further) ÷ candidates we contacted.
 * Based on current statuses for now; becomes exact once emails are tracked.
 */
export async function overview() {
  const [jobs, perJob, recent, tokens] = await Promise.all([
    JobModel.find({}, { title: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean(),
    countByJob(),
    listActivity({}, 10),
    totalUsage(),
  ]);

  const counts = emptyCounts();
  for (const jobCounts of perJob.values()) {
    for (const status of CANDIDATE_STATUSES) counts[status] += jobCounts[status];
  }

  const repliedOrLater = ['replied', 'interested', 'not_interested', 'meeting_booked', 'interviewed', 'shortlisted', 'hired'] as const;
  const contactedOrLater = [...repliedOrLater, 'contacted', 'unsubscribed'] as const;
  const replied = repliedOrLater.reduce((n, s) => n + counts[s], 0);
  const contacted = contactedOrLater.reduce((n, s) => n + counts[s], 0);

  return {
    activeJobs: jobs.filter((j) => j.status === 'active').length,
    totalCandidates: total(counts),
    hires: counts.hired,
    replyRate: contacted > 0 ? replied / contacted : null,
    // The token meter: all AI tokens used so far (input = sent to the AI, output = written by it).
    aiTokens: tokens,
    counts,
    recentActivity: recent,
    jobs: jobs.slice(0, 5).map((j) => {
      const c = perJob.get(String(j._id)) ?? emptyCounts();
      return { id: String(j._id), title: j.title, status: j.status, totalCandidates: total(c), hired: c.hired };
    }),
  };
}
