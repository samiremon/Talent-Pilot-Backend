/**
 * Activity = the history log. One row for every meaningful change, saying:
 *   WHAT happened   type + a human-readable message ("Sara Ahmed: Sourced → Accepted")
 *   WHO did it      actor: the recruiter, the AI, or the system (a background job)
 *   WHEN            createdAt
 *   TO WHAT         the job, and the candidate if it's about one
 *
 * Rows are only ever added, never edited, except for the `undone` flag, which marks a
 * status change that was later reversed (the reversal itself is a new row).
 *
 * The assignment requires every status change to be recorded here, and Undo uses it to
 * know what the previous status was.
 */
import { Schema, model, Types, type InferSchemaType } from 'mongoose';
import { CANDIDATE_STATUSES } from '../pipeline/status.js';

export const ACTORS = ['recruiter', 'ai', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

export const ACTIVITY_TYPES = [
  'job_created',
  'job_updated',
  'job_deleted',
  'candidates_added',
  'candidate_scored',
  'candidate_deleted',
  'status_changed',
  'status_undone',
  'email_sent',
  'reply_received',
  'meeting_booked',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

const activitySchema = new Schema({
  jobId: { type: Types.ObjectId, ref: 'Job', required: true },
  candidateId: { type: Types.ObjectId, ref: 'Candidate', default: null },

  type: { type: String, enum: ACTIVITY_TYPES, required: true },
  actor: { type: String, enum: ACTORS, required: true },
  // Which user, when the actor is the recruiter.
  userId: { type: Types.ObjectId, ref: 'User', default: null },
  message: { type: String, required: true, maxlength: 1000 },

  // Filled in for status changes (and undos), so Undo knows where to go back to.
  fromStatus: { type: String, enum: [...CANDIDATE_STATUSES, null], default: null },
  toStatus: { type: String, enum: [...CANDIDATE_STATUSES, null], default: null },
  // True once this status change has been reversed with Undo (it can't be undone twice).
  undone: { type: Boolean, default: false },
  // On a 'status_undone' row: which activity it reversed.
  undoOf: { type: Types.ObjectId, ref: 'Activity', default: null },

  createdAt: { type: Date, default: () => new Date() },
});

// "Latest activity for this job" and "history of this candidate" are the common lists.
activitySchema.index({ jobId: 1, createdAt: -1 });
activitySchema.index({ candidateId: 1, createdAt: -1 });

export type Activity = InferSchemaType<typeof activitySchema>;
export const ActivityModel = model('Activity', activitySchema);
