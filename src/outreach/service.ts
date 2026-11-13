/**
 * Outreach campaigns: the actions shared by the Emails tab and the AI's chat cards.
 *
 *   createCampaign()   pick accepted candidates with an email, 1 step or Day 0/3/7 ->
 *                      empty drafts + background AI drafting (live progress)
 *   updateMessage()    the recruiter edits a draft's subject / text
 *   removeCandidate()  take someone out of the campaign before it's sent
 *   approveCampaign()  "nothing is sent without approval": only this starts sending,
 *                      each step at its day; sending is a background job
 *   pause / resume     stop and continue sending
 *   listCampaigns()    everything for the Emails tab
 */
import { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { resolveJob } from '../jobs/service.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { jobCode } from '../models/counter.js';
import { CampaignModel, OutreachMessageModel } from '../models/outreach.js';
import type { TaskEvents } from '../tasks/events.js';
import type { TaskQueue } from '../tasks/queue.js';
import { createTask, presentTask } from '../tasks/service.js';
import { TaskModel } from '../models/task.js';
import type { OutreachSettings } from './sending.js';
import { scheduleWake, sentLast24h } from './sending.js';

export interface OutreachDeps {
  queue: TaskQueue;
  events: TaskEvents;
  outreach: OutreachSettings;
}

/** The two sequences offered: a single email, or a first email + 2 follow-ups. */
export const SEQUENCES = { single: [0], sequence: [0, 3, 7] } as const;

/**
 * Who CAN be added: Accepted candidates with an email address (the brief's rule), who
 * aren't already in another campaign of this job that's still going.
 */
export async function eligibleCandidates(jobId: Types.ObjectId, candidateIds?: string[]) {
  const busy = await OutreachMessageModel.distinct('candidateId', {
    jobId,
    status: { $in: ['draft', 'approved', 'sending'] },
  });
  const filter: Record<string, unknown> = { jobId, status: 'accepted', email: { $type: 'string' }, _id: { $nin: busy } };
  if (candidateIds?.length) filter._id = { $in: candidateIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)), $nin: busy };
  return CandidateModel.find(filter).sort({ score: -1, createdAt: 1 }).lean();
}

export async function createCampaign(
  deps: OutreachDeps,
  jobRef: string,
  userId: string,
  { candidateIds, stepDays }: { candidateIds?: string[]; stepDays: readonly number[] },
) {
  const job = await resolveJob(jobRef);
  const people = await eligibleCandidates(job._id, candidateIds);
  if (people.length === 0) {
    throw new AppError(400, 'NO_ELIGIBLE_CANDIDATES', 'Nobody can be emailed yet: only Accepted candidates with an email address can be added (and not ones already in a running campaign).');
  }
  const days = [...new Set(stepDays.map((d) => Math.max(0, Math.round(d))))].sort((a, b) => a - b);
  const code = jobCode(job.jobNumber);
  const campaign = await CampaignModel.create({
    jobId: job._id,
    userId: new Types.ObjectId(userId),
    name: `${code ?? 'Job'} outreach (${days.length === 1 ? 'single email' : `Day ${days.join(' / ')}`})`,
    stepDays: days,
    status: 'drafting',
    mode: deps.outreach.mode,
  });
  // One empty draft per candidate per step; the AI fills them in.
  await OutreachMessageModel.insertMany(
    people.flatMap((p) => days.map((day, step) => ({ campaignId: campaign._id, jobId: job._id, candidateId: p._id, step, day, to: p.email!, status: 'draft' }))),
  );
  const task = await createTask(deps.events, {
    jobId: String(job._id),
    type: 'draft_outreach',
    userId,
    total: people.length,
    message: `Waiting to draft emails for ${people.length} candidate${people.length === 1 ? '' : 's'}…`,
  });
  await CampaignModel.updateOne({ _id: campaign._id }, { $set: { draftTaskId: new Types.ObjectId(task.id) } });
  await deps.queue.enqueue('draft_outreach', { taskId: task.id, jobId: String(job._id), userId, campaignId: String(campaign._id) });
  await ActivityModel.create({
    jobId: job._id,
    type: 'outreach_created',
    actor: 'recruiter',
    userId: new Types.ObjectId(userId),
    message: `Outreach campaign created for ${people.length} candidate${people.length === 1 ? '' : 's'} (${days.length === 1 ? 'single email' : `Day ${days.join(' / ')}`})`,
  });
  return { campaignId: String(campaign._id), candidates: people.length, steps: days, task };
}

