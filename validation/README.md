# Validation

This directory contains deterministic-validation support, live challenge
harnesses, and compact canonical evidence. Raw logs, diagnostics, and historical
campaigns are intentionally excluded from the submitted repository.

| Campaign | Agents | Scenarios | Purpose | Canonical evidence |
|---|---|---:|---|---|
| Challenge 1 | Cassandra | 8 | BDI delivery behaviour and strategy | [CSV](challenge1/results/summary.csv), [JSON](challenge1/results/summary.json) |
| Challenge 1 PDDL | Logical_Cassandra | 8 | PDDL integration and baseline comparison | [CSV](challenge1-pddl/results/summary.csv), [JSON](challenge1-pddl/results/summary.json) |
| Challenge 2 | Loqua + Cassandra_T | 9 | Atomic requests, strategy adaptation, and coordination | [CSV](challenge2/results/summary.csv) |

## Deterministic versus live validation

`npm test` runs deterministic tests and needs neither a game server nor external
mission resources. The three challenge harnesses are optional live validation:
they start official Deliveroo infrastructure and may require an LLM provider.

| Campaign | External prerequisites |
|---|---|
| Challenge 1 | `DELIVEROO_BACKEND_DIR`, `DELIVEROO_GAMES_DIR` |
| Challenge 1 PDDL | `DELIVEROO_BACKEND_DIR`, `DELIVEROO_GAMES_DIR`; PDDL solver settings if using a non-default solver |
| Challenge 2 | `DELIVEROO_BACKEND_DIR`, `MISSION_AGENTS_DIR`, `LLM_API_KEY`; `TEAM_SECRET` for Level 3; optional `ADMIN_PASSWORD` |

See the campaign guides: [Challenge 1](challenge1/README.md),
[Challenge 1 PDDL](challenge1-pddl/README.md), and
[Challenge 2](challenge2/README.md).

`results/` contains curated evidence committed with the project. `generated/`
is the ignored destination for new local runs; it must not replace canonical
results.
