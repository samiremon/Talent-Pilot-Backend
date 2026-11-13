/**
 * Finding candidates on the web with Serper (a Google Search API, https://serper.dev).
 *
 * How it works:
 *   1. buildSearchQuery(job) makes a Google query from the job, WITHOUT the AI (no tokens):
 *        site:linkedin.com/in "React" "TypeScript" "Next.js" Frontend Dhaka Bangladesh
 *      ("site:linkedin.com/in" = only public LinkedIn profile pages). The recruiter can edit
 *      it before anything runs.
 *   2. search(query, page) asks Serper for one page of results (up to 10 = 1 credit).
 *      Each result is { title, link, snippet }: what Google shows in its result list.
 *   3. resultToCandidate() turns a result into a candidate:
 *        title   "Sara Ahmed - Senior Frontend Engineer - bKash | LinkedIn"
 *                -> name "Sara Ahmed", headline "Senior Frontend Engineer · bKash"
 *        link    -> profile link (also how duplicates are detected)
 *        snippet -> the text the AI scores
 *
 * We only use what Google shows publicly in search results: we never open or scrape the
 * LinkedIn pages themselves. Snippets are short, so scores rely on less information than
 * a full CV (the AI's reason says so when it matters). No emails: search results don't
 * contain them (a profile link is enough to add someone).
 *
 * Snippets are untrusted text from the internet: the scoring step's prompt-injection guard
 * (and the red "flagged" rows) apply to them like to any other profile.
 *
 * Without SERPER_API_KEY: SAMPLE mode. A few made-up profiles, clearly marked "(sample)",
 * so the whole flow can be tried without signing up. Never mixed with real results.
 */
import { AppError } from '../errors.js';
import type { NewCandidate } from '../candidates/addCandidates.js';

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

export interface SearchClient {
  mode: 'serper' | 'sample';
  /** One page of results (page 1 = results 1-10, page 2 = 11-20, ...). */
  search(query: string, page: number): Promise<SearchResult[]>;
}

/** Results per page (= per Serper credit). */
export const RESULTS_PER_PAGE = 10;
/** At most this many pages per search run (30 results, 3 credits). */
export const MAX_PAGES = 3;

const SERPER_URL = 'https://google.serper.dev/search';

export function createSearchClient(serperKey?: string, fetchFn: typeof fetch = fetch): SearchClient {
  if (!serperKey) return { mode: 'sample', search: async (_query, page) => sampleResults(page) };

  return {
    mode: 'serper',
    async search(query, page) {
      let res: Response;
      try {
        res = await fetchFn(SERPER_URL, {
          method: 'POST',
          headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, num: RESULTS_PER_PAGE, page }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new AppError(502, 'SEARCH_UNREACHABLE', "Couldn't reach the web search service (Serper). Please try again in a moment.");
      }
      if (res.status === 401 || res.status === 403) {
        throw new AppError(503, 'SEARCH_KEY_INVALID', 'The web search key was rejected. Check SERPER_API_KEY in the backend .env file.');
      }
      if (res.status === 429) {
        throw new AppError(503, 'SEARCH_LIMIT', 'Too many web searches right now, or the Serper credits are used up. Please try again later.');
      }
      if (!res.ok) {
        // Serper says "Not enough credits" with a 400.
        const text = await res.text().catch(() => '');
        if (/credit/i.test(text)) throw new AppError(503, 'SEARCH_CREDITS', 'The web search credits (Serper) are used up.');
        throw new AppError(502, 'SEARCH_FAILED', 'The web search failed. Please try again.');
      }
      const data = (await res.json()) as { organic?: { title?: string; link?: string; snippet?: string }[] };
      return (data.organic ?? [])
        .filter((r) => r.title && r.link)
        .map((r) => ({ title: r.title!, link: r.link!, snippet: r.snippet ?? '' }));
    },
  };
}

/** Words that describe the level, not the role: left out of the query (they'd narrow it too much). */
const LEVEL_WORDS = /\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|mid(-level)?|intern|head|chief)\b/gi;

/**
 * A Google query for the job, made from its fields (no AI, no tokens):
 *   site:linkedin.com/in "React" "TypeScript" "Next.js" Frontend Developer Dhaka
 * - up to 3 must-have skills, each in quotes (must appear)
 * - the role from the title, without level words and brackets ("Senior React Developer
 *   (Frontend)" -> "React Developer Frontend"), not quoted (titles are written many ways)
 * - the location, NOT quoted: a quoted city also matches people with that surname
 */
