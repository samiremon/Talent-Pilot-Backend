/**
 * "Which email is the candidate replying to?" We email people in two ways:
 *   - outreach campaigns (OutreachMessage, status "sent")
 *   - one-off emails (DirectEmail): the candidate popup's "Send email", or the chat's
 *     "Send email" card ("reject her and send a mail", "email Nayeem the role details")
 * Both count as "emailed": the candidate can reply to either one.
 */
import { Types } from 'mongoose';
import { DirectEmailModel } from '../models/directEmail.js';
import { CampaignModel, OutreachMessageModel } from '../models/outreach.js';

export interface LastEmail {
  subject: string;
  to: string;
  sentAt: Date;
  /** The recruiter who sent it (gets the reply notification); null if unknown. */
  userId: Types.ObjectId | null;
  /** For the Unsubscribe button on our answer to their reply. */
  unsubscribeToken: string | null;
}

/** The newest email we sent this candidate (campaign or one-off), or null if none. */
export async function lastEmailTo(candidateId: Types.ObjectId | string): Promise<LastEmail | null> {
  const id = new Types.ObjectId(String(candidateId));
  const [outreach, direct] = await Promise.all([
    OutreachMessageModel.findOne({ candidateId: id, status: 'sent' }).sort({ sentAt: -1 }).lean(),
    DirectEmailModel.findOne({ candidateId: id }).sort({ sentAt: -1 }).lean(),
  ]);
  const fromOutreach = outreach
    ? {
        subject: outreach.subject ?? '',
        to: outreach.to,
        sentAt: new Date(outreach.sentAt ?? outreach.createdAt ?? 0),
        userId: ((await CampaignModel.findById(outreach.campaignId, { userId: 1 }).lean())?.userId as Types.ObjectId | undefined) ?? null,
        unsubscribeToken: outreach.unsubscribeToken ?? null,
      }
    : null;
  const fromDirect = direct
    ? {
        subject: direct.subject ?? '',
        to: direct.to,
        sentAt: new Date(direct.sentAt ?? direct.createdAt ?? 0),
        userId: (direct.userId as Types.ObjectId | null) ?? null,
        unsubscribeToken: direct.unsubscribeToken ?? null,
      }
    : null;
  if (!fromOutreach || !fromDirect) return fromOutreach ?? fromDirect;
  return fromDirect.sentAt > fromOutreach.sentAt ? fromDirect : fromOutreach;
}

/** Everyone in a job who got at least one email from us (campaign or one-off). */
export async function emailedCandidateIds(jobId: Types.ObjectId): Promise<Types.ObjectId[]> {
  const [outreach, direct] = await Promise.all([
    OutreachMessageModel.distinct('candidateId', { jobId, status: 'sent' }),
    DirectEmailModel.distinct('candidateId', { jobId }),
  ]);
  const unique = new Map([...outreach, ...direct].map((id) => [String(id), id as Types.ObjectId]));
  return [...unique.values()];
}