async function loadCampaign(jobRef: string, campaignId: string) {
  const job = await resolveJob(jobRef);
  if (!Types.ObjectId.isValid(campaignId)) throw AppError.notFound('Campaign not found');
  const campaign = await CampaignModel.findOne({ _id: campaignId, jobId: job._id });
  if (!campaign) throw AppError.notFound('Campaign not found');
  return { job, campaign };
}

/** Edit a draft (or an approved email that hasn't gone out yet). */
export async function updateMessage(jobRef: string, messageId: string, input: { subject?: string; body?: string }) {
  const job = await resolveJob(jobRef);
  if (!Types.ObjectId.isValid(messageId)) throw AppError.notFound('Email not found');
  const set: Record<string, string> = {};
  if (typeof input.subject === 'string') set.subject = input.subject.trim().slice(0, 300);
  if (typeof input.body === 'string') set.body = input.body.trim().slice(0, 5000);
  const updated = await OutreachMessageModel.findOneAndUpdate(
    { _id: messageId, jobId: job._id, status: { $in: ['draft', 'approved'] } },
    { $set: { ...set, error: null } },
    { new: true },
  ).lean();
  if (!updated) throw AppError.conflict("This email can't be edited any more (it was sent or skipped).");
  return updated;
}

/** Take one candidate out of a campaign (their unsent steps are skipped). */
export async function removeCandidate(jobRef: string, campaignId: string, candidateId: string) {
  const { campaign } = await loadCampaign(jobRef, campaignId);
  const { modifiedCount } = await OutreachMessageModel.updateMany(
    { campaignId: campaign._id, candidateId: new Types.ObjectId(candidateId), status: { $in: ['draft', 'approved'] } },
    { $set: { status: 'skipped', note: 'Removed by the recruiter' } },
  );
  return { skipped: modifiedCount };
}

/**
 * Approve: every draft must have a subject and text. Then each step gets its send time
 * (approval time + its day) and the background sender starts.
 */
export async function approveCampaign(deps: OutreachDeps, jobRef: string, campaignId: string, userId: string, actor: 'recruiter' | 'ai' = 'recruiter') {
  const { job, campaign } = await loadCampaign(jobRef, campaignId);
  if (campaign.status === 'drafting') throw AppError.conflict('The AI is still writing the drafts. Approve when it has finished.');
  if (campaign.status !== 'draft') throw AppError.conflict(`This campaign was already ${campaign.status === 'done' ? 'sent' : 'approved'}.`);
  const drafts = await OutreachMessageModel.find({ campaignId: campaign._id, status: 'draft' }).lean();
  if (drafts.length === 0) throw new AppError(400, 'NOTHING_TO_SEND', 'There are no drafts left to send in this campaign.');
  const empty = drafts.filter((d) => !d.subject.trim() || !d.body.trim());
  if (empty.length) throw new AppError(400, 'EMPTY_DRAFTS', `${empty.length} draft${empty.length === 1 ? ' is' : 's are'} still empty: write ${empty.length === 1 ? 'it' : 'them'} (or remove those candidates) before approving.`);

  const now = Date.now();
  const dayMs = deps.outreach.daySeconds * 1000;
  for (const d of drafts) {
    await OutreachMessageModel.updateOne({ _id: d._id, status: 'draft' }, { $set: { status: 'approved', sendAt: new Date(now + d.day * dayMs) } });
  }
  // If anything below fails (e.g. the queue is down), undo the approval: the campaign must
  // never be left "approved" with nothing scheduled to send it.
  const rollBack = async () => {
    await OutreachMessageModel.updateMany({ _id: { $in: drafts.map((d) => d._id) }, status: 'approved' }, { $set: { status: 'draft', sendAt: null } });
    await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status: 'draft', approvedAt: null } });
  };
  try {
  const task = await createTask(deps.events, {
    jobId: String(job._id),
    type: 'send_outreach',
    userId,
    total: drafts.length,
    message: `Approved: sending ${drafts.length} email${drafts.length === 1 ? '' : 's'}${campaign.stepDays.length > 1 ? ' step by step' : ''}…`,
  });
  campaign.set({ status: 'active', approvedAt: new Date(now), sendTaskId: new Types.ObjectId(task.id), mode: deps.outreach.mode });
  await campaign.save();
  await ActivityModel.create({
    jobId: job._id,
    type: 'outreach_approved',
    actor,
    userId: new Types.ObjectId(userId),
    message: `Outreach approved${actor === 'ai' ? ' (confirmed in chat)' : ''}: ${drafts.length} email${drafts.length === 1 ? '' : 's'}${deps.outreach.mode === 'sandbox' ? ' (sandbox inbox)' : ''}`,
  });
  await scheduleWake(deps.queue, { taskId: task.id, jobId: String(job._id), userId, campaignId: String(campaign._id) }, new Date(now));
  return { campaignId: String(campaign._id), emails: drafts.length, mode: deps.outreach.mode, task };
  } catch (err) {
    await rollBack();
    throw err;
  }
}

