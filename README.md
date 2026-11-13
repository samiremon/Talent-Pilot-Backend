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

Stop with `docker compose down`. Add `-v` to also delete the database data.

**Built-in safety:** containers run as non-root users with read-only file systems and
`no-new-privileges`. MongoDB and Redis are password-protected and not reachable from
outside Docker. Every service has a health check, and the app waits until its
dependencies are healthy before starting.

## Run locally without Docker

```bash
cp .env.example .env
npm install
npm run dev
```

Check it works: <http://localhost:4000/health>

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server with auto-reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Check types |
| `npm test` | Run tests |
