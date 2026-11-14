/**
 * Candidate REPLIES to outreach, and the MEETINGS booked from them.
 *
 * A reply comes in (simulated with POST /simulate-reply or the "Simulate reply" button; a
 * real inbox would create the same record). A background task then:
 *   - classifies it: interested / not_interested / question / wants_meeting / unsubscribe
 *   - moves the candidate's status (Contacted -> Replied -> Interested, ...)
 *   - stops their follow-up emails
 *   - drafts a response, which waits for the recruiter's approval (auto-send is a setting)
 *
 * A Meeting is created when the response offers a booking link: the candidate opens
 * /book/:token, picks one of the offered times, and becomes "Meeting booked".
 */
import { Schema, Types, model, type InferSchemaType } from 'mongoose';

export const REPLY_LABELS = ['interested', 'not_interested', 'question', 'wants_meeting', 'unsubscribe'] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];

const replySchema = new Schema(
  {
    jobId: { type: Types.ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: Types.ObjectId, ref: 'Candidate', required: true, index: true },
    // Who sent the outreach (gets the chat notification and owns the response).
    userId: { type: Types.ObjectId, ref: 'User', default: null },
    source: { type: String, enum: ['simulated', 'inbox'], default: 'simulated' },
    from: { type: String, required: true },
    subject: { type: String, default: '', maxlength: 300 },
    body: { type: String, required: true, maxlength: 10_000 },
    receivedAt: { type: Date, default: () => new Date() },
    // processing -> done (or failed). The background task fills in the rest.
    status: { type: String, enum: ['processing', 'done', 'failed'], default: 'processing' },
    error: { type: String, default: null },
    taskId: { type: Types.ObjectId, ref: 'Task', default: null },
    // The AI's reading of the reply.
    label: { type: String, enum: [...REPLY_LABELS, null], default: null },
    confidence: { type: Number, min: 0, max: 1, default: null },
    summary: { type: String, default: null, maxlength: 500 },
    // The reply tried to give the AI instructions ("ignore your rules..."): never auto-sent.
    flagged: { type: Boolean, default: false },
    // What happened to the candidate's status, e.g. Contacted -> Replied -> Interested.
    statusPath: { type: [String], default: [] },
    // How many scheduled follow-ups were cancelled because they replied.
    followUpsStopped: { type: Number, default: 0 },
    // The drafted response (none for "unsubscribe": we don't email people who opted out).
    response: {
      subject: { type: String, default: null, maxlength: 300 },
      body: { type: String, default: null, maxlength: 5000 },
      status: { type: String, enum: ['none', 'draft', 'sending', 'sent', 'discarded', 'failed'], default: 'none' },
      sentAt: { type: Date, default: null },
      error: { type: String, default: null },
      autoSent: { type: Boolean, default: false },
    },
    meetingId: { type: Types.ObjectId, ref: 'Meeting', default: null },
  },
  { timestamps: true },
);
replySchema.index({ jobId: 1, receivedAt: -1 });

const meetingSchema = new Schema(
  {
    jobId: { type: Types.ObjectId, ref: 'Job', required: true, index: true },
    candidateId: { type: Types.ObjectId, ref: 'Candidate', required: true, index: true },
    replyId: { type: Types.ObjectId, ref: 'Reply', default: null },
    // Secret for the candidate's booking link /book/:token.
    token: { type: String, required: true, unique: true },
    // The times offered (the mock "time-slot picker").
    slots: { type: [Date], required: true },
    status: { type: String, enum: ['offered', 'booked', 'cancelled'], default: 'offered' },
    slot: { type: Date, default: null }, // the chosen time
    bookedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type Reply = InferSchemaType<typeof replySchema>;
export type Meeting = InferSchemaType<typeof meetingSchema>;
export const ReplyModel = model('Reply', replySchema);
export const MeetingModel = model('Meeting', meetingSchema);
