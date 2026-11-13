/**
 * Chat storage: the conversation with the AI, and the actions waiting for approval.
 *
 * ChatMessage = one bubble in the chat (from the recruiter or the AI). Saved so a page
 * refresh shows the same conversation (the assignment requires this). An AI message can
 * carry a "card" (e.g. the job card) by pointing at a PendingAction.
 *
 * PendingAction = something the AI WANTS to do but isn't allowed to do on its own,
 * e.g. "create this job". The AI can only PROPOSE: it creates one of these and the chat
 * shows it as a card with Confirm / Cancel. Only the recruiter pressing Confirm runs it
 * (see chat/actions.ts). This is enforced here in the server, not just by asking the AI
 * nicely, so a tricked AI still can't create, send or change anything by itself.
 */
import { Schema, model, Types, type InferSchemaType } from 'mongoose';

export const ACTION_TYPES = ['create_job', 'update_job', 'delete_job', 'import_csv', 'add_candidate', 'delete_candidate'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ACTION_STATUSES = ['pending', 'confirmed', 'cancelled'] as const;

const pendingActionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ACTION_TYPES, required: true },
    status: { type: String, enum: ACTION_STATUSES, default: 'pending' },
    // What would be done, e.g. the job fields for create_job. Shown (and editable) on the card.
    payload: { type: Schema.Types.Mixed, required: true },
    // Extra info for the card, e.g. values the AI suggested that weren't in the text.
    notes: { type: [String], default: [] },
    // After Confirm: what was created, e.g. { jobId }.
    result: { type: Schema.Types.Mixed, default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type PendingAction = InferSchemaType<typeof pendingActionSchema>;
export const PendingActionModel = model('PendingAction', pendingActionSchema);

const chatMessageSchema = new Schema({
  userId: { type: Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, default: '', maxlength: 60_000 },
  // The job the recruiter was looking at when this was said (the AI's "context").
  jobId: { type: Types.ObjectId, ref: 'Job', default: null },
  // A card shown under this message (e.g. the job card), if any.
  actionId: { type: Types.ObjectId, ref: 'PendingAction', default: null },
  createdAt: { type: Date, default: () => new Date() },
});

chatMessageSchema.index({ userId: 1, createdAt: -1 });

export type ChatMessage = InferSchemaType<typeof chatMessageSchema>;
export const ChatMessageModel = model('ChatMessage', chatMessageSchema);
