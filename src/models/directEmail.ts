/**
 * One-off emails to ONE candidate, outside a campaign: e.g. a polite rejection, an update.
 * Written by the recruiter (or drafted by the AI and approved). Shown in the candidate's
 * conversation (Replies tab) and timeline.
 */
import { Schema, Types, model, type InferSchemaType } from 'mongoose';

const directEmailSchema = new Schema(
  {
    jobId: { type: Types.ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: Types.ObjectId, ref: 'Candidate', required: true, index: true },
    userId: { type: Types.ObjectId, ref: 'User', default: null },
    to: { type: String, required: true },
    subject: { type: String, required: true, maxlength: 300 },
    body: { type: String, required: true, maxlength: 5000 },
    purpose: { type: String, enum: ['rejection', 'update', 'custom'], default: 'custom' },
    sentAt: { type: Date, default: () => new Date() },
    // Secret for this email's unsubscribe link (like outreach emails).
    unsubscribeToken: { type: String, default: null, index: true },
  },
  { timestamps: true },
);

export type DirectEmail = InferSchemaType<typeof directEmailSchema>;
export const DirectEmailModel = model('DirectEmail', directEmailSchema);