export async function pauseCampaign(jobRef: string, campaignId: string) {
  const { campaign } = await loadCampaign(jobRef, campaignId);
  if (campaign.status !== 'active') throw AppError.conflict('Only a campaign that is sending can be paused.');
  campaign.set({ status: 'paused' });
  await campaign.save();
  return { status: 'paused' };
}

export async function resumeCampaign(deps: OutreachDeps, jobRef: string, campaignId: string, userId: string) {
  const { job, campaign } = await loadCampaign(jobRef, campaignId);
  if (campaign.status !== 'paused') throw AppError.conflict('Only a paused campaign can be resumed.');
  campaign.set({ status: 'active' });
  await campaign.save();
  const taskId = String(campaign.sendTaskId);
  await scheduleWake(deps.queue, { taskId, jobId: String(job._id), userId, campaignId: String(campaign._id) }, new Date());
  return { status: 'active' };
}

/** Everything for the Emails tab: campaigns (newest first) with their emails and names. */
export async function listCampaigns(deps: OutreachDeps, jobRef: string) {
  const job = await resolveJob(jobRef);
  const campaigns = await CampaignModel.find({ jobId: job._id }).sort({ createdAt: -1 }).lean();
  const messages = await OutreachMessageModel.find({ jobId: job._id }).sort({ step: 1 }).lean();
  const names = new Map((await CandidateModel.find({ jobId: job._id }, { name: 1, status: 1 }).lean()).map((c) => [String(c._id), c]));
  const tasks = new Map(
    (await TaskModel.find({ _id: { $in: campaigns.flatMap((c) => [c.draftTaskId, c.sendTaskId]).filter(Boolean) } }).lean()).map((t) => [String(t._id), presentTask(t)]),
  );
  const eligible = (await eligibleCandidates(job._id)).length;
  return {
    settings: { mode: deps.outreach.mode, dailyLimit: deps.outreach.dailyLimit, daySeconds: deps.outreach.daySeconds, sentLast24h: await sentLast24h(), eligible },
    campaigns: campaigns.map((c) => ({
      id: String(c._id),
      name: c.name,
      status: c.status,
      mode: c.mode,
      stepDays: c.stepDays,
      approvedAt: c.approvedAt,
      createdAt: c.createdAt,
      draftTask: c.draftTaskId ? (tasks.get(String(c.draftTaskId)) ?? null) : null,
      sendTask: c.sendTaskId ? (tasks.get(String(c.sendTaskId)) ?? null) : null,
      messages: messages
        .filter((m) => String(m.campaignId) === String(c._id))
        .map((m) => ({
          id: String(m._id),
          candidateId: String(m.candidateId),
          candidateName: names.get(String(m.candidateId))?.name ?? 'Removed candidate',
          candidateStatus: names.get(String(m.candidateId))?.status ?? null,
          step: m.step,
          day: m.day,
          to: m.to,
          subject: m.subject,
          body: m.body,
          status: m.status,
          sendAt: m.sendAt,
          sentAt: m.sentAt,
          error: m.error,
          note: m.note,
        })),
    })),
  };
}
