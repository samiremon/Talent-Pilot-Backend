# TalentPilot

TalentPilot is a chat-first AI recruiting co-worker. You paste a job description, and it finds and scores candidates, sends outreach emails, reads the replies and books meetings. Nothing is created or sent without your approval.

This guide covers running the project. For how it works inside, see [ARCHITECTURE.md](ARCHITECTURE.md).

The project has two repositories:

| Repository | What it contains |
|---|---|
| [Talent-Pilot-Backend](https://github.com/samiremon/Talent-Pilot-Backend) | API, background worker, Docker setup. **You start everything from here.** |
| [Talent-Pilot-Frontend](https://github.com/samiremon/Talent-Pilot-Frontend) | The web app |

---

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/), or Docker Engine with the Compose plugin (`docker compose version` should work)
- [Git](https://git-scm.com/downloads)
- A free **Groq API key** (step 2)

Node.js is only needed if you want to run the project without Docker.

---

## 1. Download the code

Clone both repositories into the same folder:

```bash
git clone https://github.com/samiremon/Talent-Pilot-Backend.git
git clone https://github.com/samiremon/Talent-Pilot-Frontend.git
```

```
your-folder/
├── Talent-Pilot-Backend/
└── Talent-Pilot-Frontend/
```

## 2. Get a Groq API key

TalentPilot uses [Groq](https://groq.com) for its AI. The free plan is enough.

1. Sign up or log in at **<https://console.groq.com>**.
2. Open **API Keys**: **<https://console.groq.com/keys>**.
3. Click **Create API Key**, give it a name (for example `talentpilot`) and copy the key. It starts with `gsk_`.

Keep the key private. You will paste it into the `.env` file in the next step.

> Without a key the app still runs, in **mock mode**: the AI gives fixed sample answers instead of real ones.

## 3. Create your settings

```bash
cd Talent-Pilot-Backend
cp .env.example .env
```

Open `.env` in a text editor and set these values:

| Setting | What to put |
|---|---|
| `GROQ_API_KEY` | Your Groq key from step 2 |
| `MONGO_PASSWORD` | Any strong password for the database |
| `REDIS_PASSWORD` | Any strong password for Redis |
| `SEED_RECRUITER_EMAIL` | The email you will log in with |
| `SEED_RECRUITER_PASSWORD` | The password you will log in with |

Leave everything else as it is. The optional settings are explained [further down](#optional-settings).

## 4. Start the project

```bash
docker compose up --build -d
```

The first build takes a few minutes. When it finishes, check that every service is running:

```bash
docker compose ps
```

`api`, `web`, `mongo`, `redis` and `mailpit` should show **healthy**. `worker` shows **running**, because it has no health check.

## 5. Open the app

| What | Address |
|---|---|
| **TalentPilot** | <http://localhost:8080> |
| Email inbox (Mailpit) | <http://localhost:8025> |
| API health check | <http://localhost:4000/health> |

Log in with the `SEED_RECRUITER_EMAIL` and `SEED_RECRUITER_PASSWORD` you set in `.env`. The account is created on first start.

Every email the app sends lands in **Mailpit**, so nobody real is ever emailed by accident.

---

## Try it with the sample data

The `samples/` folder has a complete example for a **Software Engineer** role:

| File | Contents |
|---|---|
| `samples/software-engineer-job-description.md` | A full-stack Software Engineer job at a fictional Dhaka company |
| `samples/software-engineer-candidates.csv` | 16 fictional candidates, from strong matches to clear mismatches |

The CSV also includes three special cases, so you can see how the app handles them:

- **Kamal Uddin** has no email address, so he can't be added to an email campaign.
- **Ayon Das** has no profile text, so he gets no score instead of a guessed one.
- **Riyad Karim**'s profile tells the AI to give him a score of 100. The AI ignores it and flags him.

Walk through the whole flow:

1. **Create a job:** copy the text of `samples/software-engineer-job-description.md`, paste it into the chat on the right and press **Confirm** on the card.
2. **Add candidates:** on the job page, click **Upload CSV** and choose `samples/software-engineer-candidates.csv`. The candidates are scored automatically.
3. **Review:** accept the best candidates on the **Candidates** tab, or ask the chat: *"accept the top 5"*.
4. **Outreach:** on the **Emails** tab, create an email campaign, check the drafts and approve it. The emails appear in Mailpit.
5. **Replies:** on the **Replies** tab, use **Simulate reply** to answer as a candidate. The AI classifies the reply, updates the status and drafts an answer.
6. **Meetings:** an interested candidate's answer includes a booking link. Open it from Mailpit, pick a time, and the call appears on the **Calendar** page.
7. **Results:** the **Dashboard** shows the hiring funnel, reply rate, interested rate, meetings and hires.

---

## Optional settings

Set these in `.env`, then apply them with `docker compose up -d`.

| Setting | Default | What it does |
|---|---|---|
| `SERPER_API_KEY` | empty | Real web search for candidates (LinkedIn, GitHub, Stack Overflow, Kaggle) through Google. Free key at <https://serper.dev>. Empty means clearly labelled sample profiles. |
| `OUTREACH_DAY_SECONDS` | `86400` | Length of one "day" for follow-up emails (Day 3, Day 7). Set `60` for a quick demo. |
| `OUTREACH_DAILY_LIMIT` | `50` | Maximum outreach emails in any 24 hours. |
| `OUTREACH_MODE` | `sandbox` | `sandbox` sends all outreach to Mailpit. `live` sends real email through the `SMTP_*` settings. |
| `REPLY_AUTO_SEND` | `false` | `true` sends the AI's answers to replies without waiting for approval. Questions and suspicious replies always wait. |
| `DEMO_LOGIN_ENABLED` | `true` | Shows a **Use demo account** button on the login page. Set `false` for real use. |
| `ALLOW_SIGNUP` | `true` | Lets new recruiters create accounts (with email verification). |
| `SMTP_*`, `EMAIL_FROM` | Mailpit | Your email provider's SMTP details, for sending real email. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Turns on **Continue with Google** (see below). |
| `WEB_PORT`, `API_PORT`, `MAILPIT_UI_PORT` | `8080`, `4000`, `8025` | Change these if a port is already in use. |

### Continue with Google (optional)

1. Open <https://console.cloud.google.com/apis/credentials> and create a project if asked.
2. Set up the **OAuth consent screen** (External), and add yourself as a test user.
3. **Create credentials → OAuth client ID → Web application**, with these redirect URIs:
   - `http://localhost:8080/api/auth/google/callback`
   - `http://localhost:5173/api/auth/google/callback`
4. Put the client ID and secret into `.env`, then run `docker compose up -d`.

---

## Useful commands

| Task | Command |
|---|---|
| Watch the logs | `docker compose logs -f api worker` |
| Stop | `docker compose down` |
| Stop and delete all data | `docker compose down -v` |
| Update after pulling new code | `git pull` in both repositories, then `docker compose up --build -d` |
| Apply a changed login password | `docker compose exec api node dist/scripts/seed.js` |

---

## Run without Docker (for development)

Requires **Node.js 20 or newer**. MongoDB, Redis and Mailpit still run in Docker.

```bash
# Backend (in Talent-Pilot-Backend)
cp .env.example .env                       # use the same passwords in MONGODB_URI and REDIS_URL
docker compose up -d mongo redis mailpit
npm install
npm run dev                                # API on http://localhost:4000
npm run worker                             # in a second terminal: background jobs
```

```bash
# Frontend (in Talent-Pilot-Frontend)
cp .env.example .env
npm install
npm run dev                                # app on http://localhost:5173
```

## Tests

```bash
npm test
```

The tests use an in-memory database and a mock AI, so they need neither Docker nor an API key.

---

## Files used to run the project

| File | Purpose |
|---|---|
| `docker-compose.yml` | Starts the full stack: web, api, worker, mongo, redis, mailpit |
| `Dockerfile` | Builds the API image. The worker uses the same image. |
| `.env.example` | Every setting, with comments. Copy it to `.env`. |
| `../Talent-Pilot-Frontend/Dockerfile` | Builds the web app and serves it with nginx |
| `../Talent-Pilot-Frontend/nginx.conf` | Serves the app and forwards `/api` to the API |
| `samples/` | A sample job description and candidate CSV to try the app |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Set MONGO_PASSWORD in .env` | The `.env` file is missing. Run `cp .env.example .env`. |
| `port is already allocated` | Another program uses that port. Change `WEB_PORT`, `API_PORT` or `MAILPIT_UI_PORT` in `.env`. |
| The web build can't find the frontend | Clone `Talent-Pilot-Frontend` next to this folder, or set `FRONTEND_DIR` in `.env`. |
| Database login fails after changing `MONGO_PASSWORD` | The database keeps its first password. Run `docker compose down -v` (deletes the data), then start again. |
| Can't log in after changing the password in `.env` | Run `docker compose exec api node dist/scripts/seed.js` |
| The AI says to wait a moment | Groq's free plan allows a limited number of tokens per minute. Wait the time shown and try again. |
| The AI gives fixed sample answers | `GROQ_API_KEY` is empty. Add it and run `docker compose up -d`. |
