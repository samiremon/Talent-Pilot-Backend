/**
 * Sending an approved campaign (background task "send_outreach").
 *
 * Each run sends every approved message whose time has come, then schedules itself to
 * wake up again when the next one is due (e.g. the Day 3 follow-ups). Before each email:
 *
 *   1. DAILY LIMIT: at most OUTREACH_DAILY_LIMIT outreach emails in any 24 hours (all
 *      jobs together). Over the limit, it waits until a slot frees up.
 *   2. STILL OK TO EMAIL? Only candidates who are Accepted or Contacted. Anyone who
 *      replied, unsubscribed, was rejected (or anything later) gets no more follow-ups:
 *      their remaining steps are marked "skipped" with the reason.
 *   3. CLAIM IT: approved -> sending in ONE database operation. If two workers ever ran at
 *      once, only one could claim the message: nobody gets the same step twice.
 *
 * Then it sends (sandbox = Mailpit, live = real SMTP), marks it sent, and after the FIRST
 * email moves the candidate Accepted -> Contacted (through the normal status rules, so it
 * shows in the activity log).
 *
 * Unsubscribe: every email carries the standard List-Unsubscribe headers (RFC 2369 / 8058),
 * which mail apps like Gmail show as an "Unsubscribe" button. The link is personal (a random
 * token per email) and leads to /unsubscribe/:token (see outreach/unsubscribe.ts).
 */
import { randomBytes } from 'node:crypto';
import { changeCandidateStatus } from '../candidates/statusChange.js';
import type { Mailer } from '../email/mailer.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { CampaignModel, OutreachMessageModel } from '../models/outreach.js';
import { STATUS_LABELS, type CandidateStatus } from '../pipeline/status.js';
import type { TaskEvents } from '../tasks/events.js';
import type { Processor, TaskQueue } from '../tasks/queue.js';
import { updateTask } from '../tasks/service.js';

export interface OutreachSettings {
  mode: 'sandbox' | 'live';
  dailyLimit: number;
  daySeconds: number;
  /** Where people open the app (for the unsubscribe link), e.g. http://localhost:8080. */
  appUrl?: string;
}

/** Statuses that may still receive outreach. */
const EMAILABLE: readonly CandidateStatus[] = ['accepted', 'contacted'];

