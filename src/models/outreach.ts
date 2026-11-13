/**
 * Outreach: a CAMPAIGN for a job, and one MESSAGE per candidate per step.
 *
 *   Campaign "JOB-0003 outreach"   steps: Day 0, Day 3, Day 7
 *     Ana  step 1 (Day 0)  draft -> approved -> sent
 *     Ana  step 2 (Day 3)  draft -> approved -> (waiting until Day 3) -> sent
 *     Ana  step 3 (Day 7)  ... -> skipped (Ana replied: follow-ups stop)
 *
 * Message lifecycle:
 *   draft     written by the AI, the recruiter can edit it
 *   approved  the recruiter approved the campaign; waits for its send time
 *   sending   being sent right now (claimed by the worker, so it can't go out twice)
 *   sent      delivered to the mail server
 *   skipped   not sent: the candidate replied / unsubscribed / was rejected, or the
 *             recruiter removed them
 *   failed    the mail server refused it (the error is kept)
 *
 * "No candidate receives the same step twice": the unique index (campaign, candidate,
 * step) means a step can only exist once, and sending first CLAIMS the message
 * (approved -> sending in one database operation), so two workers can't both send it.
 */
import { Schema, Types, model, type InferSchemaType } from 'mongoose';

export const CAMPAIGN_STATUSES = ['drafting', 'draft', 'active', 'paused', 'done'] as const;
export const MESSAGE_STATUSES = ['draft', 'approved', 'sending', 'sent', 'skipped', 'failed'] as const;

const campaignSchema = new Schema(
  {
    jobId: { type: Types.ObjectId, ref: 'Job', required: true, index: true },
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    // The days each step is sent on, counted from approval: [0] or [0, 3, 7].
    stepDays: { type: [Number], required: true },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: 'drafting' },
    // "sandbox" (Mailpit) or "live" (real email), fixed when the campaign is approved.
    mode: { type: String, enum: ['sandbox', 'live'], default: 'sandbox' },
    approvedAt: { type: Date, default: null },
    // The background tasks (for live progress): drafting, then sending.
    draftTaskId: { type: Types.ObjectId, ref: 'Task', default: null },
    sendTaskId: { type: Types.ObjectId, ref: 'Task', default: null },
  },
  { timestamps: true },
);

const messageSchema = new Schema(
  {
    campaignId: { type: Types.ObjectId, ref: 'Campaign', required: true, index: true },
    jobId: { type: Types.ObjectId, ref: 'Job', required: true },
    candidateId: { type: Types.ObjectId, ref: 'Candidate', required: true },
    step: { type: Number, required: true, min: 0 }, // 0 = first email, 1 = first follow-up, ...
    day: { type: Number, required: true, min: 0 }, // send on this day after approval
    to: { type: String, required: true },
    subject: { type: String, default: '', maxlength: 300 },
    body: { type: String, default: '', maxlength: 5000 },
    status: { type: String, enum: MESSAGE_STATUSES, default: 'draft' },
    sendAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    error: { type: String, default: null },
    // Why it was skipped, e.g. "Ana replied".
    note: { type: String, default: null },
  },
  { timestamps: true },
);
// The "never the same step twice" guarantee.
messageSchema.index({ campaignId: 1, candidateId: 1, step: 1 }, { unique: true });
// The sender's query: approved messages whose time has come.
messageSchema.index({ status: 1, sendAt: 1 });

export type Campaign = InferSchemaType<typeof campaignSchema>;
export type OutreachMessage = InferSchemaType<typeof messageSchema>;
export const CampaignModel = model('Campaign', campaignSchema);
export const OutreachMessageModel = model('OutreachMessage', messageSchema);
