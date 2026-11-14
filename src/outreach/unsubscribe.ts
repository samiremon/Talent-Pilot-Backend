/**
 * Unsubscribe links (public: the candidate isn't logged in).
 *
 *   GET  /unsubscribe/:token   a small page: "Stop emails about <role>?  [Unsubscribe]"
 *                              (opening the link changes NOTHING: some mail systems open
 *                              links automatically to scan them)
 *   POST /unsubscribe/:token   unsubscribes: the button above, or a mail app's one-click
 *                              "Unsubscribe" button (List-Unsubscribe-Post, RFC 8058)
 *
 * Unsubscribing moves the candidate to "Unsubscribed" (through the normal status rules, so
 * it's in the activity log and their timeline) and cancels every email still scheduled for
 * them, in every campaign. The token is random per email, so links can't be guessed.
 */
import { Router, type Response } from 'express';
import { moveCandidate } from '../replies/processing.js';
import { escapeHtml } from '../email/mailer.js';
import { asyncHandler } from '../errors.js';
import { ActivityModel } from '../models/activity.js';
import { CandidateModel } from '../models/candidate.js';
import { JobModel } from '../models/job.js';
import { OutreachMessageModel } from '../models/outreach.js';
import { DirectEmailModel } from '../models/directEmail.js';

/** Unsubscribes the person behind this token. Returns their name, or null for a bad token. */
export async function unsubscribeByToken(token: string): Promise<{ name: string; already: boolean } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  // Outreach emails and one-off emails both carry an unsubscribe token.
  const message = (await OutreachMessageModel.findOne({ unsubscribeToken: token }).lean()) ?? (await DirectEmailModel.findOne({ unsubscribeToken: token }).lean());
  if (!message) return null;
  const candidate = await CandidateModel.findById(message.candidateId).lean();
  if (!candidate) return null;

  // No more emails, in any campaign.
  await OutreachMessageModel.updateMany(
    { candidateId: candidate._id, status: { $in: ['draft', 'approved'] } },
    { $set: { status: 'skipped', note: `${candidate.name} unsubscribed` } },
  );
  // The "never email" mark first: it holds whatever their status is.
  await CandidateModel.updateOne({ _id: candidate._id }, { $set: { doNotEmail: true } });
  if (candidate.status === 'unsubscribed') return { name: candidate.name, already: true };
  // Then the status, through the normal rules (e.g. Accepted -> Contacted -> Unsubscribed:
  // they did receive an email).
  const path = await moveCandidate(candidate._id, 'unsubscribed', null);
  if (path.length === 0) {
    // A status the rules don't allow to move to Unsubscribed (e.g. Hired): the emails are
    // stopped anyway; note it in the log.
    await ActivityModel.create({
      jobId: candidate.jobId,
      candidateId: candidate._id,
      type: 'status_changed',
      actor: 'system',
      message: `${candidate.name} clicked unsubscribe: no more emails will be sent`,
    });
  }
  return { name: candidate.name, already: false };
}

function page(res: Response, title: string, body: string, status = 200) {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
        `<style>body{font-family:system-ui,sans-serif;background:#f5f6fa;color:#111827;display:grid;place-items:center;min-height:100vh;margin:0}` +
        `main{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 32px;max-width:420px;text-align:center}` +
        `button{background:#b91c1c;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}p{line-height:1.5}</style></head>` +
        `<body><main>${body}</main></body></html>`,
    );
}

export function unsubscribeRouter(): Router {
  const router = Router();

  router.get(
    '/:token',
    asyncHandler(async (req, res) => {
      const token = req.params.token as string;
      const message = /^[A-Za-z0-9_-]{20,64}$/.test(token)
        ? ((await OutreachMessageModel.findOne({ unsubscribeToken: token }).lean()) ?? (await DirectEmailModel.findOne({ unsubscribeToken: token }).lean()))
        : null;
      if (!message) return page(res, 'Link not valid', '<h1>Link not valid</h1><p>This unsubscribe link is not valid or has expired.</p>', 404);
      const job = await JobModel.findById(message.jobId, { title: 1, company: 1 }).lean();
      const about = job ? `the ${escapeHtml(job.title)} role${job.company ? ` at ${escapeHtml(job.company)}` : ''}` : 'this role';
      page(
        res,
        'Unsubscribe',
        `<h1>Unsubscribe</h1><p>Stop receiving emails about ${about}?</p>` +
          `<form method="post" action=""><button type="submit">Unsubscribe</button></form>`,
      );
    }),
  );

  router.post(
    '/:token',
    asyncHandler(async (req, res) => {
      const result = await unsubscribeByToken(req.params.token as string);
      if (!result) return page(res, 'Link not valid', '<h1>Link not valid</h1><p>This unsubscribe link is not valid or has expired.</p>', 404);
      page(res, 'Unsubscribed', `<h1>You're unsubscribed</h1><p>You won't receive any more emails from us about this role.</p>`);
    }),
  );
  return router;
}
