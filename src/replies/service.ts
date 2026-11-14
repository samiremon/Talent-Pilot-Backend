/**
 * Replies: the actions shared by the Replies tab, the AI's chat cards and the
 * POST /simulate-reply endpoint.
 *
 *   simulateReply()    "the candidate answered with this text" -> a Reply + background task
 *                      (a real inbox would do the same). Only for people who were emailed.
 *   listReplies()      everything for the Replies tab (newest first), with meeting info
 *   updateResponse()   edit the drafted answer before sending
 *   sendResponse()     approve and send it (sandbox = Mailpit, like all outreach)
 *   discardResponse()  don't answer
 */
import { Types } from 'mongoose';
import { z } from 'zod';
import type { Mailer } from '../email/mailer.js';
import { AppError } from '../errors.js';
import { resolveJob } from '../jobs/service.js';
import { CandidateModel } from '../models/candidate.js';
import { CampaignModel, OutreachMessageModel } from '../models/outreach.js';
import { MeetingModel, ReplyModel } from '../models/reply.js';
import { PendingActionModel } from '../models/chat.js';
import type { TaskEvents } from '../tasks/events.js';
import type { TaskQueue } from '../tasks/queue.js';
import { createTask } from '../tasks/service.js';
import { sendReplyResponse, type ReplySettings } from './processing.js';

export interface ReplyDeps {
  queue: TaskQueue;
  events: TaskEvents;
  mailer: Mailer;
  replies: ReplySettings;
}

export const simulateInput = z.object({
  subject: z.string().trim().max(300).optional(),
  body: z.string().trim().min(1, 'is empty').max(10_000),
});

export async function simulateReply(deps: ReplyDeps, jobRef: string, candidateId: string, raw: unknown, userId: string) {
  const input = simulateInput.parse(raw);
  const job = await resolveJob(jobRef);
  if (!Types.ObjectId.isValid(candidateId)) throw AppError.notFound('Candidate not found');
  const candidate = await CandidateModel.findOne({ _id: candidateId, jobId: job._id }).lean();
  if (!candidate) throw AppError.notFound('Candidate not found');
  // A reply needs something to reply to: their last outreach email.
  const last = await OutreachMessageModel.findOne({ candidateId: candidate._id, status: 'sent' }).sort({ sentAt: -1 }).lean();
  if (!last) throw new AppError(400, 'NOT_EMAILED', `${candidate.name} hasn't been emailed yet, so there's nothing to reply to. Send them an outreach email first.`);
  // The recruiter who sent the outreach gets the notification (fallback: whoever simulates).
  const campaign = await CampaignModel.findById(last.campaignId, { userId: 1 }).lean();

  const reply = await ReplyModel.create({
    jobId: job._id,
    candidateId: candidate._id,
    userId: campaign?.userId ?? new Types.ObjectId(userId),
    source: 'simulated',
    from: candidate.email ?? last.to,
    subject: input.subject || `Re: ${last.subject}`,
    body: input.body,
  });
  const task = await createTask(deps.events, { jobId: String(job._id), type: 'process_reply', userId, total: 1, message: `Reading ${candidate.name}'s reply…` });
  await ReplyModel.updateOne({ _id: reply._id }, { $set: { taskId: new Types.ObjectId(task.id) } });
  await deps.queue.enqueue('process_reply', { taskId: task.id, jobId: String(job._id), userId, replyId: String(reply._id) });
  return { replyId: String(reply._id), task };
}

async function loadReply(jobRef: string, replyId: string) {
  const job = await resolveJob(jobRef);
  if (!Types.ObjectId.isValid(replyId)) throw AppError.notFound('Reply not found');
  const reply = await ReplyModel.findOne({ _id: replyId, jobId: job._id });
  if (!reply) throw AppError.notFound('Reply not found');
  return { job, reply };
}

export async function updateResponse(jobRef: string, replyId: string, input: { subject?: string; body?: string }) {
  const { reply } = await loadReply(jobRef, replyId);
  if (reply.response?.status !== 'draft') throw AppError.conflict('This response was already sent or discarded.');
  if (typeof input.subject === 'string') reply.set('response.subject', input.subject.trim().slice(0, 300));
  if (typeof input.body === 'string') reply.set('response.body', input.body.trim().slice(0, 5000));
  await reply.save();
  return { ok: true };
}