export function buildSearchQuery(job: { title: string; mustHaveSkills?: string[] | null; location?: string | null }): string {
  const skills = (job.mustHaveSkills ?? []).slice(0, 3).map((s) => `"${s.replace(/"/g, '')}"`);
  const role = job.title
    .replace(/[()[\]]/g, ' ')
    .replace(LEVEL_WORDS, ' ')
    .split(/\s+/)
    // Words already in a quoted skill add nothing.
    .filter((w) => w && !skills.some((s) => s.toLowerCase() === `"${w.toLowerCase()}"`))
    .join(' ');
  const location = (job.location ?? '').replace(/[",()]/g, ' ').replace(/\s+/g, ' ').trim();
  return ['site:linkedin.com/in', ...skills, role, location].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Strips the " | LinkedIn" ending and splits "Name - Role - Company" into parts. */
function titleParts(title: string): string[] {
  return title
    .replace(/\s*[|·]\s*LinkedIn.*$/i, '')
    .replace(/\s*-\s*LinkedIn.*$/i, '')
    .split(/\s+[-–—|]\s+/)
    // People decorate their titles: "| Full-Stack", "Developer || React || Next.js".
    .map((p) =>
      p
        .replace(/\s*\|{1,2}\s*/g, ' · ')
        .replace(/^[\s|·•–—-]+|[\s|·•–—-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((p) => p && p !== '...' && p !== '…');
}

/**
 * One search result -> a new candidate, or null if it isn't a person's profile.
 * Only uses what Google shows: never invents an email or anything else.
 */
export function resultToCandidate(result: SearchResult): NewCandidate | null {
  const [first, ...rest] = titleParts(result.title);
  // A person's name: 2-60 characters, no digits or obvious non-name words.
  const name = (first ?? '').replace(/[^\p{L}\p{M}\s.'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60 || /\b(jobs?|hiring|profiles?|people|top \d+)\b/i.test(name)) return null;
  // LinkedIn profile pages only ("/in/..."), on any country subdomain (bd., uk., ...).
  // (Sample mode uses example.com links, which are allowed.)
  let url: URL;
  try {
    url = new URL(result.link);
  } catch {
    return null;
  }
  const isProfile = /(^|\.)linkedin\.com$/i.test(url.hostname) ? /^\/in\/[^/]+/.test(url.pathname) : url.hostname === 'example.com';
  if (!isProfile) return null;

  const headline = rest.join(' · ').slice(0, 300) || null;
  const snippet = result.snippet.replace(/\s+/g, ' ').trim();
  return {
    name,
    email: null,
    profileUrl: `${url.origin}${url.pathname}`.replace(/\/$/, ''),
    headline,
    location: null,
    // What the AI scores: Google's snippet, plus the headline (often holds the key skills).
    profileText: [headline, snippet].filter(Boolean).join('\n') || null,
  };
}

/** Sample mode: made-up profiles (clearly marked), 10 on page 1, 5 on page 2, then none. */
function sampleResults(page: number): SearchResult[] {
  const people = [
    ['Arif Rahman', 'Senior Frontend Engineer (sample)', '6 years with React, TypeScript and Next.js. Built design systems; Jest and React Testing Library. Dhaka.'],
    ['Nusrat Jahan', 'React Developer (sample)', '3 years of React and JavaScript, some TypeScript. Interested in Next.js.'],
    ['Tanvir Ahmed', 'Full Stack Engineer (sample)', 'Node.js and React, TypeScript, PostgreSQL. 5 years. Remote.'],
    ['Farhana Akter', 'Frontend Developer (sample)', 'Vue.js and Nuxt, 4 years. Some React.'],
    ['Rakib Hasan', 'Software Engineer (sample)', 'React Native and React, TypeScript, Jest. 4 years.'],
    ['Sadia Islam', 'UI Engineer (sample)', 'HTML, CSS, Tailwind, accessibility. React basics.'],
    ['Mehedi Hasan', 'Senior Software Engineer (sample)', 'Next.js, React, TypeScript, GraphQL, Jest. Led a team of 4. 7 years.'],
    ['Jannatul Ferdous', 'Junior Frontend Developer (sample)', '1 year of React and JavaScript.'],
    ['Imtiaz Karim', 'Backend Engineer (sample)', 'Java and Spring Boot, 6 years. No frontend.'],
    ['Lamia Haque', 'Frontend Engineer (sample)', 'React, TypeScript, Next.js and Storybook. React Testing Library. 5 years.'],
    ['Shafin Ahmed', 'Web Developer (sample)', 'WordPress and PHP, some JavaScript.'],
    ['Riya Das', 'Frontend Engineer (sample)', 'Angular and TypeScript, 4 years.'],
    ['Kamrul Islam', 'React Developer (sample)', 'React, Redux, TypeScript, Jest. 3 years.'],
    ['Maliha Chowdhury', 'Software Engineer (sample)', 'React and Next.js, TypeScript, Cypress. 4 years.'],
    ['Nafis Rahman', 'Frontend Lead (sample)', 'React, TypeScript, Next.js, Jest, mentoring. 8 years.'],
  ];
  const slice = page === 1 ? people.slice(0, 10) : page === 2 ? people.slice(10) : [];
  return slice.map(([name, headline, snippet]) => ({
    title: `${name} - ${headline} | LinkedIn`,
    link: `https://example.com/sample-profile/${name!.toLowerCase().replace(/\s+/g, '-')}`,
    snippet: `Sample profile (not a real person). ${snippet}`,
  }));
}
