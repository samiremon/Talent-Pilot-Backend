/**
 * "How did they score?" message in the chat, after AI scoring finishes.
 *
 * When the recruiter confirms an "Add candidate", "Import CSV" or "Find candidates" card, the
 * work (web search, then) scoring runs in
 * the background and takes a few seconds, so the first reply can only say "scoring has
 * started". When the card sees the scoring task finish, it calls
 * POST /chat/actions/:id/follow-up and the AI posts the result:
 *
 *   "Abir Hossain scored 72/100 and ranks #5 of 31 scored candidates in JOB-0003.
 *    Why: ..."
 *
 * The message is saved in the chat like any other, so the AI remembers it later ("how
 * did Abir do?"). It is posted ONCE per card: calling again returns the same message
 * (e.g. after a page reload, the card asks again and gets the existing one).
 *
 * Everything in it comes from the database (score, reason, rank): nothing is made up.
 */
import { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { candidateRanks, parseId, unscoredFilter } from '../jobs/service.js';
import { CandidateModel } from '../models/candidate.js';
import { ChatMessageModel, PendingActionModel } from '../models/chat.js';
import { JobModel } from '../models/job.js';
import { jobCode } from '../models/counter.js';
import { TaskModel } from '../models/task.js';
import { CampaignModel, OutreachMessageModel } from '../models/outreach.js';
import { proposeAction } from './actions.js';
import { presentMessages } from './service.js';

/** How many of the best new people a CSV import message lists. */
const TOP_NEW = 3;

interface FollowUpResult {
  jobId?: string;
  taskId?: string | null;
  candidateId?: string | null;
  candidateIds?: string[];
  name?: string;
  /** Web search only: the sites searched, how many profiles were found, or why it failed. */
  sources?: string[];
  found?: number;
  searchFailed?: string;
  /** Set once the follow-up message was posted (so it's never posted twice). */
  followUpMessageId?: string;
}

export async function postScoringFollowUp(actionId: string, userId: string) {
  const action = await PendingActionModel.findOne({ _id: parseId(actionId, 'Card'), userId: new Types.ObjectId(userId) });
  if (!action) throw AppError.notFound('Card not found');
  if (action.status !== 'confirmed' || !['add_candidate', 'import_csv', 'find_candidates', 'score_candidates', 'create_campaign'].includes(action.type)) {
    throw new AppError(400, 'NO_FOLLOW_UP', 'This card has no scoring result to report.');
  }
  const result = (action.result ?? {}) as FollowUpResult;

  // Already posted: hand back the same message.
  if (result.followUpMessageId) {
    const existing = await ChatMessageModel.findById(result.followUpMessageId).lean();
    if (existing) return (await presentMessages([existing]))[0];
  }

  // Still working? Then there's nothing to report yet.
  const task = result.taskId ? await TaskModel.findById(result.taskId).lean() : null;
  if (task && (task.status === 'queued' || task.status === 'running')) {
    throw new AppError(409, 'SCORING_NOT_DONE', 'Still working.');
  }
  if (action.type === 'find_candidates' && task) {
    // The web search queues scoring when it finishes: wait for that too.
    const scoring = await TaskModel.exists({
      jobId: task.jobId,
      type: 'score_candidates',
      status: { $in: ['queued', 'running'] },
      createdAt: { $gte: task.createdAt },
    });
    if (scoring) throw new AppError(409, 'SCORING_NOT_DONE', 'Scoring is still running.');
    // The people the search added (kept on the search task).
    const taskResult = (task.result ?? {}) as { candidateIds?: string[]; found?: number };
    result.candidateIds = taskResult.candidateIds ?? [];
    result.found = taskResult.found ?? 0;
    result.searchFailed = task.status === 'failed' ? (task.error ?? 'unknown problem') : undefined;
  }

  const jobId = result.jobId!;
  const job = await JobModel.findById(jobId).lean();
  if (!job) throw AppError.notFound('Job not found');

  // Campaign drafts are ready: a preview + the "Approve & send" card (its own path).
  if (action.type === 'create_campaign') {
    const message = await postDraftsReady(userId, job, String((result as { campaignId?: string }).campaignId));
    action.set({ result: { ...result, followUpMessageId: message!.id } });
    action.markModified('result');
    await action.save();
    return message;
  }
  const code = jobCode((job as { jobNumber?: number | null }).jobNumber) ?? 'the job';
  const { ranks, total } = await candidateRanks(job._id);

  const text =
    action.type === 'add_candidate'
      ? await oneCandidateText(result, ranks, total, code)
      : action.type === 'find_candidates'
        ? await searchText(result, ranks, total, code)
        : action.type === 'score_candidates'
          ? `Scoring finished for ${code}: ${total} candidate${total === 1 ? '' : 's'} scored in this job now.`
          : await importText(result, ranks, total, code);

  // Anyone in the job still unscored (the AI had a problem with them)? Then the message comes
  // with a "Score again" card, so the recruiter can retry with one click (nothing runs
  // until they press Confirm).
  const message = await postWithRetryCard(userId, text, job);
  action.set({ result: { ...result, followUpMessageId: message!.id } });
  action.markModified('result');
  await action.save();
  return message;
}

/** "Abir Hossain scored 72/100 and ranks #5 of 31 scored candidates in JOB-0003. Why: …" */
async function oneCandidateText(result: FollowUpResult, ranks: Map<string, number>, total: number, code: string) {
  const candidate = result.candidateId ? await CandidateModel.findById(result.candidateId).lean() : null;
  const name = candidate?.name ?? result.name ?? 'The candidate';
  if (!candidate) return `${name} is no longer in ${code}, so there's no score to show.`;

  if (candidate.score !== null && candidate.score !== undefined) {
    const rank = ranks.get(String(candidate._id));
    return `**${name}** scored **${candidate.score}/100** and ranks **#${rank} of ${total}** scored candidate${total === 1 ? '' : 's'} in ${code}.${candidate.scoreReason ? `\n\nWhy: ${candidate.scoreReason}` : ''}`;
  }
  if (candidate.scoreReason) {
    // Handled but no score: e.g. no experience/skills text to judge.
    return `**${name}** couldn't be scored: ${candidate.scoreReason} Add their experience & skills (click their row on the job page) and they'll be scored on the next run.`;
  }
  return `**${name}** hasn't been scored yet (the AI didn't return a result this time). They'll be scored on the next scoring run for ${code}.`;
}

/** "Scoring finished for the 10 new candidates in JOB-0003. Best new matches: …" */
async function importText(result: FollowUpResult, ranks: Map<string, number>, total: number, code: string) {
  const ids = result.candidateIds ?? [];
  if (!ids.length) return `Scoring finished for ${code}.`;
  const people = await CandidateModel.find({ _id: { $in: ids } }, { name: 1, score: 1 }).lean();
  const scored = people.filter((p) => p.score !== null && p.score !== undefined).sort((a, b) => b.score! - a.score!);
  const unscored = people.length - scored.length;

  const lines = [`Scoring finished for the ${people.length} new candidate${people.length === 1 ? '' : 's'} in ${code} (${total} scored in total).`];
  if (scored.length) {
    lines.push(
      `Best new matches:\n${scored
        .slice(0, TOP_NEW)
        .map((p) => `- **${p.name}**: ${p.score}/100, rank #${ranks.get(String(p._id))} of ${total}`)
        .join('\n')}`,
    );
  }
  if (unscored) lines.push(`${unscored} couldn't be scored (not enough information, or the AI didn't return a result).`);
  return lines.join('\n\n');
}

/** "The web search on LinkedIn, GitHub found 24 profiles: 19 new. Best new matches: …" */
async function searchText(result: FollowUpResult, ranks: Map<string, number>, total: number, code: string) {
  const where = (result.sources ?? []).join(', ') || 'the web';
  if (result.searchFailed) return `The web search on ${where} for ${code} didn't work: ${result.searchFailed}`;
  const ids = result.candidateIds ?? [];
  if (!result.found) return `The web search on ${where} found no matching profiles for ${code}. Try fewer or different search words on a new search.`;
  if (!ids.length) return `The web search on ${where} found ${result.found} profiles for ${code}, but they're all already in this job.`;
  const people = await CandidateModel.find({ _id: { $in: ids } }, { name: 1, score: 1 }).lean();
  const scored = people.filter((p) => p.score !== null && p.score !== undefined).sort((a, b) => b.score! - a.score!);
  const lines = [`The web search on ${where} found ${result.found} profile${result.found === 1 ? '' : 's'} for ${code}: ${people.length} new (${total} scored in this job now).`];
  if (scored.length) {
    lines.push(
      `Best new matches:\n${scored
        .slice(0, TOP_NEW)
        .map((p) => `- **${p.name}**: ${p.score}/100, rank #${ranks.get(String(p._id))} of ${total}`)
        .join('\n')}`,
    );
  }
  const unscored = people.length - scored.length;
  if (unscored) lines.push(`${unscored} couldn't be scored (not enough information in the search result).`);
  lines.push('Search results are short, so check the best ones before reaching out.');
  return lines.join('\n\n');
}

/**
 * Posts the follow-up message. If some of the job's candidates are still unscored, it adds
 * a sentence and a "Score again" card to the same message.
 */
export async function postWithRetryCard(userId: string, text: string, job: { _id: Types.ObjectId; title: string; jobNumber?: number | null }) {
  const unscored = await CandidateModel.countDocuments(unscoredFilter(job._id));
  const code = jobCode(job.jobNumber ?? null);
  let actionId: Types.ObjectId | null = null;
  let fullText = text;
  if (unscored > 0) {
    const card = await proposeAction(userId, 'score_candidates', { jobId: String(job._id), jobCode: code, title: job.title, unscored });
    actionId = card._id as Types.ObjectId;
    fullText += `\n\n${unscored} candidate${unscored === 1 ? ' in' : 's in'} ${code} couldn't be scored (the AI had a problem with their answer). Shall I try again? Press **Confirm** on the card below.`;
  }
  const row = await ChatMessageModel.create({ userId: new Types.ObjectId(userId), role: 'assistant', text: fullText, jobId: job._id, actionId });
  return (await presentMessages([row.toObject()]))[0];
}

/**
 * "Drafts are ready": the first email as a preview, and an "Approve & send" card. The
 * recruiter can still read and edit every draft in the Emails tab first.
 */
async function postDraftsReady(userId: string, job: { _id: Types.ObjectId; title: string; jobNumber?: number | null }, campaignId: string) {
  const code = jobCode(job.jobNumber ?? null);
  const campaign = Types.ObjectId.isValid(campaignId) ? await CampaignModel.findById(campaignId).lean() : null;
  if (!campaign) return postPlain(userId, job._id, `That campaign for ${code} no longer exists.`);
  if (campaign.status !== 'draft') return postPlain(userId, job._id, `The ${campaign.name} campaign was already approved.`);
  const drafts = await OutreachMessageModel.find({ campaignId: campaign._id, status: 'draft' }).sort({ step: 1, createdAt: 1 }).lean();
  const people = new Set(drafts.map((d) => String(d.candidateId))).size;
  const empty = drafts.filter((d) => !d.body.trim()).length;
  const preview = drafts.find((d) => d.step === 0 && d.body.trim());
  const name = preview ? (await CandidateModel.findById(preview.candidateId, { name: 1 }).lean())?.name : null;
  const steps = campaign.stepDays.length === 1 ? 'a single email' : `${campaign.stepDays.length} steps (Day ${campaign.stepDays.join(' / ')})`;
  const lines = [`The drafts for ${code} are ready: ${people} candidate${people === 1 ? '' : 's'}, ${steps}.`];
  if (preview) lines.push(`Here's the first one, to **${name ?? preview.to}** (${preview.to}):\n\n**Subject:** ${preview.subject}\n\n${preview.body}`);
  if (empty) lines.push(`${empty} draft${empty === 1 ? '' : 's'} couldn't be written by the AI: please write ${empty === 1 ? 'it' : 'them'} in the Emails tab before approving.`);
  lines.push(`You can read and edit every draft in the job's **Emails** tab.${campaign.mode === 'sandbox' ? ' Sandbox mode: emails go to the test inbox (Mailpit), not to real candidates.' : ''} Nothing is sent until you approve.`);

  const card = await proposeAction(userId, 'approve_campaign', {
    jobId: String(job._id),
    jobCode: code,
    title: job.title,
    campaignId: String(campaign._id),
    name: campaign.name,
    emails: drafts.length,
    candidates: people,
    stepDays: campaign.stepDays,
    mode: campaign.mode,
  });
  const row = await ChatMessageModel.create({ userId: new Types.ObjectId(userId), role: 'assistant', text: lines.join('\n\n'), jobId: job._id, actionId: card._id });
  return (await presentMessages([row.toObject()]))[0];
}

async function postPlain(userId: string, jobId: Types.ObjectId, text: string) {
  const row = await ChatMessageModel.create({ userId: new Types.ObjectId(userId), role: 'assistant', text, jobId });
  return (await presentMessages([row.toObject()]))[0];
}

