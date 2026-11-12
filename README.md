# TalentPilot Backend

API server for **TalentPilot**, a chat-first AI recruiting co-worker.
See [plan.md](plan.md) for the full project plan.

## Run locally

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
