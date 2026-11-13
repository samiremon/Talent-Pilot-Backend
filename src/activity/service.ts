/**
 * Data for the Activity module (the "Activity" page in the sidebar), three tabs:
 *
 *   1. Activity         everything that happened, newest first, with WHO did it
 *   2. Token usage      every AI call: when, who, what task, which model, tokens in/out
 *   3. Token dashboard  per recruiter: tokens used all-time and in the last N days
 *
 * Lists are paged with "before": the browser asks for the next page with the time of the
 * last row it has ("load more"), which stays correct even while new rows keep arriving.
 */
import { Types } from 'mongoose';
import { listActivity, userNames } from '../jobs/service.js';
import { AiUsageModel } from '../models/aiUsage.js';
import { JobModel } from '../models/job.js';
import { UserModel } from '../models/user.js';

/** Readable names for the AI tasks in the token log. */
const TASK_LABELS: Record<string, string> = {
  extract_job: 'Read a job description',
  chat: 'Chat reply',
  score_candidates: 'Score candidates',
  classify_reply: 'Sort a reply',
  draft_email: 'Draft an email',
  injection_check: 'Safety check',
};

export async function activityPage(before?: Date, limit = 50) {
  const items = await listActivity({ before }, limit);
  return { items, nextBefore: items.length === limit ? items.at(-1)!.createdAt : null };
}

export async function tokenUsagePage(before?: Date, limit = 50) {
  const rows = await AiUsageModel.find(before ? { createdAt: { $lt: before } } : {})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const [names, jobs] = await Promise.all([
    userNames(rows.map((r) => r.userId)),
    JobModel.find({ _id: { $in: rows.map((r) => r.jobId).filter(Boolean) } }, { title: 1 }).lean(),
  ]);
  const titles = new Map(jobs.map((j) => [String(j._id), j.title]));

  const items = rows.map((r) => ({
    id: String(r._id),
    createdAt: r.createdAt,
    userId: r.userId ? String(r.userId) : null,
    userName: r.userId ? (names.get(String(r.userId)) ?? 'Former user') : 'System',
    task: r.task,
    taskLabel: TASK_LABELS[r.task] ?? r.task,
    model: r.model,
    role: r.role,
    jobId: r.jobId ? String(r.jobId) : null,
    // Not attached to a job: e.g. reading a JD that was never turned into a job.
    jobTitle: r.jobId ? (titles.get(String(r.jobId)) ?? 'Deleted job') : null,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  }));
  return { items, nextBefore: items.length === limit ? items.at(-1)!.createdAt : null };
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}
const zero = (): Totals => ({ inputTokens: 0, outputTokens: 0, calls: 0 });

/** Sum of tokens per user (null = System), optionally only since a date. One query. */
async function totalsByUser(since?: Date): Promise<Map<string, Totals>> {
  const rows = await AiUsageModel.aggregate<{ _id: Types.ObjectId | null; inputTokens: number; outputTokens: number; calls: number }>([
    ...(since ? [{ $match: { createdAt: { $gte: since } } }] : []),
    {
      $group: {
        _id: '$userId',
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        calls: { $sum: 1 },
      },
    },
  ]);
  return new Map(rows.map((r) => [r._id ? String(r._id) : 'system', { inputTokens: r.inputTokens, outputTokens: r.outputTokens, calls: r.calls }]));
}

/**
 * Token dashboard: every recruiter (even those who used none) with their all-time total
 * and their total for the last `days` days, biggest users first. Plus a "System" row for
 * background work that no single person triggered.
 */
export async function tokenDashboard(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [allTime, recent, users] = await Promise.all([
    totalsByUser(),
    totalsByUser(since),
    UserModel.find({}, { name: 1, email: 1 }).lean(),
  ]);

  const rows = users.map((u) => ({
    userId: String(u._id),
    name: u.name,
    email: u.email as string | null,
    allTime: allTime.get(String(u._id)) ?? zero(),
    lastDays: recent.get(String(u._id)) ?? zero(),
  }));
  if (allTime.has('system')) {
    rows.push({ userId: 'system', name: 'System', email: null, allTime: allTime.get('system')!, lastDays: recent.get('system') ?? zero() });
  }
  // Tokens from accounts that were deleted.
  const known = new Set(rows.map((r) => r.userId));
  for (const [id, totals] of allTime) {
    if (!known.has(id)) rows.push({ userId: id, name: 'Former user', email: null, allTime: totals, lastDays: recent.get(id) ?? zero() });
  }

  const sum = (pick: (r: (typeof rows)[number]) => Totals): Totals =>
    rows.reduce((t, r) => {
      const v = pick(r);
      return { inputTokens: t.inputTokens + v.inputTokens, outputTokens: t.outputTokens + v.outputTokens, calls: t.calls + v.calls };
    }, zero());
  const total = (t: Totals) => t.inputTokens + t.outputTokens;

  rows.sort((a, b) => total(b.lastDays) - total(a.lastDays) || total(b.allTime) - total(a.allTime) || a.name.localeCompare(b.name));
  return { days, since, totals: { allTime: sum((r) => r.allTime), lastDays: sum((r) => r.lastDays) }, users: rows };
}