/** The headers that make mail apps show an "Unsubscribe" button for this email. */
export function unsubscribeHeaders(appUrl: string, token: string): Record<string, string> {
  const link = `${appUrl.replace(/\/$/, '')}/api/unsubscribe/${token}`;
  return {
    'List-Unsubscribe': `<${link}>`,
    // One-click: the mail app may POST to the link directly (no page to click through).
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function sendOutreachProcessor({
  events,
  mailer,
  settings,
  queue,
}: {
  events: TaskEvents;
  mailer: Mailer;
  settings: OutreachSettings;
  queue: () => TaskQueue;
}): Processor {
  return async (message, attempt) => {
    const { taskId } = message;
    const campaignId = String(message.campaignId);
    const campaign = await CampaignModel.findById(campaignId).lean();
    if (!campaign || campaign.status !== 'active') {
      // Paused (or deleted): stop quietly; resuming wakes it up again.
      if (campaign?.status === 'paused') await updateTask(events, taskId, { status: 'done', message: 'Paused. Resume the campaign to continue sending.' });
      return;
    }
    const mode = campaign.mode as 'sandbox' | 'live';
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    await updateTask(events, taskId, { status: 'running', attempts: attempt.number, message: 'Sending due emails…' });

    const due = await OutreachMessageModel.find({ campaignId: campaign._id, status: 'approved', sendAt: { $lte: new Date() } }).sort({ sendAt: 1, step: 1 }).lean();
    for (const m of due) {
      // 1. Daily limit (counted over the last 24 hours, all jobs).
      const windowStart = new Date(Date.now() - DAY_MS);
      const sentToday = await OutreachMessageModel.countDocuments({ status: 'sent', sentAt: { $gte: windowStart } });
      if (sentToday >= settings.dailyLimit) {
        const oldest = await OutreachMessageModel.findOne({ status: 'sent', sentAt: { $gte: windowStart } }).sort({ sentAt: 1 }).lean();
        const freeAt = new Date((oldest?.sentAt?.getTime() ?? Date.now()) + DAY_MS + 1000);
        await scheduleWake(queue(), message, freeAt);
        await updateTask(events, taskId, {
          status: 'done',
          message: `Daily limit reached (${settings.dailyLimit} emails per 24 h). Sent ${sent} now; the rest continue at ${freeAt.toLocaleString('en-GB')}.`,
        });
        return;
      }

      // 2. Still OK to email this person?
      const candidate = await CandidateModel.findById(m.candidateId).lean();
      if (!candidate || candidate.doNotEmail || !EMAILABLE.includes(candidate.status as CandidateStatus)) {
        const why = !candidate ? 'the candidate was removed' : candidate.doNotEmail ? `${candidate.name} unsubscribed` : `${candidate.name} is ${STATUS_LABELS[candidate.status as CandidateStatus]}: no more emails`;
        await OutreachMessageModel.updateMany({ campaignId: campaign._id, candidateId: m.candidateId, status: 'approved' }, { $set: { status: 'skipped', note: why } });
        skipped++;
        continue;
      }

      // 3. Claim it (only one sender can), then send.
      const claimed = await OutreachMessageModel.findOneAndUpdate({ _id: m._id, status: 'approved' }, { $set: { status: 'sending' } }, { new: true });
      if (!claimed) continue;
      try {
        const token = randomBytes(24).toString('base64url');
        await OutreachMessageModel.updateOne({ _id: claimed._id }, { $set: { unsubscribeToken: token } });
        await mailer.send({
          to: claimed.to,
          subject: claimed.subject,
          text: claimed.body,
          headers: unsubscribeHeaders(settings.appUrl ?? 'http://localhost:8080', token),
        });
        await OutreachMessageModel.updateOne({ _id: claimed._id }, { $set: { status: 'sent', sentAt: new Date(), error: null } });
        sent++;
        await ActivityModel.create({
          jobId: campaign.jobId,
          candidateId: candidate._id,
          type: 'email_sent',
          actor: 'ai',
          userId: campaign.userId,
          message: `Emailed ${candidate.name}: step ${claimed.step + 1} (Day ${claimed.day})${mode === 'sandbox' ? ' to the sandbox inbox' : ''}`,
        });
        // First email: Accepted -> Contacted (normal rules + activity log).
        if (candidate.status === 'accepted') {
          await changeCandidateStatus({ candidateId: candidate._id, to: 'contacted', actor: 'ai', userId: campaign.userId }).catch(() => undefined);
        }
      } catch (err) {
        // Not retried automatically: a wrong address won't fix itself. Shown in the Emails tab.
        await OutreachMessageModel.updateOne({ _id: claimed._id }, { $set: { status: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : String(err) } });
        failed++;
      }
      await updateTask(events, taskId, { progress: { done: sent }, message: `Sent ${sent} email${sent === 1 ? '' : 's'}…` });
    }

    // What's next? Wake up when the next approved message is due, or finish.
    const next = await OutreachMessageModel.findOne({ campaignId: campaign._id, status: 'approved' }).sort({ sendAt: 1 }).lean();
    // Totals for the whole campaign (this run may have sent only one step).
    const sentTotal = await OutreachMessageModel.countDocuments({ campaignId: campaign._id, status: 'sent' });
    const allTotal = await OutreachMessageModel.countDocuments({ campaignId: campaign._id, status: { $ne: 'draft' } });
    const parts = [`Sent ${sentTotal} of ${allTotal} email${allTotal === 1 ? '' : 's'}`];
    if (skipped) parts.push(`stopped follow-ups for ${skipped}`);
    if (failed) parts.push(`${failed} failed`);
    if (next?.sendAt) {
      await scheduleWake(queue(), message, next.sendAt);
      await updateTask(events, taskId, { status: 'done', progress: { total: allTotal, done: sentTotal }, message: `${parts.join(', ')}. Next: Day ${next.day} emails at ${next.sendAt.toLocaleString('en-GB')}.` });
    } else {
      await CampaignModel.updateOne({ _id: campaign._id }, { $set: { status: 'done' } });
      await updateTask(events, taskId, { status: 'done', progress: { total: allTotal, done: sentTotal }, message: `${parts.join(', ')}. Campaign finished.` });
    }
  };
}

/** Wake the sender up at `when` (a fresh key each time, so BullMQ doesn't drop it;
 *  BullMQ job ids may not contain ":", hence the "-"). */
export async function scheduleWake(queue: TaskQueue, message: { taskId: string; jobId: string; userId?: string | null; [k: string]: unknown }, when: Date) {
  const delayMs = Math.max(0, when.getTime() - Date.now());
  await queue.enqueue('send_outreach', message, { delayMs, key: `${message.taskId}-${when.getTime()}` });
}

/** For the Emails tab: outreach emails sent in the last 24 hours (all jobs). */
export async function sentLast24h(): Promise<number> {
  return OutreachMessageModel.countDocuments({ status: 'sent', sentAt: { $gte: new Date(Date.now() - DAY_MS) } });
}

