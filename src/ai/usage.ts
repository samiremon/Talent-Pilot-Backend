/**
 * The token meter: saving how many tokens each AI call used, and adding it to the job.
 */
import { Types } from 'mongoose';
import { AiUsageModel, type AiRole } from '../models/aiUsage.js';
import { JobModel } from '../models/job.js';
import type { TokenUsage } from './client.js';

/** Who pays for a call: an existing job, or a not-yet-created one (extraction id). */
export type UsageTarget = { jobId: string | Types.ObjectId } | { extractionId: string };

export async function recordUsage({
  task,
  role,
  model,
  usage,
  target,
}: {
  task: string;
  role: AiRole;
  model: string;
  usage: TokenUsage;
  target?: UsageTarget;
}): Promise<void> {
  const jobId = target && 'jobId' in target ? new Types.ObjectId(String(target.jobId)) : null;
  const extractionId = target && 'extractionId' in target ? target.extractionId : null;

  await AiUsageModel.create({ task, role, model, jobId, extractionId, ...usage });
  if (jobId) await addToJob(jobId, usage, 1);
}

async function addToJob(jobId: Types.ObjectId, usage: TokenUsage, calls: number): Promise<void> {
  await JobModel.updateOne(
    { _id: jobId },
    { $inc: { 'aiUsage.inputTokens': usage.inputTokens, 'aiUsage.outputTokens': usage.outputTokens, 'aiUsage.calls': calls } },
  );
}

/**
 * When a job is created from an AI extraction, move that extraction's token usage onto
 * the new job. Only rows that aren't attached to a job yet are moved (so it can't be
 * claimed twice).
 */
export async function attachExtractionUsage(extractionId: string, jobId: Types.ObjectId): Promise<void> {
  const rows = await AiUsageModel.find({ extractionId, jobId: null }).lean();
  if (rows.length === 0) return;
  await AiUsageModel.updateMany({ _id: { $in: rows.map((r) => r._id) }, jobId: null }, { $set: { jobId } });
  const total = rows.reduce(
    (sum, r) => ({ inputTokens: sum.inputTokens + r.inputTokens, outputTokens: sum.outputTokens + r.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  );
  await addToJob(jobId, total, rows.length);
}

/** All tokens ever used (for the dashboard). */
export async function totalUsage(): Promise<TokenUsage> {
  const [row] = await AiUsageModel.aggregate<{ inputTokens: number; outputTokens: number }>([
    { $group: { _id: null, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' } } },
  ]);
  return { inputTokens: row?.inputTokens ?? 0, outputTokens: row?.outputTokens ?? 0 };
}