export async function sendResponse(deps: ReplyDeps, jobRef: string, replyId: string, userId: string, edits?: { subject?: string; body?: string }) {
  const { reply } = await loadReply(jobRef, replyId);
  if (reply.response?.status !== 'draft') throw AppError.conflict('This response was already sent or discarded.');
  if (edits && (edits.subject !== undefined || edits.body !== undefined)) await updateResponse(jobRef, replyId, edits);
  const fresh = await ReplyModel.findById(reply._id).lean();
  if (!fresh?.response?.body?.trim()) throw new AppError(400, 'EMPTY_RESPONSE', 'The response is empty. Write something first.');
  const result = await sendReplyResponse(reply._id, deps.mailer, deps.replies, { userId });
  if (!result) throw AppError.conflict("The response couldn't be sent: the candidate unsubscribed or has no email.");
  await closeReplyCards(reply._id, 'confirmed');
  return { sent: true };
}

export async function discardResponse(jobRef: string, replyId: string) {
  const { reply } = await loadReply(jobRef, replyId);
  if (reply.response?.status !== 'draft') throw AppError.conflict('This response was already sent or discarded.');
  reply.set('response.status', 'discarded');
  await reply.save();
  await closeReplyCards(reply._id, 'cancelled');
  return { ok: true };
}

/**
 * Sent or discarded on the Replies tab (or by one chat card): close the chat's other
 * "Answer ..." cards for this reply, so nobody presses Send on an answer that's already out.
 * (The card being confirmed right now is already claimed, so it isn't touched here.)
 */
async function closeReplyCards(replyId: Types.ObjectId, status: 'confirmed' | 'cancelled') {
  await PendingActionModel.updateMany(
    { type: 'send_reply', status: 'pending', 'payload.replyId': String(replyId) },
    { $set: { status, decidedAt: new Date(), result: { handledElsewhere: true } } },
  );
}

/** The Replies tab: newest first, with the candidate's name/status and the meeting, if any. */
export async function listReplies(jobRef: string) {
  const job = await resolveJob(jobRef);
  const replies = await ReplyModel.find({ jobId: job._id }).sort({ receivedAt: -1 }).limit(200).lean();
  const people = new Map((await CandidateModel.find({ jobId: job._id }, { name: 1, status: 1, email: 1 }).lean()).map((c) => [String(c._id), c]));
  const meetings = new Map((await MeetingModel.find({ jobId: job._id }).lean()).map((m) => [String(m._id), m]));
  // Who can get a simulated reply: people who were emailed and haven't unsubscribed.
  const emailed = await OutreachMessageModel.distinct('candidateId', { jobId: job._id, status: 'sent' });
  const canReply = (await CandidateModel.find({ _id: { $in: emailed }, status: { $ne: 'unsubscribed' } }, { name: 1, status: 1 }).lean()).map((c) => ({
    id: String(c._id),
    name: c.name,
    status: c.status,
  }));
  return {
    canReply,
    replies: replies.map((r) => {
      const meeting = r.meetingId ? meetings.get(String(r.meetingId)) : undefined;
      return {
        id: String(r._id),
        candidateId: String(r.candidateId),
        candidateName: people.get(String(r.candidateId))?.name ?? 'Removed candidate',
        candidateStatus: people.get(String(r.candidateId))?.status ?? null,
        source: r.source,
        from: r.from,
        subject: r.subject,
        body: r.body,
        receivedAt: r.receivedAt,
        status: r.status,
        error: r.error,
        label: r.label,
        confidence: r.confidence,
        summary: r.summary,
        flagged: r.flagged,
        statusPath: r.statusPath,
        followUpsStopped: r.followUpsStopped,
        response: r.response,
        meeting: meeting ? { status: meeting.status, slot: meeting.slot, bookedAt: meeting.bookedAt } : null,
      };
    }),
  };
}
