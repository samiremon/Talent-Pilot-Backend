/**
 * Approve-before-action: proposing, confirming and cancelling what the AI wants to do.
 *
 *   proposeAction()   called by the AI's tools: saves a PendingAction (status "pending")
 *   confirmAction()   called ONLY by the recruiter's Confirm button: runs it for real
 *   cancelAction()    called by the recruiter's Cancel button
 *
 * Confirm runs the SAME service functions the UI uses (e.g. createJob), so a job created
 * from the chat is identical to one created with the New job form, and logged the same way.
 */
import { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { createJob, createJobInput } from '../jobs/service.js';
import { ActivityModel } from '../models/activity.js';
import { PendingActionModel, type ActionType } from '../models/chat.js';

export async function proposeAction(
  userId: string,
  type: ActionType,
  payload: Record<string, unknown>,
  notes: string[] = [],
) {
  return PendingActionModel.create({ userId: new Types.ObjectId(userId), type, payload, notes });
}

/** The card as the browser sees it. */
export function presentAction(action: {
  _id: unknown;
  type: string;
  status: string;
  payload: unknown;
  notes: string[];
  result?: unknown;
}) {
  return {
    id: String(action._id),
    type: action.type,
    status: action.status,
    payload: action.payload,
    notes: action.notes,
    result: action.result ?? null,
  };
}

/** Loads a pending action that belongs to this recruiter, or explains why not. */
async function loadPending(actionId: string, userId: string) {
  if (!Types.ObjectId.isValid(actionId)) throw AppError.notFound('Action not found');
  const action = await PendingActionModel.findOne({ _id: actionId, userId });
  if (!action) throw AppError.notFound('Action not found');
  if (action.status !== 'pending') throw AppError.conflict(`This was already ${action.status}.`);
  return action;
}

/**
 * The recruiter pressed Confirm. `edits` are the fields as the recruiter left them on
 * the card (they may have changed the AI's suggestion before confirming).
 */
export async function confirmAction(actionId: string, userId: string, edits?: Record<string, unknown>) {
  const action = await loadPending(actionId, userId);

  // Claim it first (pending -> confirmed) so a double-click can't run it twice.
  const claimed = await PendingActionModel.findOneAndUpdate(
    { _id: action._id, status: 'pending' },
    { $set: { status: 'confirmed', decidedAt: new Date() } },
    { new: true },
  );
  if (!claimed) throw AppError.conflict('This was already handled.');

  try {
    let result: Record<string, unknown>;
    switch (action.type) {
      case 'create_job': {
        const input = createJobInput.parse({ ...(action.payload as object), ...(edits ?? {}) });
        const job = await createJob(input, userId);
        // Record that the AI proposed it (createJob already logged "Job created" by the recruiter).
        await ActivityModel.create({
          jobId: new Types.ObjectId(job.id),
          type: 'job_updated',
          actor: 'ai',
          userId: new Types.ObjectId(userId), // whose AI proposed it
          message: 'Proposed by the AI from a pasted job description; the recruiter reviewed and confirmed it',
        });
        result = { jobId: job.id, title: job.title };
        break;
      }
      default:
        throw new AppError(400, 'UNKNOWN_ACTION', 'Unknown action');
    }
    claimed.set({ result, payload: { ...(action.payload as object), ...(edits ?? {}) } });
    await claimed.save();
    return presentAction(claimed);
  } catch (err) {
    // It failed (e.g. invalid edits): put it back to pending so the recruiter can fix and retry.
    await PendingActionModel.updateOne({ _id: action._id }, { $set: { status: 'pending', decidedAt: null } });
    throw err;
  }
}

export async function cancelAction(actionId: string, userId: string) {
  const action = await loadPending(actionId, userId);
  action.set({ status: 'cancelled', decidedAt: new Date() });
  await action.save();
  return presentAction(action);
}
