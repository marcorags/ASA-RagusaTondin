# Challenge 1: Cassandra

This live campaign verifies Cassandra's BDI delivery behaviour and strategy on the
eight official Challenge 1 scenarios (`26c1_1` through `26c1_8`). It is a
controlled runtime validation, not a replacement for deterministic tests.

From the repository root, configure the external official resources and run:

```powershell
$env:DELIVEROO_BACKEND_DIR = 'path-to-deliveroo-backend'
$env:DELIVEROO_GAMES_DIR = 'path-to-deliveroo-game-assets'
powershell -NoProfile -ExecutionPolicy Bypass -File .\validation\challenge1\run-challenge1.ps1
```

`DELIVEROO_BACKEND_DIR` must contain the official backend `index.js` and
`DELIVEROO_GAMES_DIR` must contain the official `26c1_X.json` game files. The
harness starts a fresh backend for each scenario and uses port 8080.

Committed canonical evidence is in `results/summary.csv` and
`results/summary.json`. New live runs are written to `generated/` by default;
choose another `-OutputDirName` if that directory already contains a run.
Raw logs, diagnostics, and historical campaigns are intentionally excluded from
this submission repository.
