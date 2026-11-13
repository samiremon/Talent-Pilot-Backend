/**
 * Finding candidates on the web with Serper (a Google Search API, https://serper.dev).
 *
 * Sources (each checked against real Google results before adding it):
 *   LinkedIn        linkedin.com/in/<name>          every kind of role
 *   GitHub          github.com/<username>            developers (repositories are skipped)
 *   Stack Overflow  stackoverflow.com/users/<id>/…   developers (bio + city in the snippet)
 *   Kaggle          kaggle.com/<username>            data / ML (datasets etc. are skipped)
 * Considered but left out: Hugging Face (Google returns models and papers, not people),
 * BDJobs (CVs are behind a paid employer login; job ads only), personal sites (no reliable
 * way to tell a person from a page).
 *
 * How it works:
 *   1. suggestSearches(job) makes one Google query per source from the job's fields,
 *      WITHOUT the AI (no tokens), including the job's seniority, e.g.
 *        site:linkedin.com/in "React" "TypeScript" "Next.js" Developer Frontend
 *          ("Senior" OR "Lead" OR "Sr") -intern -junior -trainee Dhaka
 *      and picks the sources that fit the job title (developer -> GitHub + Stack Overflow,
 *      data/AI -> GitHub + Kaggle; LinkedIn always). The recruiter can edit all of it.
 *   2. search(query, page) asks Serper for one page of results (up to 10 = 1 credit).
 *      Each result is { title, link, snippet }: what Google shows in its result list.
 *   3. resultToCandidate() turns a result into a candidate, or skips it if it isn't a
 *      person's profile page:
 *        title   "Sara Ahmed - Senior Frontend Engineer - bKash | LinkedIn"
 *                -> name "Sara Ahmed", headline "Senior Frontend Engineer · bKash"
 *        link    -> profile link (also how duplicates are detected)
 *        snippet -> the text the AI scores
 *
 * We only use what Google shows publicly in search results: we never open or scrape the
 * profile pages themselves. Snippets are short, so scores rely on less information than
 * a full CV. No emails: search results don't contain them (a profile link is enough).
 *
 * Snippets are untrusted text from the internet: the scoring step's prompt-injection guard
 * (and the red "flagged" rows) apply to them like to any other profile.
 *
 * Without SERPER_API_KEY: SAMPLE mode. Made-up profiles, clearly marked "(sample)", so the
 * whole flow can be tried without signing up. Never mixed with real results.
 */
import { AppError } from '../errors.js';
import { jobLevel } from './seniority.js';
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

export const SEARCH_SOURCES = ['linkedin', 'github', 'stackoverflow', 'kaggle'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];
export const SOURCE_LABELS: Record<SearchSource, string> = {
  linkedin: 'LinkedIn',
  github: 'GitHub',
  stackoverflow: 'Stack Overflow',
  kaggle: 'Kaggle',
};

interface JobForSearch {
  title: string;
  seniority?: string | null;
  mustHaveSkills?: string[] | null;
  location?: string | null;
}

/**
 * Seniority words for the query (same rule as scoring: more senior is fine, less is not):
 *   - LinkedIn titles say the level, so for a senior/lead job we ASK for it:
 *       ("Senior" OR "Lead" OR "Sr")       and leave out  -intern -junior -trainee
 *   - GitHub / Stack Overflow / Kaggle bios rarely say it, so there we only leave out the
 *     clearly too-junior ones (-intern -student) instead of requiring a word.
 *   - Junior / intern jobs: no filter (seniors are welcome too).
 */
function levelTerms(job: JobForSearch, source: SearchSource): string[] {
  const level = jobLevel(job);
  if (level === 'senior' || level === 'lead') {
    if (source !== 'linkedin') return ['-intern', '-student'];
    const want = level === 'lead' ? '("Lead" OR "Principal" OR "Staff" OR "Head")' : '("Senior" OR "Lead" OR "Sr")';
    return [want, '-intern', '-junior', '-trainee'];
  }
  if (level === 'mid') return source === 'linkedin' ? ['-intern', '-trainee'] : ['-intern'];
  return [];
}

