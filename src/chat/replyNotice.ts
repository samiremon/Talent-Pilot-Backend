/**
 * The chat message a recruiter gets when a candidate replies:
 *
 *   **Priya Das** replied to your JOB-0003 outreach: **Wants a meeting**.
 *   "Happy to talk, Thursday afternoon works."
 *   Status: Contacted -> Replied -> Interested. 2 follow-ups stopped.
 *   I drafted a response (with a booking link): [card: subject + text, editable, Send / Discard]
 *
 * The card ("send_reply") calls the same functions as the Replies tab.
 */
import { Types } from 'mongoose';
import { CandidateModel } from '../models/candidate.js';
import { ChatMessageModel } from '../models/chat.js';
import { jobCode } from '../models/counter.js';
import { JobModel } from '../models/job.js';
import { ReplyModel, type ReplyLabel } from '../models/reply.js';
import { LABEL_NAMES } from '../replies/processing.js';
import { proposeAction } from './actions.js';

export async function postReplyNotice(replyId: string) {
  const reply = await ReplyModel.findById(replyId).lean();
  if (!reply?.userId || reply.status !== 'done' || !reply.label) return null;
  const [job, candidate] = await Promise.all([JobModel.findById(reply.jobId).lean(), CandidateModel.findById(reply.candidateId, { name: 1 }).lean()]);
  if (!job || !candidate) return null;
  const code = jobCode(job.jobNumber);
  const label = LABEL_NAMES[reply.label as ReplyLabel];

  const lines = [`**${candidate.name}** replied to your ${code} outreach: **${label}**. ${reply.summary ?? ''}`.trim()];
  if (reply.flagged) lines.push('⚠ Their reply contained instructions for the AI. They were ignored; please read it yourself.');
  const facts: string[] = [];
  if (reply.statusPath.length) facts.push(`Status: ${reply.statusPath.join(' → ')}.`);
  if (reply.followUpsStopped) facts.push(`${reply.followUpsStopped} follow-up${reply.followUpsStopped === 1 ? '' : 's'} stopped.`);
  if (facts.length) lines.push(facts.join(' '));

  let actionId: Types.ObjectId | null = null;
  if (reply.response?.status === 'sent') {
    lines.push('I sent the response automatically (auto-send is on). You can read it on the Replies tab.');
  } else if (reply.response?.status === 'draft') {
    lines.push(`I drafted a response${reply.meetingId ? ' with a booking link' : ''}. Check it below and press **Send** (nothing goes out before that).`);
    const card = await proposeAction(String(reply.userId), 'send_reply', {
      jobId: String(job._id),
      jobCode: code,
      replyId: String(reply._id),
      candidateName: candidate.name,
      label: reply.label,
      theirReply: reply.body.slice(0, 1000),
      subject: reply.response.subject,
      body: reply.response.body,
    });
    actionId = card._id as Types.ObjectId;
  } else if (reply.label === 'unsubscribe') {
    lines.push("They asked not to be contacted, so no response is sent and they won't get any more emails.");
  }
  return ChatMessageModel.create({ userId: reply.userId, role: 'assistant', text: lines.join('\n\n'), jobId: job._id, actionId });
}
