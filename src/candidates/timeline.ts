/**
 * One candidate's timeline, for the candidate popup:
 *
 *   path:    Sourced -> Accepted -> Contacted          (the statuses they actually went through)
 *   events:  Added from web search (LinkedIn)          13 Nov, 14:02
 *            Sourced -> Accepted   by Rina             13 Nov, 15:10
 *            Emailed: step 1 (Day 0)   by the AI       13 Nov, 15:12
 *            Updated email   by Rina                   13 Nov, 16:00
 *   upcoming: Day 3 email scheduled for 16 Nov, 15:12
 *
 * Built from the activity log (every change is logged there, by the UI and the AI alike),
 * plus when they were added and any outreach emails still scheduled. Undone status changes
 * stay in the list, marked as undone, and don't count in the path.
 */
import { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { resolveJob, userNames } from '../jobs/service.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { OutreachMessageModel } from '../models/outreach.js';
import { STATUS_LABELS, type CandidateStatus } from '../pipeline/status.js';

const SOURCE_LABELS = { csv: 'a CSV upload', web: 'web search', manual: 'by hand' } as const;

export async function candidateTimeline(jobRef: string, candidateId: string) {
  const job = await resolveJob(jobRef);
  if (!Types.ObjectId.isValid(candidateId)) throw AppError.notFound('Candidate not found');
  const candidate = await CandidateModel.findOne({ _id: candidateId, jobId: job._id }).lean();
  if (!candidate) throw AppError.notFound('Candidate not found');

  const rows = await ActivityModel.find({ jobId: job._id, candidateId: candidate._id }).sort({ createdAt: 1 }).lean();
  const names = await userNames(rows.map((r) => r.userId));

  const events = [
    {
      id: 'added',
      kind: 'added' as const,
      text: `Added from ${SOURCE_LABELS[candidate.source as keyof typeof SOURCE_LABELS] ?? candidate.source}`,
      by: null as string | null,
      at: candidate.createdAt,
      undone: false,
    },
    ...rows.map((r) => ({
      id: String(r._id),
      kind: (r.type === 'status_changed' || r.type === 'status_undone' ? 'status' : r.type === 'email_sent' ? 'email' : 'other') as 'status' | 'email' | 'other',
      // The log's own sentence, without the leading "Name: " (we're on their page already).
      text: r.message.replace(new RegExp(`^${candidate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `), ''),
      by: r.actor === 'ai' ? 'the AI' : r.actor === 'system' ? 'the system' : r.userId ? (names.get(String(r.userId)) ?? 'a recruiter') : 'a recruiter',
      at: r.createdAt,
      undone: Boolean(r.undone),
    })),
  ];

  // The path: Sourced, then every status change that wasn't undone (undo rows themselves
  // are skipped too, since they only reverse an earlier step).
  const path: CandidateStatus[] = ['sourced'];
  for (const r of rows) {
    if (r.type === 'status_changed' && !r.undone && r.toStatus) path.push(r.toStatus as CandidateStatus);
  }

  // Outreach emails still to come (e.g. the Day 3 follow-up).
  const upcoming = (await OutreachMessageModel.find({ candidateId: candidate._id, status: 'approved' }).sort({ sendAt: 1 }).lean()).map((m) => ({
    id: String(m._id),
    text: `Email step ${m.step + 1} (Day ${m.day}) scheduled`,
    at: m.sendAt,
  }));

  return {
    current: candidate.status,
    path: path.map((status) => ({ status, label: STATUS_LABELS[status] })),
    events,
    upcoming,
  };
}
