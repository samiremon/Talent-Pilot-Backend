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
import type { Ai } from '../ai/client.js';
import { RateLimitSnapshotModel } from '../ai/rateLimits.js';
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

// ---------- AI limits ("how much is left") ----------

export interface LimitSettings {
  /** Groq's daily token limit per model (TPD), from .env; Groq doesn't report it live. */
  dailyTokens?: number;
  /** Your own team budgets: Groq's free tier has no weekly/monthly limit. */
  weekBudget?: number;
  monthBudget?: number;
}

/** A "used / limit / left / % left" box. limit undefined = no limit known or set. */
function meter(used: number, limit?: number, extra: Record<string, unknown> = {}) {
  if (!limit) return { used, limit: null, remaining: null, percentLeft: null, ...extra };
  const remaining = Math.max(0, limit - used);
  return { used, limit, remaining, percentLeft: Math.round((remaining / limit) * 100), ...extra };
}

async function tokensSince(since: Date, modelName?: string): Promise<number> {
  const [row] = await AiUsageModel.aggregate<{ total: number }>([
    { $match: { createdAt: { $gte: since }, ...(modelName ? { model: modelName } : {}) } },
    { $group: { _id: null, total: { $sum: { $add: ['$inputTokens', '$outputTokens'] } } } },
  ]);
  return row?.total ?? 0;
}

/** Groq's daily token limit status, from Groq's own answers only (see rateLimits.ts). */
function dailyTokenStatus(snap?: {
  lastOkAt?: Date | null;
  limitTokensDay?: number | null;
  usedTokensDay?: number | null;
  dayRefusedAt?: Date | null;
  dayFreesAt?: Date | null;
}) {
  const ok = snap?.lastOkAt ? new Date(snap.lastOkAt) : null;
  const refused = snap?.dayRefusedAt ? new Date(snap.dayRefusedAt) : null;
  const status = refused && (!ok || ok < refused) ? 'used_up' : ok ? 'available' : 'unknown';
  return {
    status,
    lastOkAt: ok,
    // Groq's numbers from its last daily-limit refusal (kept for reference even after).
    limit: snap?.limitTokensDay ?? null,
    used: status === 'used_up' ? (snap?.usedTokensDay ?? null) : null,
    refusedAt: refused,
    freesAt: status === 'used_up' && snap?.dayFreesAt ? new Date(snap.dayFreesAt) : null,
  };
}

/**
 * For each Groq model: requests left today and tokens left this minute (live from Groq's
 * last answer), and tokens left today (our own count vs the daily limit from .env).
 * Plus week/month budgets across all models.
 */
export async function aiLimits(ai: Pick<Ai, 'mode' | 'models'>, settings: LimitSettings, now = new Date()) {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const month = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // One entry per distinct model, listing which roles use it.
  const roles = new Map<string, string[]>();
  for (const [role, modelName] of Object.entries(ai.models)) roles.set(modelName, [...(roles.get(modelName) ?? []), role]);

  const snapshots = new Map(
    (await RateLimitSnapshotModel.find({ _id: { $in: [...roles.keys()] } }).lean()).map((s) => [String(s._id), s]),
  );

  const models = await Promise.all(
    [...roles.entries()].map(async ([modelName, usedBy]) => {
      const snap = snapshots.get(modelName);
      // Groq's limits are REFILLING BUCKETS, not counters that reset at midnight:
      //   1,000 requests per day   = 1 request given back every 86.4 s
      //   8,000 tokens per minute  = 8,000 tokens given back over each minute
      // Groq tells us how much was left at the moment of our last call; since then the
      // bucket has kept refilling, so we add back what has refilled (never above the limit).
      const refill = (limit: number | null | undefined, remaining: number | null | undefined, windowMs: number) => {
        if (limit == null || remaining == null) return null;
        const elapsed = snap?.updatedAt ? now.getTime() - new Date(snap.updatedAt).getTime() : 0;
        return Math.min(limit, remaining + Math.floor((elapsed * limit) / windowMs));
      };
      const requestsLeft = refill(snap?.limitRequests, snap?.remainingRequests, 24 * 60 * 60 * 1000);
      const tokensLeft = refill(snap?.limitTokens, snap?.remainingTokens, 60 * 1000);
      // Rounded DOWN, so it never says "100% left" while something is used (997/1000 -> 99%).
      const pct = (left: number | null, limit: number | null | undefined) =>
        left === null || !limit ? null : Math.floor((left / limit) * 100);

      return {
        model: modelName,
        usedBy,
        updatedAt: snap?.updatedAt ?? null,
        requestsToday: {
          limit: snap?.limitRequests ?? null,
          remaining: requestsLeft,
          percentLeft: pct(requestsLeft, snap?.limitRequests),
          // How fast used requests come back (e.g. "1 every 86 s" for 1,000/day).
          refillSeconds: snap?.limitRequests ? Math.round(86_400 / snap.limitRequests) : null,
        },
        tokensPerMinute: {
          limit: snap?.limitTokens ?? null,
          remaining: tokensLeft,
          percentLeft: pct(tokensLeft, snap?.limitTokens),
        },
        // Our own count of AI calls to this model in the last 24 hours (from the token log),
        // so the recruiter sees real usage next to Groq's refilling bucket.
        callsLast24h: await AiUsageModel.countDocuments({ model: modelName, createdAt: { $gte: day } }),
        tokensToday: meter(await tokensSince(day, modelName), settings.dailyTokens),
        // Groq's daily TOKEN limit, exactly as Groq reported it (no estimate: Groq doesn't
        // send this in headers, and counts in its own way):
        //   "available" = Groq's latest answer for this model was a normal one
        //   "used_up"   = Groq's latest answer was a daily-limit refusal, with its own numbers
        //   "unknown"   = no answer from Groq yet (press "Check now")
        dailyTokens: dailyTokenStatus(snap),
      };
    }),
  );

  return {
    mode: ai.mode,
    models,
    week: meter(await tokensSince(week), settings.weekBudget),
    month: meter(await tokensSince(month), settings.monthBudget),
  };
}
