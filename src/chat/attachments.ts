/**
 * Attaching a CSV in the chat (the 📎 button).
 *
 * Nothing is imported straight away (approve-before-action). We:
 *   1. read the CSV (same reader as the Upload CSV button)
 *   2. work out what an import WOULD do: new people, duplicates, unusable rows
 *   3. save the recruiter's "📎 file" message + an assistant reply with an "Import CSV" card
 * Pressing Confirm on the card runs the import + scoring (chat/actions.ts, "import_csv").
 *
 * The messages go into the normal chat history, so the AI knows a file was attached.
 * No AI tokens are used for this part.
 */
import { Types } from 'mongoose';
import { planCandidates } from '../candidates/addCandidates.js';
import { getJob, resolveJob } from '../jobs/service.js';
import { ChatMessageModel } from '../models/chat.js';
import { parseCandidatesCsv } from '../sourcing/csv.js';
import { proposeAction } from './actions.js';
import { withCardFooter } from './agent.js';
import { presentMessages } from './service.js';

export async function attachCsv(userId: string, jobRef: string, fileName: string, csvText: string) {
  const found = await resolveJob(jobRef);
  const job = await getJob(String(found._id));
  const people = parseCandidatesCsv(csvText);
  const plan = await planCandidates(job.id, people);
  const user = new Types.ObjectId(userId);
  const jobObjectId = new Types.ObjectId(job.id);

  const userMessage = await ChatMessageModel.create({
    userId: user,
    role: 'user',
    text: `📎 Attached ${fileName} (${people.length} row${people.length === 1 ? '' : 's'}) for ${job.jobCode ?? job.title}`,
    jobId: jobObjectId,
  });

  if (plan.fresh.length === 0) {
    // Nothing new: no card needed, just say why.
    const reply = await ChatMessageModel.create({
      userId: user,
      role: 'assistant',
      text: `I read ${fileName}: ${people.length} rows, but nobody new for ${job.jobCode} "${job.title}" (${plan.duplicates} already in the job or listed twice, ${plan.invalid} without an email or profile link). Nothing to import.`,
      jobId: jobObjectId,
    });
    return presentMessages([userMessage.toObject(), reply.toObject()]);
  }

  const action = await proposeAction(userId, 'import_csv', {
    jobId: job.id,
    jobCode: job.jobCode,
    title: job.title,
    fileName,
    rows: people.length,
    fresh: plan.fresh.length,
    duplicates: plan.duplicates,
    invalid: plan.invalid,
    // A few names so the recruiter can see it's the right file.
    preview: plan.fresh.slice(0, 5).map((p) => ({ name: p.name, headline: p.headline ?? null })),
    withoutText: plan.fresh.filter((p) => !p.profileText?.trim()).length,
    people,
  });

  const summary =
    `I read ${fileName}: ${people.length} rows. ${plan.fresh.length} new candidate${plan.fresh.length === 1 ? '' : 's'} for ${job.jobCode} "${job.title}"` +
    `${plan.duplicates ? `, ${plan.duplicates} duplicate${plan.duplicates === 1 ? '' : 's'} (skipped)` : ''}` +
    `${plan.invalid ? `, ${plan.invalid} row${plan.invalid === 1 ? '' : 's'} without an email or profile link (skipped)` : ''}. ` +
    'After the import I will score each new candidate against the job.';

  const reply = await ChatMessageModel.create({
    userId: user,
    role: 'assistant',
    text: withCardFooter(summary, true),
    jobId: jobObjectId,
    actionId: action._id,
  });
  return presentMessages([userMessage.toObject(), reply.toObject()]);
}
