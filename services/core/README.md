# maistro-core

The Maistro core service: adapters, campaign state machine, REST API, and —
landing in M2 — the LangGraph engine, MCP server, and publisher.

## Quickstart

```powershell
cd services\core
pip install -e ".[dev]"
copy ..\..\.env.example .env      # fill in keys — see ..\..\SECRETS.md

uvicorn maistro.app:app --reload --port 8100
# GET http://localhost:8100/health
```

## Checks (all must be green before merge — mirrors CI)

```powershell
ruff check .        # lint
mypy                # strict typecheck (generated/ exempt, drift-checked instead)
pytest -q           # unit tests
python ..\..\packages\contracts\codegen.py --check   # contract drift
```

## Layout

```
src/maistro/
  config.py        # Settings (MAISTRO_* env vars)
  telemetry.py     # structured JSON logging; bind campaign_id via contextvars
  app.py           # FastAPI factory
  api/             # REST routes (approval queue + campaigns land in M2)
  adapters/        # typed clients for the four tools; boundary validation
  graph/           # state.py (CampaignState), transitions.py (state machine)
  generated/       # codegen output from packages/contracts — NEVER hand-edit
tests/             # unit tests; tests/contract/ (live staging) lands M1-W4
```

## Rules of the road

- **Never edit `generated/`** — change the spec in `packages/contracts/`,
  run `python packages/contracts/codegen.py`, fix what the compiler surfaces.
- **All upstream I/O goes through an adapter** (boundary validation is what
  keeps bad data out of checkpoints — ADR D6).
- **Status changes go through `graph.transitions.next_status`** — illegal
  transitions must raise, never be worked around.
- `null` from Trend Radar / Lenceus means *not measured* — never coalesce
  to 0.
