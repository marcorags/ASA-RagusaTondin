# Challenge 1 PDDL: Logical_Cassandra

This live campaign verifies Logical_Cassandra on the eight official Challenge 1
scenarios. It records observable planner behaviour and compares the resulting
summary with the committed Cassandra baseline without modifying that baseline.

From the repository root, configure the external official resources and run:

```powershell
$env:DELIVEROO_BACKEND_DIR = 'path-to-deliveroo-backend'
$env:DELIVEROO_GAMES_DIR = 'path-to-deliveroo-game-assets'
powershell -NoProfile -ExecutionPolicy Bypass -File .\validation\challenge1-pddl\run-logical-cassandra.ps1
```

`DELIVEROO_BACKEND_DIR` must contain the official backend and
`DELIVEROO_GAMES_DIR` the official `26c1_X.json` files. The PDDL agent also uses
the solver configuration documented in the repository-root `.env.example`.
The harness starts fresh servers on port 8080 and reads the immutable baseline at
`../challenge1/results/summary.csv` when producing a generated comparison.

Committed canonical evidence is in `results/summary.csv` and
`results/summary.json`. New live runs are written to `generated/` by default.
Raw logs, diagnostics, instrumented builds, and historical campaigns are
intentionally excluded from this submission repository.
