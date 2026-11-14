/**
 * Candidate pipeline: the statuses a candidate can be in, and which moves are allowed.
 *
 * The journey (from the assignment):
 *
 *   Sourced ─┬─> Accepted ──> Contacted ──> Replied ─┬─> Interested ──> Meeting booked
 *            └─> Not accepted                        └─> Not interested
 *                (Review: Accepted <-> Not accepted, either way, until they're contacted)
 *
 *   Meeting booked ──> Interviewed ─┬─> Shortlisted ─┬─> Hired
 *                                   └─> Rejected     └─> Rejected
 *
 *   + "Not accepted" is the REVIEW decision (not a fit, we won't contact them).
 *   + "Rejected": the recruiter's "no", possible at ANY time (except after Hired), and
 *     reversible: a rejected candidate can be restored to the status they had before
 *     (that one move is checked in candidates/statusChange.ts, which knows the history).
 *   + "Unsubscribed" is possible at any point AFTER Contacted, and stops all emails.
 *
 * Every status change in the app (buttons, chat, AI, background jobs) goes through
 * `checkMove()` below. So the rules live in ONE place, and nobody (not even the AI)
 * can skip a step, e.g. mark someone "Hired" who was never interviewed.
 *
 * Undo is NOT a normal move: it restores the previous status from the activity log,
 * so it's allowed to go "backwards" and is handled separately.
 */

/** Every status, in pipeline order. The text values are what's stored in MongoDB. */
export const CANDIDATE_STATUSES = [
  'sourced',
  'accepted',
  'not_accepted',
  'rejected',
  'contacted',
  'replied',
  'interested',
  'not_interested',
  'meeting_booked',
  'interviewed',
  'shortlisted',
  'hired',
  'unsubscribed',
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** Human-friendly names, for messages shown to the recruiter. */
export const STATUS_LABELS: Record<CandidateStatus, string> = {
  sourced: 'Sourced',
  accepted: 'Accepted',
  not_accepted: 'Not accepted',
  rejected: 'Rejected',
  contacted: 'Contacted',
  replied: 'Replied',
  interested: 'Interested',
  not_interested: 'Not interested',
  meeting_booked: 'Meeting booked',
  interviewed: 'Interviewed',
  shortlisted: 'Shortlisted',
  hired: 'Hired',
  unsubscribed: 'Unsubscribed',
};

/**
 * The rulebook: for each status, where the candidate may go NEXT.
 * An empty list means it's a final status (Hired, Rejected, Unsubscribed).
 */
export const ALLOWED_MOVES: Record<CandidateStatus, readonly CandidateStatus[]> = {
  // Review: the recruiter accepts each sourced candidate, or marks them "Not accepted".
  sourced: ['accepted', 'not_accepted', 'rejected'],
  // Accepted candidates get emailed (-> Contacted), or the recruiter changes their mind.
  accepted: ['contacted', 'not_accepted', 'rejected'],
  // ...and back: a "Not accepted" candidate can be accepted after all.
  not_accepted: ['accepted', 'rejected'],
  // After the first email, we wait for a reply. They may unsubscribe instead.
  contacted: ['replied', 'unsubscribed', 'rejected'],
  // The AI reads the reply and decides. "Wants a meeting" can go straight to Meeting booked.
  replied: ['interested', 'not_interested', 'meeting_booked', 'unsubscribed', 'rejected'],
  interested: ['meeting_booked', 'not_interested', 'unsubscribed', 'rejected'],
  // People change their minds: a "not interested" candidate may write back interested.
  not_interested: ['interested', 'unsubscribed', 'rejected'],
  meeting_booked: ['interviewed', 'unsubscribed', 'rejected'],
  interviewed: ['shortlisted', 'unsubscribed', 'rejected'],
  shortlisted: ['hired', 'unsubscribed', 'rejected'],
  // Hired is final. Unsubscribed people can still be marked Rejected (no emails either way).
  hired: [],
  unsubscribed: ['rejected'],
  // Rejected: only back to the status they had before (see restoreTarget in statusChange.ts).
  rejected: [],
};

/** Statuses where no more emails may be sent to the candidate. */
export const NO_EMAIL_STATUSES: readonly CandidateStatus[] = ['not_accepted', 'rejected', 'unsubscribed', 'not_interested', 'hired'];

export function isCandidateStatus(value: unknown): value is CandidateStatus {
  return typeof value === 'string' && (CANDIDATE_STATUSES as readonly string[]).includes(value);
}

export function isFinalStatus(status: CandidateStatus): boolean {
  return ALLOWED_MOVES[status].length === 0;
}

/**
 * The shortest chain of moves from one status to another, or null if impossible.
 * Example: findPath('meeting_booked', 'hired') -> ['interviewed', 'shortlisted', 'hired']
 * Used to explain to the recruiter what has to happen first.
 */
export function findPath(from: CandidateStatus, to: CandidateStatus): CandidateStatus[] | null {
  if (from === to) return [];

  // Breadth-first search: explore all statuses 1 move away, then 2 moves away, and so on.
  // The first time we reach `to`, we've found a shortest route.
  const cameFrom = new Map<CandidateStatus, CandidateStatus>();
  const queue: CandidateStatus[] = [from];
  const seen = new Set<CandidateStatus>([from]);

  while (queue.length > 0) {
    const current = queue.shift() as CandidateStatus;
    for (const next of ALLOWED_MOVES[current]) {
      if (seen.has(next)) continue;
      seen.add(next);
      cameFrom.set(next, current);
      if (next === to) {
        // Walk back from `to` to `from` to rebuild the route.
        const path: CandidateStatus[] = [to];
        let step = current;
        while (step !== from) {
          path.unshift(step);
          step = cameFrom.get(step) as CandidateStatus;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

export type MoveCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * Can a candidate move from `from` to `to`? If not, `reason` explains why in plain
 * English, ready to show the recruiter or for the AI to repeat.
 *
 *   checkMove('contacted', 'hired', 'Rahim')
 *   -> { allowed: false, reason: "Can't mark Rahim as Hired yet: they're Contacted.
 *        First they need to be: Replied → Meeting booked → Interviewed → Shortlisted." }
 */
export function checkMove(from: CandidateStatus, to: CandidateStatus, name = 'This candidate'): MoveCheck {
  const fromLabel = STATUS_LABELS[from];
  const toLabel = STATUS_LABELS[to];

  if (from === to) {
    return { allowed: false, reason: `${name} is already ${toLabel}.` };
  }
  if (ALLOWED_MOVES[from].includes(to)) {
    return { allowed: true };
  }
  if (isFinalStatus(from)) {
    return { allowed: false, reason: `${name} is ${fromLabel}, which is final. Their status can't change any more.` };
  }
  if (to === 'unsubscribed') {
    return { allowed: false, reason: `${name} can only unsubscribe after being contacted (they're ${fromLabel}).` };
  }

  const path = findPath(from, to);
  if (path) {
    // Everything except the last step is what has to happen first.
    const before = path.slice(0, -1).map((status) => STATUS_LABELS[status]);
    return {
      allowed: false,
      reason: `Can't mark ${name} as ${toLabel} yet: they're ${fromLabel}. First they need to be: ${before.join(' → ')}.`,
    };
  }

  // Not reachable at all (e.g. going backwards from Interviewed to Sourced).
  const options = ALLOWED_MOVES[from].map((status) => STATUS_LABELS[status]).join(', ');
  return {
    allowed: false,
    reason: `Can't move ${name} from ${fromLabel} back to ${toLabel}. From ${fromLabel} the options are: ${options}.`,
  };
}