const quoted = (skills: string[]) => skills.map((s) => `"${s.replace(/"/g, '')}"`);
const plainLocation = (job: JobForSearch) => (job.location ?? '').replace(/[",()]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The Google query for one source, made from the job's fields (no AI, no tokens).
 * - LinkedIn: up to 3 must-have skills in quotes (must appear) + the role from the title
 *   without level words ("Senior React Developer (Frontend)" -> "React Developer Frontend")
 *   + the location. Profiles there say what people do, so the role helps.
 * - GitHub / Stack Overflow / Kaggle: 2 skills + the location (people rarely write job
 *   titles there, so the role would hide good matches).
 * The location is NOT quoted: a quoted city also matches people with that surname.
 */
export function buildSearchQuery(job: JobForSearch, source: SearchSource = 'linkedin'): string {
  const location = plainLocation(job);
  if (source === 'linkedin') {
    const skills = quoted((job.mustHaveSkills ?? []).slice(0, 3));
    const role = job.title
      .replace(/[()[\]]/g, ' ')
      .replace(LEVEL_WORDS, ' ')
      .split(/\s+/)
      // Words already in a quoted skill add nothing.
      .filter((w) => w && !skills.some((s) => s.toLowerCase() === `"${w.toLowerCase()}"`))
      .join(' ');
    return ['site:linkedin.com/in', ...skills, role, ...levelTerms(job, source), location].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  const skills = quoted((job.mustHaveSkills ?? []).slice(0, 2));
  // No skills listed: fall back to the role words.
  const role = skills.length ? '' : job.title.replace(/[()[\]]/g, ' ').replace(LEVEL_WORDS, ' ');
  const site = { github: 'site:github.com', stackoverflow: 'site:stackoverflow.com/users', kaggle: 'site:kaggle.com' }[source];
  return [site, ...skills, role, ...levelTerms(job, source), location].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Which sources fit the job, from its title: LinkedIn always, plus the specialist sites. */
export function suggestedSources(title: string): SearchSource[] {
  const t = title.toLowerCase();
  if (/\b(ai|ml|machine learning|data|deep learning|nlp|llm|analytics?)\b/.test(t)) return ['linkedin', 'github', 'kaggle'];
  if (/\b(developer|engineer|programmer|frontend|front-end|backend|back-end|full[- ]?stack|software|devops|mobile|web)\b/.test(t)) {
    return ['linkedin', 'github', 'stackoverflow'];
  }
  return ['linkedin'];
}

/** All sources with their suggested query, and whether each is suggested for this job. */
export function suggestSearches(job: JobForSearch) {
  const suggested = suggestedSources(job.title);
  return SEARCH_SOURCES.map((source) => ({
    source,
    label: SOURCE_LABELS[source],
    query: buildSearchQuery(job, source),
    suggested: suggested.includes(source),
  }));
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

/** GitHub / Kaggle paths that are NOT a person (site pages, datasets, ...). */
const GITHUB_RESERVED = new Set(['orgs', 'topics', 'features', 'about', 'pricing', 'marketplace', 'sponsors', 'collections', 'events', 'trending', 'search', 'enterprise', 'login', 'join', 'settings', 'apps', 'site', 'security', 'customer-stories', 'readme', 'explore']);
const KAGGLE_RESERVED = new Set(['datasets', 'competitions', 'code', 'discussions', 'discussion', 'models', 'learn', 'docs', 'c', 'search', 'organizations', 'benchmarks', 'notebooks', 'rankings', 'kernels', 'general', 'product-feedback', 'getting-started']);

/** A person's name from a title part: letters only, 2-60 characters, not a "jobs"/"top 10" page. */
function cleanName(text: string | undefined): string | null {
  const name = (text ?? '').replace(/[^\p{L}\p{M}\s.'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60 || /\b(jobs?|hiring|profiles?|people|top \d+|user)\b/i.test(name)) return null;
  return name;
}

/**
 * Which site a link is on, and its canonical profile link, if it's a PERSON's profile page.
 * Shapes taken from real Google results (see the comment at the top).
 */
function profileOf(link: string): { site: SearchSource | 'sample'; url: string; user?: string } | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  // LinkedIn: /in/<name>, on any country subdomain (bd., uk., ...).
  if (/(^|\.)linkedin\.com$/.test(host)) return parts[0] === 'in' && parts[1] ? { site: 'linkedin', url: `https://www.linkedin.com/in/${parts[1]}` } : null;
  // GitHub: /<user>, or /<user>/<user> (the profile README repo). /<user>/<repo> is a project.
  if (host === 'github.com') {
    const user = parts[0];
    if (!user || GITHUB_RESERVED.has(user.toLowerCase())) return null;
    if (parts.length === 1 || (parts.length === 2 && parts[1]!.toLowerCase() === user.toLowerCase())) {
      return { site: 'github', url: `https://github.com/${user}`, user };
    }
    return null;
  }
  // Stack Overflow: /users/<id>/<name> or /users/<name> (also on meta.), not the "story" pages.
  if (host === 'stackoverflow.com' || host === 'meta.stackoverflow.com') {
    if (parts[0] !== 'users' || !parts[1] || parts[1] === 'story') return null;
    return { site: 'stackoverflow', url: `https://${host}/${parts.slice(0, 3).join('/')}` };
  }
  // Kaggle: /<user> (also /<user>/followers etc.), not datasets / competitions / ...
  if (host === 'kaggle.com' || host === 'www.kaggle.com') {
    const user = parts[0];
    if (!user || KAGGLE_RESERVED.has(user.toLowerCase())) return null;
    return { site: 'kaggle', url: `https://www.kaggle.com/${user}`, user };
  }
  if (host === 'example.com' && parts[0] === 'sample-profile') return { site: 'sample', url: `${url.origin}${url.pathname}` };
  return null;
}

/**
 * One search result -> a new candidate, or null if it isn't a person's profile.
 * Only uses what Google shows: never invents an email or anything else.
 */
export function resultToCandidate(result: SearchResult): NewCandidate | null {
  const profile = profileOf(result.link);
  if (!profile) return null;

  let name: string | null;
  let headline: string | null = null;
  if (profile.site === 'github') {
    // "Tahsin Zaman Tahsin0909" (name + username), "Md-Kais" (username only), or for a
    // profile README "Ujjal Kumar Roy - Full-Stack Software Engineer".
    const [first, ...rest] = titleParts(result.title.replace(/\s*·\s*GitHub.*$/i, ''));
    const withoutUser = (first ?? '').replace(new RegExp(`\\s*${profile.user!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
    name = cleanName(withoutUser) ?? cleanName(profile.user);
    headline = rest.join(' · ') || null;
  } else if (profile.site === 'stackoverflow') {
    // "User Mohammad Faisal" / "User Mushfiq - Meta Stack Overflow"
    name = cleanName(result.title.replace(/^User\s+/i, '').replace(/\s*-\s*(Meta\s+)?Stack Overflow.*$/i, ''));
  } else if (profile.site === 'kaggle') {
    // "Arif Miah" / "Arif Miah | Expert | Kaggle"
    const [first, ...rest] = titleParts(result.title.replace(/\s*\|\s*Kaggle\s*$/i, ''));
    name = cleanName(first);
    headline = rest.join(' · ') || null;
  } else {
    // LinkedIn (and sample): "Name - Role - Company | LinkedIn"
    const [first, ...rest] = titleParts(result.title);
    name = cleanName(first);
    headline = rest.join(' · ') || null;
  }
  if (!name) return null;
  headline = headline?.slice(0, 300) || null;

  const snippet = result.snippet.replace(/\s+/g, ' ').trim();
  return {
    name,
    email: null,
    profileUrl: profile.url,
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
