/**
 * Notifications for the bell in the top bar: "Priya Das replied: Wants a meeting".
 * One per event, for the recruiter it concerns (the one who sent the outreach).
 * Clicking it opens that candidate's conversation on the job's Replies tab.
 */
import { Schema, Types, model, type InferSchemaType } from 'mongoose';

const notificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['reply', 'meeting'], required: true },
    jobId: { type: Types.ObjectId, ref: 'Job', required: true },
    candidateId: { type: Types.ObjectId, ref: 'Candidate', required: true },
    replyId: { type: Types.ObjectId, ref: 'Reply', default: null },
    text: { type: String, required: true, maxlength: 300 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);
notificationSchema.index({ userId: 1, createdAt: -1 });
// Old ones clean themselves up after 30 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export type Notification = InferSchemaType<typeof notificationSchema>;
export const NotificationModel = model('Notification', notificationSchema);
