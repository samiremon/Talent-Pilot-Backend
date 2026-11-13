# TalentPilot Backend

API server for **TalentPilot**, a chat-first AI recruiting co-worker.

## Run everything with Docker (recommended)

This repo's `docker-compose.yml` starts the **whole project**: website, API, MongoDB, Redis and a Mailpit email inbox.

```bash
# 1. Clone both repos side by side
git clone https://github.com/samiremon/Talent-Pilot-Backend.git
git clone https://github.com/samiremon/Talent-Pilot-Frontend.git

# 2. Create your settings and set the passwords
cd Talent-Pilot-Backend
cp .env.example .env

# 3. Start
docker compose up --build
```

| What | Where |
|---|---|
| Website | <http://localhost:8080> |
| API | <http://localhost:4000/health> (also via the website at `/api`) |
| Email inbox (Mailpit) | <http://localhost:8025> |

**Log in** with the recruiter account from your `.env`
(default `recruiter@example.com` / `change-me-recruiter`). It's created automatically on first start.

Stop with `docker compose down`. Add `-v` to also delete the database data.

**Built-in safety:** containers run as non-root users with read-only file systems and
`no-new-privileges`. MongoDB and Redis are password-protected and not reachable from
outside Docker. Every service has a health check, and the app waits until its
dependencies are healthy before starting.

## Run locally without Docker

```bash
cp .env.example .env        # set the passwords; MONGODB_URI must use the same Mongo password
npm install
docker compose up -d mongo  # MongoDB, reachable only from this machine (127.0.0.1:27017)
npm run dev
```

Check it works: <http://localhost:4000/health> should show `"database":"up"`.
The server refuses to start if a setting is invalid or MongoDB can't be reached.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server with auto-reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Check types |
| `npm test` | Run tests |
| `npm run seed` | Create the recruiter account, or reset its password to the one in `.env` |

## Login, in short

- One recruiter account, created from `SEED_RECRUITER_*` in `.env` on first start.
- Passwords are stored as **scrypt hashes**, never in plain text.
- Logging in sets an `HttpOnly`, `SameSite=Strict` cookie holding a random session token.
  The database keeps only a SHA-256 hash of that token, and logout deletes it at once.
- Login attempts are limited to 10 failures per IP per 15 minutes.
- Endpoints: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- **Demo button:** with `DEMO_LOGIN_ENABLED=true` (the default in `.env.example`), the login page
  shows a "Use demo account" button that fills in the recruiter's email and password from `.env`,
  served by `GET /auth/demo`. Anyone who can open the site can then log in, so set it to
  `false` for real use; the endpoint then returns 404 and the button disappears.

## Accounts

- **Sign up** with name, email and password. The email is checked for format **and** that its
  domain really exists and accepts mail (`rahim@gmial.com` → "Did you mean gmail.com?").
- **Email verification:** a new account only works after entering the **6-digit code** emailed to
  it (15 minutes, max 5 tries, "Send a new code" available). Made-up addresses never get the code,
  and unverified sign-ups delete themselves after 24 hours. Google accounts are verified by Google.
- **Forgot password** emails a one-time link (valid 30 minutes). In the demo, emails land in
  **Mailpit**: <http://localhost:8025>. Set `SMTP_*` in `.env` to send real email.
- **Profile** (account menu → Profile): change your name or password. Changing the password
  logs you out on your other devices.
- All recruiters share one team workspace; each has a private chat. Every action and every AI
  call is recorded with the person's name (sidebar → **Activity**: activity log, token usage,
  token dashboard).

### Turning on "Continue with Google" (optional, ~3 minutes)

1. Open <https://console.cloud.google.com/apis/credentials> (create a project if asked).
2. If asked, set up the **OAuth consent screen**: External, app name "TalentPilot", your email;
   add yourself as a test user.
3. **Create credentials → OAuth client ID → Web application**, and add these
   **Authorized redirect URIs**:
   - `http://localhost:8080/api/auth/google/callback` (Docker)
   - `http://localhost:5173/api/auth/google/callback` (`npm run dev`)
4. Copy the client ID and secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
5. Restart (`docker compose up -d api`). The **Continue with Google** button appears on the
   login and sign-up pages.

