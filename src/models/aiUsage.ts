/**
 * AiUsage = one row per AI call: which task, which model, how many tokens.
 *
 * This is the source of truth for the "token meter". Each job also keeps a running total
 * (job.aiUsage) so pages don't have to add up rows every time.
 *
 * Some calls happen BEFORE a job exists (e.g. reading a job description to fill the
 * New job form). Those rows get an `extractionId` instead of a jobId; when the job is
 * then created with that extractionId, the rows are attached to it and counted.
 * The numbers always come from Groq's answer on the server, never from the browser.
 */
import { Schema, model, Types, type InferSchemaType } from 'mongoose';

export const AI_ROLES = ['agent', 'bulk', 'safety'] as const;
export type AiRole = (typeof AI_ROLES)[number];

const aiUsageSchema = new Schema({
  jobId: { type: Types.ObjectId, ref: 'Job', default: null },
  extractionId: { type: String, default: null },
  task: { type: String, required: true }, // e.g. "extract_job", "score_candidates"
  role: { type: String, enum: AI_ROLES, required: true },
  model: { type: String, required: true }, // e.g. "openai/gpt-oss-120b", or "mock"
  inputTokens: { type: Number, required: true },
  outputTokens: { type: Number, required: true },
  createdAt: { type: Date, default: () => new Date() },
});

aiUsageSchema.index({ jobId: 1, createdAt: -1 });
aiUsageSchema.index({ extractionId: 1 }, { partialFilterExpression: { extractionId: { $type: 'string' } } });

export type AiUsage = InferSchemaType<typeof aiUsageSchema>;
export const AiUsageModel = model('AiUsage', aiUsageSchema);
