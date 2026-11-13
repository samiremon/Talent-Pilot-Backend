/**
 * Seniority: one set of rules for scoring and for the web search.
 *
 * Levels, lowest to highest:  intern < junior < mid < senior < lead
 * (lead also covers principal / staff / head / architect).
 *
 * The scoring rule (the recruiter's): being MORE senior than the job asks is fine, being
 * LESS senior is not. So a senior engineer can score well for a junior or mid role, but a
 * junior can't score high for a senior role:
 *
 *   candidate's level vs the job's level      highest possible score
 *   same or higher                            100 (no cap)
 *   one level below (mid for a senior job)    55
 *   two or more below (junior for senior)     30
 *   unknown (the profile doesn't say)         100: the AI's reason says it's unclear
 *
 * The AI reads each candidate's level from their text (titles, years of experience), and
 * the CODE applies the cap, so the rule always holds, whatever the AI's score was.
 */

export const LEVELS = ['intern', 'junior', 'mid', 'senior', 'lead'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABELS: Record<Level, string> = { intern: 'Intern', junior: 'Junior', mid: 'Mid-level', senior: 'Senior', lead: 'Lead' };

/** Highest score for a candidate this many levels below the job. */
const CAP_ONE_BELOW = 55;
const CAP_TWO_BELOW = 30;

/**
 * The level named in a job's seniority field or title, e.g. "Senior React Developer" ->
 * senior, "Mid-level" -> mid, "Tech Lead" -> lead. Null if it doesn't say.
 */
export function parseLevel(text: string | null | undefined): Level | null {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (/\b(lead|principal|staff|head|architect|director|manager)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'senior';
  if (/\b(mid|mid-level|midlevel|intermediate)\b/.test(t)) return 'mid';
  if (/\b(junior|jr\.?|entry[- ]level|graduate|associate)\b/.test(t)) return 'junior';
  if (/\b(intern|internship|trainee)\b/.test(t)) return 'intern';
  return null;
}

/** The job's level: from its seniority field, else from its title. */
export function jobLevel(job: { seniority?: string | null; title: string }): Level | null {
  return parseLevel(job.seniority) ?? parseLevel(job.title);
}

/**
 * Applies the "not below the job's level" rule to the AI's score. Returns the final score
 * and, when it was lowered, a short note for the reason ("Junior profile for a Senior role").
 */
export function applySeniorityCap(score: number, job: Level | null, candidate: Level | 'unknown'): { score: number; note: string | null } {
  if (!job || candidate === 'unknown') return { score, note: null };
  const below = LEVELS.indexOf(job) - LEVELS.indexOf(candidate);
  if (below <= 0) return { score, note: null };
  const cap = below === 1 ? CAP_ONE_BELOW : CAP_TWO_BELOW;
  if (score <= cap) return { score, note: null };
  return { score: cap, note: `${LEVEL_LABELS[candidate]} profile for a ${LEVEL_LABELS[job]} role: score capped at ${cap}.` };
}
