/**
 * Tests for the candidate pipeline rules (src/pipeline/status.ts).
 * Pure logic, no database needed.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MOVES,
  CANDIDATE_STATUSES,
  checkMove,
  findPath,
  isCandidateStatus,
  isFinalStatus,
  type CandidateStatus,
} from '../src/pipeline/status.js';

describe('the happy path from the assignment', () => {
  // Sourced -> Accepted -> Contacted -> Replied -> Interested -> Meeting booked
  // -> Interviewed -> Shortlisted -> Hired: every single step must be allowed.
  const journey: CandidateStatus[] = [
    'sourced',
    'accepted',
    'contacted',
    'replied',
    'interested',
    'meeting_booked',
    'interviewed',
    'shortlisted',
    'hired',
  ];

  it.each(journey.slice(0, -1).map((from, i) => [from, journey[i + 1] as CandidateStatus]))(
    'allows %s -> %s',
    (from, to) => {
      expect(checkMove(from, to)).toEqual({ allowed: true });
    },
  );
});

describe('blocked moves explain themselves', () => {
  it('will not hire someone who was never interviewed, and lists the missing steps', () => {
    const result = checkMove('contacted', 'hired', 'Rahim');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe(
        "Can't mark Rahim as Hired yet: they're Contacted. First they need to be: Replied → Meeting booked → Interviewed → Shortlisted.",
      );
    }
  });

  it('will not contact someone the recruiter has not accepted', () => {
    const result = checkMove('sourced', 'contacted', 'Sara');
    expect(result).toEqual({
      allowed: false,
      reason: "Can't mark Sara as Contacted yet: they're Sourced. First they need to be: Accepted.",
    });
  });

  it('will not move backwards (that is what Undo is for)', () => {
    const result = checkMove('interviewed', 'sourced', 'Rahim');
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/back to Sourced.*options are: Shortlisted, Unsubscribed, Rejected/);
  });

  it('says so when the status is already set', () => {
    expect(checkMove('hired', 'hired', 'Rahim')).toEqual({ allowed: false, reason: 'Rahim is already Hired.' });
  });

  it('never changes a final status', () => {
    for (const final of ['hired', 'rejected', 'unsubscribed'] as const) {
      expect(isFinalStatus(final)).toBe(true);
      const result = checkMove(final, 'interested');
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toMatch(/final/);
    }
  });
});

describe('unsubscribe', () => {
  const afterContact: CandidateStatus[] = [
    'contacted',
    'replied',
    'interested',
    'not_interested',
    'meeting_booked',
    'interviewed',
    'shortlisted',
  ];

  it.each(afterContact)('is allowed from %s', (from) => {
    expect(checkMove(from, 'unsubscribed').allowed).toBe(true);
  });

  it.each(['sourced', 'accepted'] as const)('is not allowed before contact (%s)', (from) => {
    const result = checkMove(from, 'unsubscribed');
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/only unsubscribe after being contacted/);
  });
});

describe('the rulebook itself', () => {
  it('only mentions real statuses', () => {
    for (const [from, targets] of Object.entries(ALLOWED_MOVES)) {
      expect(isCandidateStatus(from)).toBe(true);
      for (const to of targets) expect(isCandidateStatus(to)).toBe(true);
    }
  });

  it('lets every candidate reach Hired from Sourced (no dead ends on the main path)', () => {
    expect(findPath('sourced', 'hired')).toEqual([
      'accepted',
      'contacted',
      'replied',
      'meeting_booked',
      'interviewed',
      'shortlisted',
      'hired',
    ]);
  });

  it('can reach Rejected from every non-final status', () => {
    for (const status of CANDIDATE_STATUSES) {
      if (isFinalStatus(status)) continue;
      expect(findPath(status, 'rejected')).not.toBeNull();
    }
  });

  it('rejects unknown status names', () => {
    expect(isCandidateStatus('promoted')).toBe(false);
    expect(isCandidateStatus(42)).toBe(false);
  });
});
