# Challenge 2: Loqua and Cassandra_T

This live campaign verifies Loqua's natural-language mission interpretation and
strategy adaptation, plus authenticated coordination with Cassandra_T for the
two Level 3 scenarios. It covers the nine official scenarios `26c2_1` through
`26c2_9`.

From the repository root, configure the external official resources and run:

```powershell
$env:DELIVEROO_BACKEND_DIR = 'path-to-deliveroo-backend'
$env:MISSION_AGENTS_DIR = 'path-to-official-missionAgents'
powershell -NoProfile -ExecutionPolicy Bypass -File .\validation\challenge2\run-challenge2.ps1
```

`DELIVEROO_BACKEND_DIR` must contain the official backend `index.js`.
`MISSION_AGENTS_DIR` must contain the official mission-agent scripts and its
`challenge2/26c2_X.json` configurations. The repository-root `.env` (or process
environment) must provide `LLM_API_KEY`; Level 3 also requires `TEAM_SECRET`.
`ADMIN_PASSWORD` is optional and is used only to obtain a local, non-persisted
admin token from the backend. The harness uses port 8080.

Committed canonical evidence is `results/summary.csv`. New live runs, including
preflight output, are written to `generated/` by default. Raw logs, diagnostics,
JSON summaries containing local paths, and historical campaigns are intentionally
excluded from this submission repository.
