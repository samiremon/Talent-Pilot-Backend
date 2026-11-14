# TalentPilot Architecture

This document explains how TalentPilot works inside and why it was built this way. To run the project, see [README.md](README.md).

**Contents**

1. [Overview](#1-overview)
2. [Services](#2-services)
3. [The hiring flow](#3-the-hiring-flow)
4. [The AI agent](#4-the-ai-agent)
5. [Background jobs](#5-background-jobs)
6. [Live updates](#6-live-updates)
7. [Candidate pipeline](#7-candidate-pipeline)
8. [Outreach, replies and meetings](#8-outreach-replies-and-meetings)
9. [Data model](#9-data-model)
10. [Code layout](#10-code-layout)
11. [Why Groq and LangGraph](#11-why-groq-and-langgraph)
12. [Done, mocked and skipped](#12-done-mocked-and-skipped)
13. [Trade-offs](#13-trade-offs)
14. [Security](#14-security)

---

## 1. Overview

```
                         ┌───────────────────────────── Docker network ─────────────────────────────┐
  Browser ──► web ───────┼──► api (Express) ──────► MongoDB      (jobs, candidates, activity, ...)    │
  :8080      (nginx:     │      │   ▲                                                                 │
             app + /api) │      │   │ task progress (Redis pub/sub)                                   │
                         │      ▼   │                                                                 │
                         │     Redis (BullMQ queue) ◄──► worker (scoring, search, email, replies)     │
                         │                                   │                                        │
                         │                                   └──► Mailpit (sandbox inbox) :8025       │
                         └──────────────────────────────────────────────────────────────────────────┘
                                api and worker call:  Groq (AI models)   Serper (web search)
```

- The **web** container serves the React app and forwards `/api/*` to the API. The browser talks to a single address, so the login cookie works without CORS.
- The **api** handles every request. Anything slow (AI scoring, web search, sending email, reading replies) is put on a queue.
- The **worker** takes jobs from the queue, runs them and reports progress. The API passes that progress to the browser live.

## 2. Services

| Service | Image | Role |
|---|---|---|
| `web` | `Talent-Pilot-Frontend/Dockerfile` (nginx, unprivileged) | The React app, security headers, `/api` proxy |
| `api` | `Talent-Pilot-Backend/Dockerfile` (Node 22) | REST API, chat agent, live events |
| `worker` | same image as `api`, runs `dist/worker.js` | Background jobs from the queue |
| `mongo` | `mongo:7.0` | Main database |
| `redis` | `redis:7.4-alpine` | BullMQ job queue and progress messages between worker and API |
| `mailpit` | `axllent/mailpit` | Catches every email the app sends (sandbox) |

Every service has a health check, and each one starts only after the services it depends on are healthy.

## 3. The hiring flow

```
Job description ─► Job ─► Sourcing ─► Review ─► Outreach ─► Replies ─► Meeting ─► Interview ─► Shortlist ─► Hired
   (chat or form)   (CSV, web    (accept /  (campaign:  (AI reads,  (booking
                     search,      not        Day 0/3/7)  drafts an   link,
                     one by one)  accepted)              answer)     calendar)
```

Every step can be done in two ways, with the same result:

- **By hand in the UI:** buttons, forms, the pipeline board.
- **Through the AI chat:** "accept the top 5", "email Sara a rejection".

Both paths call the **same service functions**, and every change is written to the **activity log**. The AI reads that log, so it knows what a recruiter did by hand.

## 4. The AI agent

### The agent loop

The chat agent (`src/chat/agent.ts`) is a small **LangGraph** graph:

```
START ─► agent (Groq model) ──wants a tool?──► tools ─► agent ─► ... ─► END
```

With every message the model receives:

1. **The rules:** a short system prompt covering scope, approve-before-acting, never inventing facts, and treating data as data rather than instructions.
2. **The workspace context:** a summary of the jobs plus the latest activity-log lines, with who did what. It is capped at about 3,000 characters (`src/assistant/context.ts`).
3. **The recent conversation.**

### Tools

| Kind | Tools | What happens |
|---|---|---|
| **Read** | `find_candidate`, `list_job_candidates`, `list_candidate_emails`, `get_hiring_stats`, `show_calendar` | Look things up in the database and answer. |
| **Propose** | `propose_job_from_description`, `propose_job_edit`, `propose_job_delete`, `propose_add_candidate`, `propose_candidate_contact_edit`, `propose_candidate_delete`, `propose_delete_all_candidates`, `propose_find_candidates`, `propose_score_candidates`, `propose_status_change`, `propose_campaign`, `propose_approve_campaign`, `propose_email`, `propose_simulate_reply`, `propose_send_reply` | Change **nothing**. They save a *pending action* and show a card in the chat. |

### Approve before acting

A propose tool only creates a `PendingAction`, shown as a card with **Confirm** and **Cancel**. The action runs only when the recruiter presses Confirm (`src/chat/actions.ts`). Each card is claimed in one database step, so it can never run twice, even with a double click.

### Never inventing facts

- Scores must quote evidence that **appears word for word** in the candidate's text. Quotes that don't match are dropped.
- A candidate with no profile text gets no score, not a guessed one.
- Emails and answers are written only from the job's facts and the recruiter's notes. A question the job description doesn't answer (salary, for example) gets "I'll check and get back to you".
- Lists of candidates and emails come straight from the database, not from the model's memory.

### Untrusted text

Job descriptions, CSV files, web search results and candidate replies all come from outside. They are passed to the model as data, the prompts say never to follow instructions inside them, and answers must match a fixed schema. A reply that tries to instruct the AI ("ignore your rules…") is **flagged** and is never sent automatically.

### Token budget

Groq's free plan limits tokens per minute. Before each call the app estimates the tokens it needs and compares them with what Groq reported as left (`src/ai/budget.ts`):

- If the call fits, it runs.
- If it fits after a short wait (up to 25 s), it waits.
- Otherwise it says how long to wait.

Every call's token use is recorded and shown on **Activity → Token usage**.

### Models

| Role | Default model | Used for |
|---|---|---|
| `agent` | `openai/gpt-oss-120b` | The chat, reading job descriptions |
| `bulk` | `openai/gpt-oss-20b` | Scoring candidates in batches, drafting emails, classifying replies |

Both models run with temperature 0 for steady, repeatable answers. With no `GROQ_API_KEY`, every AI task uses a built-in **mock** answer, so the whole app and its tests run without a key.

## 5. Background jobs

Slow work runs on a **BullMQ** queue in Redis and is processed by the **worker** container (`src/tasks/`).

| Task type | What it does |
|---|---|
| `score_candidates` | Scores unscored candidates, 10 per AI call. A failing batch is split up, so one bad profile doesn't stop the rest. |
| `source_candidates` | Searches the web (Serper), adds new people and skips duplicates, then queues scoring |
| `draft_outreach` | Writes a personal email for each candidate and step (Day 0, 3, 7) |
| `send_outreach` | Sends approved emails when they are due, within the daily limit, then reschedules itself for the next follow-up |
| `process_reply` | Classifies a reply, moves the status, stops follow-ups, drafts an answer (with a booking link if they're interested) |

- **Retries:** 3 attempts, waiting 5 s and then 10 s.
- **Progress:** each task is stored as a `Task` document (queued → running → done or failed, with messages like "Scored 15 of 23"). Progress is also published on Redis so the API can stream it.
- **No double sends:** an email is *claimed* (approved → sending) in one database operation before it is sent, so it can never go out twice.
- **Tests:** an *inline* queue runs the same processors in the test process, with the same rules.

## 6. Live updates

- **Task progress:** the worker publishes updates on Redis, and the API streams them to the browser over **Server-Sent Events** (`GET /jobs/events`). Each browser tab keeps a single connection and closes it while the tab is hidden.
- **Chat and notifications:** polled every 20 s, instantly after any change in the app, and when the tab becomes visible again. A candidate's reply shows up in the chat, the bell and the Replies tab.

## 7. Candidate pipeline

```
Sourced ─► Accepted ─► Contacted ─► Replied ─► Interested ─► Meeting booked ─► Interviewed ─► Shortlisted ─► Hired
   │           │                       │            ▲
   └► Not accepted (review)            └► Not interested
Unsubscribed: any time after Contacted          Rejected: any time before Hired, can be restored
```

- The rules live in one place (`src/pipeline/status.ts`). A blocked move explains itself, for example: "Can't mark Rahim as Hired yet: they're Contacted. First they need to be: Replied → Meeting booked → Interviewed → Shortlisted."
- Every change is written to the activity log, with who made it (recruiter, AI or system), and can be undone.
- **Restore** puts a rejected candidate back to the status they had before.
- **Not accepted** is the review decision; the brief calls it "Rejected" at the review step. **Rejected** is a separate status that can be used at any stage.

## 8. Outreach, replies and meetings

### Outreach

- A campaign is a single email or a sequence (Day 0, Day 3, Day 7).
- Drafts are written by the AI and edited and approved by the recruiter. Nothing is sent before approval.
- Only Accepted candidates with an email address are included.
- There is a daily limit across all jobs. Follow-ups stop as soon as a candidate replies, unsubscribes or is rejected.

### Unsubscribe

- Every email carries the standard `List-Unsubscribe` headers, so mail apps show an **Unsubscribe** button.
- The link is personal. Opening it changes nothing; confirming it marks the candidate *do not email* everywhere.

### One-off emails

You can email a single candidate (a rejection, an update, anything else) from the candidate popup or the chat. The AI drafts the email, and you edit it and send it. These emails appear in the conversation and the timeline, and the candidate can reply to them.

### Replies

1. A reply arrives (simulated; see [section 12](#12-done-mocked-and-skipped)).
2. The `process_reply` task labels it: *interested*, *not interested*, *question*, *wants a meeting* or *unsubscribe*.
3. It moves the status along the allowed path, stops the follow-ups and drafts an answer.
4. The answer waits for approval, unless `REPLY_AUTO_SEND` is on. Questions and flagged replies always wait.
5. The recruiter gets a notification (the bell) and a chat message with an **Answer** card.

### Meetings

- An interested candidate's answer includes a personal **booking link** (`/book/:token`).
- The booking page shows the **free hours** of the team calendar: Sunday to Thursday, 9 AM to 6 PM Dhaka time, 1-hour slots, for the next two weeks, with at least 2 hours' notice.
- On the **Calendar** page, recruiters mark hours **Busy**, and candidates never see those hours.
- An hour can be booked only once. This is checked when the candidate clicks, and a unique database index stops two people booking the same hour at the same moment.
- Booking makes the candidate **Meeting booked** and notifies the recruiter.

### Dashboard

The funnel is **cumulative**: it counts how many candidates *ever reached* each stage, using both their current status and their status history. A rejection doesn't erase the steps a candidate already passed. Reply rate is replied ÷ contacted; interested rate is interested ÷ replied. The Dashboard and the AI's `get_hiring_stats` use the same code, so they always agree.

## 9. Data model

MongoDB collections (Mongoose models in `src/models/`):

| Model | Holds |
|---|---|
| `User`, `Session`, `PasswordReset` | Accounts, logins (only token hashes are stored), password resets |
| `Job`, `Counter` | Jobs and their readable ids (`JOB-0007`) |
| `Candidate` | Profile, score, reason, evidence, status, email, *do not email* flag |
| `Activity` | The history log: every change, with who did it; also used for undo |
| `Task` | Background job progress |
| `ChatMessage`, `PendingAction` | Each recruiter's chat and the cards waiting for Confirm |
| `Campaign`, `OutreachMessage` | Outreach campaigns and each email (step, status, send time) |
| `DirectEmail` | One-off emails to a single candidate |
| `Reply`, `Meeting` | Candidate replies with the AI's reading and answer; booking links and booked calls |
| `BusySlot` | Hours blocked on the team calendar |
| `Notification` | The bell |
| `AiUsage` | Tokens used by every AI call |

## 10. Code layout

```
src/
├── server.ts, worker.ts   entry points: API process and worker process
├── app.ts                 Express app: middleware and routes
├── config.ts              all settings, checked at startup (zod)
├── ai/                    Groq client, mock mode, token budget, usage
├── assistant/             workspace context given to the AI
├── chat/                  agent (LangGraph), tools, approve-before-acting
├── jobs/  candidates/     jobs, candidates, status changes, timeline, one-off email
├── pipeline/              status rules
├── sourcing/              CSV import, web search, scoring
├── outreach/              campaigns, drafting, sending, unsubscribe
├── replies/               replies, answers, booking page
├── calendar/              meeting hours, free slots, Calendar API
├── stats/                 dashboard numbers
├── tasks/                 queue, worker processors, live events
├── notifications/         the bell
├── auth/                  login, sessions, sign-up, Google
└── models/                Mongoose schemas
test/                      vitest + in-memory MongoDB + mock AI
```

The frontend is described in [Talent-Pilot-Frontend/ARCHITECTURE.md](https://github.com/samiremon/Talent-Pilot-Frontend/blob/main/ARCHITECTURE.md).

## 11. Why Groq and LangGraph

**Groq**

- It has a **free plan with fast responses**, which suits a chat that should feel instant.
- It hosts open-weight `gpt-oss` models that are good at tool calling and structured JSON output.
- Two model sizes let the app spend tokens wisely: the large model for conversation and judgement, the small one for bulk work (scoring, drafting, classifying).

**LangGraph**

- It gives a clear, testable agent loop (model ⇄ tools) without hiding the control flow.
- The graph ends right after a *propose* tool, so the reply is built from the cards actually created, not from what the model claims it did.

**A single agent, not several**

- The tasks are short and connected, and they share one context.
- One agent with well-described tools is simpler, cheaper on tokens and easier to make reliable than several agents passing work between them.

## 12. Done, mocked and skipped

**Done**

- The full flow from job description to hire, in both the UI and the chat.
- Approve-before-acting for every change.
- Background jobs with progress and retries.
- Live updates.
- Outreach sequences with a daily limit and unsubscribe.
- AI reply handling, the booking calendar and the dashboard.
- Accounts with email verification and Google login.
- 230+ automated tests.

**Mocked**

- **Incoming email:** replies are simulated with **Simulate reply** or `POST /jobs/:id/candidates/:cid/simulate-reply`. A real inbox (IMAP or an inbound-mail webhook) would create the same `Reply` record.
- **Sending:** in `sandbox` mode (the default) every email goes to Mailpit. `live` mode sends real email through SMTP.
- **Calendar:** a built-in time-slot picker and team calendar instead of Calendly or Google Calendar.
- **Web search without a key:** with no `SERPER_API_KEY`, sourcing returns clearly labelled sample profiles.
- **AI without a key:** with no `GROQ_API_KEY`, the AI returns fixed mock answers.

**Skipped**

- **Scraping profile pages:** only Google search results (title, link, snippet) are used, and no emails come from web search.
- **Job boards behind a login, such as BDJobs:** CSV upload covers them.
- **Per-recruiter calendars and time zones:** there is one team calendar, in Dhaka time.

## 13. Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| Polling (20 s) for chat and notifications; SSE only for task progress | Simple and reliable behind any proxy | A new reply can take up to 20 s to appear if nothing else triggers a refresh |
| Score 10 candidates per AI call | Far fewer requests and tokens on the free plan | One bad profile can fail a batch. Handled by splitting the batch and retrying. |
| A small workspace context plus tools | Fits the free token limit | The AI must call a tool for details, which is one extra step |
| Cumulative funnel from the activity log | Correct numbers after rejections and undos | More work per request than counting current statuses |
| Links use `APP_URL` | Works on localhost | Booking and unsubscribe links only work outside your machine when `APP_URL` is a public address |
| Free AI plan | Costs nothing | Per-minute token limits, so sometimes the app asks you to wait a moment |

## 14. Security

- **Containers:** they run as non-root users with read-only file systems and `no-new-privileges`. MongoDB and Redis need passwords and are not reachable from outside Docker.
- **Passwords and sessions:** passwords are stored as scrypt hashes. The session cookie is `HttpOnly` and `SameSite=Strict`, and the database keeps only a SHA-256 hash of the session token.
- **Rate limits:** login, sign-up and password reset are rate-limited.
- **Web container:** nginx sends security headers, including CSP and X-Frame-Options.
- **Settings:** they are validated at startup, and the server refuses to start with invalid ones.
- **Secrets:** they live only in `.env`, which is never committed.
