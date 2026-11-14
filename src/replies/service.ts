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
import { DirectEmailModel } from '../models/directEmail.js';
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

/**
 * The Replies tab, as CONVERSATIONS: one per candidate who replied, newest activity first.
 * Each conversation lists everything in order, start to end:
 *   sent      our outreach emails (first email, follow-ups)
 *   reply     their replies, with the AI's reading (label, summary, status change, ...) and
 *             the drafted answer if it's still waiting (to edit and send right there)
 *   response  our answers that went out
 *   meeting   the call they booked
 */
export async function listReplies(jobRef: string) {
  const job = await resolveJob(jobRef);
  const replies = await ReplyModel.find({ jobId: job._id }).sort({ receivedAt: 1 }).limit(1000).lean();
  const people = new Map((await CandidateModel.find({ jobId: job._id }, { name: 1, status: 1, email: 1 }).lean()).map((c) => [String(c._id), c]));
  const meetings = await MeetingModel.find({ jobId: job._id, status: 'booked' }).lean();
  const sent = await OutreachMessageModel.find({ jobId: job._id, status: 'sent', candidateId: { $in: replies.map((r) => r.candidateId) } }).lean();
  // (outreach for people who only got a one-off email is added below)

  type Event =
    | { kind: 'sent'; at: Date; id: string; subject: string; body: string; step: number; day: number }
    | {
        kind: 'reply';
        at: Date;
        id: string;
        subject: string;
        body: string;
        status: string;
        error: string | null;
        label: string | null;
        confidence: number | null;
        summary: string | null;
        flagged: boolean;
        statusPath: string[];
        followUpsStopped: number;
        response: { subject: string | null; body: string | null; status: string; error: string | null };
      }
    | { kind: 'response'; at: Date; id: string; subject: string | null; body: string | null; autoSent: boolean }
    | { kind: 'meeting'; at: Date; id: string; slot: Date | null }
    | { kind: 'email'; at: Date; id: string; subject: string; body: string; purpose: string };

  const threads = new Map<string, Event[]>();
  const add = (candidateId: unknown, e: Event) => threads.set(String(candidateId), [...(threads.get(String(candidateId)) ?? []), e]);
  for (const r of replies) {
    add(r.candidateId, {
      kind: 'reply',
      at: r.receivedAt,
      id: String(r._id),
      subject: r.subject,
      body: r.body,
      status: r.status,
      error: r.error ?? null,
      label: r.label ?? null,
      confidence: r.confidence ?? null,
      summary: r.summary ?? null,
      flagged: r.flagged,
      statusPath: r.statusPath,
      followUpsStopped: r.followUpsStopped,
      response: { subject: r.response?.subject ?? null, body: r.response?.body ?? null, status: r.response?.status ?? 'none', error: r.response?.error ?? null },
    });
    if (r.response?.status === 'sent' && r.response.sentAt) {
      add(r.candidateId, { kind: 'response', at: r.response.sentAt, id: `${r._id}-response`, subject: r.response.subject ?? null, body: r.response.body ?? null, autoSent: r.response.autoSent });
    }
  }
  // One-off emails (e.g. a rejection): they start a conversation even without a reply.
  const direct = await DirectEmailModel.find({ jobId: job._id }).lean();
  for (const d of direct) add(d.candidateId, { kind: 'email', at: d.sentAt, id: String(d._id), subject: d.subject, body: d.body, purpose: d.purpose });
  const sentAll = direct.length ? await OutreachMessageModel.find({ jobId: job._id, status: 'sent', candidateId: { $in: [...threads.keys()].map((id) => new Types.ObjectId(id)) } }).lean() : sent;
  for (const m of sentAll) {
    if (threads.has(String(m.candidateId))) add(m.candidateId, { kind: 'sent', at: m.sentAt ?? m.updatedAt, id: String(m._id), subject: m.subject, body: m.body, step: m.step, day: m.day });
  }
  for (const m of meetings) {
    if (threads.has(String(m.candidateId))) add(m.candidateId, { kind: 'meeting', at: m.bookedAt ?? m.updatedAt, id: String(m._id), slot: m.slot ?? null });
  }

  const conversations = [...threads.entries()].map(([candidateId, events]) => {
    events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const lastReply = [...events].reverse().find((e) => e.kind === 'reply') as Extract<Event, { kind: 'reply' }> | undefined;
    const person = people.get(candidateId);
    return {
      candidateId,
      candidateName: person?.name ?? 'Removed candidate',
      candidateStatus: person?.status ?? null,
      email: person?.email ?? null,
      lastAt: events[events.length - 1]!.at,
      replies: events.filter((e) => e.kind === 'reply').length,
      // For the list: the latest reply's label / summary, and whether an answer is waiting.
      label: lastReply?.label ?? null,
      summary: lastReply?.summary ?? null,
      processing: events.some((e) => e.kind === 'reply' && e.status === 'processing'),
      waiting: events.some((e) => e.kind === 'reply' && e.response.status === 'draft'),
      booked: events.some((e) => e.kind === 'meeting'),
      events,
    };
  });
  conversations.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());

  // Who can get a simulated reply: people who were emailed and haven't unsubscribed.
  const emailed = await OutreachMessageModel.distinct('candidateId', { jobId: job._id, status: 'sent' });
  const canReply = (await CandidateModel.find({ _id: { $in: emailed }, status: { $ne: 'unsubscribed' } }, { name: 1, status: 1 }).lean()).map((c) => ({
    id: String(c._id),
    name: c.name,
    status: c.status,
  }));
  return { canReply, conversations };
}
