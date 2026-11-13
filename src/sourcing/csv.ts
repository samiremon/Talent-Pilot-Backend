/**
 * Reading an uploaded candidates CSV.
 *
 * Accepts the column names people actually use (case and spaces don't matter):
 *   name        name, full name, candidate, first name + last name
 *   email       email, e-mail, email address
 *   profileUrl  linkedin, linkedin url, profile, profile url, url, github, portfolio
 *   headline    headline, title, current title, position, role
 *   location    location, city, country
 *   profileText summary, about, notes, skills, experience, bio, description
 *               (several of these are joined: it's what the AI scores)
 *
 * Limits keep a bad file from hurting the server: 2 MB (enforced by the upload) and 1,000
 * rows. Rows are then checked and de-duplicated by addCandidates().
 */
import { parse } from 'csv-parse/sync';
import { AppError } from '../errors.js';
import type { NewCandidate } from '../candidates/addCandidates.js';

export const MAX_CSV_ROWS = 1000;

const ALIASES: Record<keyof NewCandidate | 'firstName' | 'lastName', string[]> = {
  name: ['name', 'full name', 'fullname', 'candidate', 'candidate name'],
  firstName: ['first name', 'firstname', 'given name'],
  lastName: ['last name', 'lastname', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  profileUrl: ['linkedin', 'linkedin url', 'linkedin profile', 'profile', 'profile url', 'url', 'github', 'portfolio', 'website'],
  headline: ['headline', 'title', 'current title', 'position', 'role', 'job title'],
  location: ['location', 'city', 'country', 'based in'],
  profileText: ['summary', 'about', 'notes', 'skills', 'experience', 'bio', 'description', 'profile text'],
};

/** "  LinkedIn URL " -> "linkedin url" */
const normal = (header: string) => header.trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');

export function parseCandidatesCsv(content: string): NewCandidate[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(content, {
      columns: (headers: string[]) => headers.map(normal),
      skip_empty_lines: true,
      trim: true,
      bom: true, // Excel adds an invisible marker at the start
      relax_column_count: true, // tolerate rows with a missing/extra cell
    });
  } catch (err) {
    throw new AppError(400, 'CSV_INVALID', `This file couldn't be read as a CSV: ${(err as Error).message}`);
  }
  if (rows.length === 0) throw new AppError(400, 'CSV_EMPTY', 'The CSV has no rows.');
  if (rows.length > MAX_CSV_ROWS) {
    throw new AppError(400, 'CSV_TOO_BIG', `The CSV has ${rows.length} rows; the limit is ${MAX_CSV_ROWS}.`);
  }

  const headers = Object.keys(rows[0]!);
  // Aliases are tidied the same way as the headers ("e-mail" -> "e mail"), so they match.
  const pick = (row: Record<string, string>, field: keyof typeof ALIASES) =>
    ALIASES[field].map((alias) => row[normal(alias)]).find((v) => v && v.trim()) ?? '';
  const hasName = [...ALIASES.name, ...ALIASES.firstName].some((a) => headers.includes(normal(a)));
  if (!hasName) {
    throw new AppError(400, 'CSV_NO_NAME', 'The CSV needs a "name" column (or "first name" + "last name").');
  }

  return rows.map((row) => {
    const name = pick(row, 'name') || [pick(row, 'firstName'), pick(row, 'lastName')].filter(Boolean).join(' ');
    // Every "about"-type column joined, labelled, so the AI sees all of it.
    const text = ALIASES.profileText
      .filter((alias) => row[normal(alias)])
      .map((alias) => `${alias}: ${row[normal(alias)]}`)
      .join('\n');
    return {
      name,
      email: pick(row, 'email') || null,
      profileUrl: pick(row, 'profileUrl') || null,
      headline: pick(row, 'headline') || null,
      location: pick(row, 'location') || null,
      profileText: text || null,
    };
  });
}
