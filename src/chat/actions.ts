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
import { addCandidates, type NewCandidate } from '../candidates/addCandidates.js';
import { createJob, createJobInput, deleteJob, updateJob, updateJobInput } from '../jobs/service.js';
import { addManualCandidate } from '../sourcing/manual.js';
import { deleteAllCandidates, deleteCandidate } from '../candidates/deleteCandidate.js';
import { updateCandidateContact } from '../candidates/updateCandidate.js';
import { changeStatuses } from '../candidates/statusChange.js';
import { approveCampaign, createCampaign, SEQUENCES, type OutreachDeps } from '../outreach/service.js';

/** The outreach settings for the chat's campaign cards (sandbox / 50 a day by default). */
function outreachDeps(deps: SourcingDeps): OutreachDeps {
  return { queue: deps.queue, events: deps.events, outreach: deps.outreach ?? { mode: 'sandbox', dailyLimit: 50, daySeconds: 86_400 } };
}
import type { CandidateStatus } from '../pipeline/status.js';
import { SOURCE_LABELS, type SearchSource } from '../sourcing/search.js';
import { startSourcing } from '../sourcing/webSourcing.js';
import { startScoring, type SourcingDeps } from '../sourcing/service.js';
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
  // The CSV import card keeps every row on the server (to import on Confirm); the browser
  // only needs the counts and preview, so the big list is left out.
  const { people: _rows, ...payload } = (action.payload ?? {}) as Record<string, unknown>;
  void _rows;
  return {
    id: String(action._id),
    type: action.type,
    status: action.status,
    payload,
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
export async function confirmAction(
  actionId: string,
  userId: string,
  edits?: Record<string, unknown>,
  /** Needed for actions that start background work (e.g. scoring after a CSV import). */
  deps?: SourcingDeps,
) {
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
          message: 'Proposed by the AI from a pasted job description, then reviewed and confirmed in the chat',
        });
        result = { jobId: job.id, title: job.title, jobCode: job.jobCode };
        break;
      }
      case 'update_job': {
        // payload = { jobId, jobCode, title, changes: {...}, before: {...} }. The recruiter may
        // have adjusted the NEW values on the card ("edits"), which win.
        const payload = action.payload as { jobId: string; changes: Record<string, unknown> };
        const changes = updateJobInput.parse({ ...payload.changes, ...(edits ?? {}) });
        const job = await updateJob(payload.jobId, changes, { userId, actor: 'ai' });
        result = { jobId: job.id, title: job.title, jobCode: job.jobCode };
        break;
      }
      case 'delete_job': {
        const payload = action.payload as { jobId: string };
        const deleted = await deleteJob(payload.jobId, { userId, actor: 'ai' });
        result = { title: deleted.title, jobCode: deleted.jobCode, deletedCandidates: deleted.deletedCandidates };
        break;
      }
      case 'import_csv': {
        // payload = { jobId, fileName, people: [...] } (the rows read when the file was attached).
        // Same code path as the "Upload CSV" button: add (duplicates skipped) -> start scoring.
        if (!deps) throw new AppError(500, 'NO_QUEUE', 'Background tasks are not available.');
        const payload = action.payload as { jobId: string; people: NewCandidate[] };
        const added = await addCandidates(payload.jobId, 'csv', payload.people, 'recruiter', userId);
        const task = added.added > 0 ? await startScoring(deps, payload.jobId, userId) : null;
        result = { jobId: payload.jobId, ...added, taskId: task?.id ?? null };
        break;
      }
      case 'add_candidate': {
        // payload = { jobId, jobCode, title, candidate: {...} }. The recruiter may have
        // corrected fields on the card (e.g. a typo in the email): their edits win.
        if (!deps) throw new AppError(500, 'NO_QUEUE', 'Background tasks are not available.');
        const payload = action.payload as { jobId: string; candidate: Record<string, unknown> };
        const added = await addManualCandidate(deps, payload.jobId, { ...payload.candidate, ...(edits ?? {}) }, userId);
        result = { jobId: payload.jobId, candidateId: added.candidateId, name: added.name, taskId: added.task?.id ?? null };
        break;
      }
      case 'delete_candidate': {
        // payload = { jobId, candidateId, name, ... }. Same function as the trash button.
        const payload = action.payload as { jobId: string; candidateId: string };
        result = await deleteCandidate(payload.jobId, payload.candidateId, { userId, actor: 'ai' });
        break;
      }
      case 'create_campaign': {
        // payload = { jobId, sequence, candidates: [{ id, name, email }] }. The recruiter may
        // have unticked people or switched single email <-> Day 0/3/7 on the card.
        if (!deps) throw new AppError(500, 'NO_QUEUE', 'Background tasks are not available.');
        const payload = action.payload as { jobId: string; jobCode?: string; sequence: 'single' | 'sequence'; candidates: { id: string }[] };
        const sequence = (edits?.sequence as 'single' | 'sequence' | undefined) ?? payload.sequence;
        const ids = (edits?.candidateIds as string[] | undefined) ?? payload.candidates.map((c) => c.id);
        const made = await createCampaign(outreachDeps(deps), payload.jobId, userId, { candidateIds: ids, stepDays: SEQUENCES[sequence] });
        result = { jobId: payload.jobId, jobCode: payload.jobCode, campaignId: made.campaignId, taskId: made.task.id, candidates: made.candidates, steps: made.steps };
        break;
      }
      case 'approve_campaign': {
        // payload = { jobId, campaignId, ... }. Same function as "Approve & send" on the Emails tab.
        if (!deps) throw new AppError(500, 'NO_QUEUE', 'Background tasks are not available.');
        const payload = action.payload as { jobId: string; jobCode?: string; campaignId: string };
        const approved = await approveCampaign(outreachDeps(deps), payload.jobId, payload.campaignId, userId, 'ai');
        result = { jobId: payload.jobId, jobCode: payload.jobCode, campaignId: payload.campaignId, emails: approved.emails, mode: approved.mode, taskId: approved.task.id };
        break;
      }
      case 'change_status': {
        // payload = { jobId, to, candidates: [{ id, name, allowed, ... }] }. The recruiter may
        // have unticked some people on the card: edits.candidateIds is who's left.
        const payload = action.payload as { jobId: string; to: CandidateStatus; candidates: { id: string; allowed: boolean }[] };
        const ids = (edits?.candidateIds as string[] | undefined) ?? payload.candidates.filter((c) => c.allowed).map((c) => c.id);
        const moved = await changeStatuses(new Types.ObjectId(payload.jobId), ids, payload.to, { actor: 'ai', userId });
        result = { jobId: payload.jobId, to: payload.to, changed: moved.changed, skipped: moved.skipped };
        break;
      }
      case 'update_candidate': {
        // payload = { jobId, candidateId, name, before, changes }. The recruiter may have
        // corrected the new email/link on the card (e.g. a typo the AI pointed out).
        const payload = action.payload as { jobId: string; candidateId: string; changes: Record<string, unknown> };
        const updated = await updateCandidateContact(payload.jobId, payload.candidateId, { ...payload.changes, ...(edits ?? {}) }, { userId, actor: 'ai' });
        result = { jobId: payload.jobId, name: updated.candidate.name, changed: updated.changed };
        break;
      }
      case 'delete_all_candidates': {
        // payload = { jobId, jobCode, title, count }. Same function as the "Delete all" button.
        const payload = action.payload as { jobId: string };
        result = await deleteAllCandidates(payload.jobId, { userId, actor: 'ai' });
        break;
      }
      case 'score_candidates': {
        // payload = { jobId, jobCode, title, unscored }. Same as the "Score N unscored" button.
        if (!deps) throw new AppError(500, 'NO_QUEUE', 'Background tasks are not available.');
        const payload = action.payload as { jobId: string; jobCode?: string };
        const task = await startScoring(deps, payload.jobId, userId);
        result = { jobId: payload.jobId, jobCode: payload.jobCode, taskId: task.id, total: task.progress.total };
        break;
      }
      case 'find_candidates': {
        // payload = { jobId, jobCode, title, searches: [{ source, label, query, checked }], pages }.
        // The recruiter may have ticked other sites or edited the search words on the card.
        if (!deps) throw new AppError(500, 'NO_QUEUE', 'Background tasks are not available.');
        const payload = action.payload as { jobId: string; jobCode?: string; searches: { source: SearchSource; query: string; checked?: boolean }[]; pages: number };
        const chosen = (edits?.searches as typeof payload.searches | undefined) ?? payload.searches;
        const pages = Number(edits?.pages ?? payload.pages) || 1;
        const searches = chosen.filter((s) => s.checked !== false).map((s) => ({ source: s.source, query: String(s.query ?? '') }));
        const task = await startSourcing(deps, payload.jobId, userId, { searches, pages, actor: 'ai' });
        result = { jobId: payload.jobId, jobCode: payload.jobCode, taskId: task.id, sources: searches.map((s) => SOURCE_LABELS[s.source]) };
        break;
      }
      default:
        throw new AppError(400, 'UNKNOWN_ACTION', 'Unknown action');
    }
    // Keep what was actually done on the card (the recruiter's edits included).
    const finalPayload =
      action.type === 'update_job'
        ? { ...(action.payload as object), changes: { ...(action.payload as { changes: object }).changes, ...(edits ?? {}) } }
        : action.type === 'update_candidate'
          ? { ...(action.payload as object), changes: { ...(action.payload as { changes: object }).changes, ...(edits ?? {}) } }
        : action.type === 'add_candidate'
          ? { ...(action.payload as object), candidate: { ...(action.payload as { candidate: object }).candidate, ...(edits ?? {}) } }
          : { ...(action.payload as object), ...(edits ?? {}) };
    claimed.set({ result, payload: finalPayload });
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
