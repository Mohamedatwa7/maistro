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

## Watching the orchestration live

Three levels (see the answer they came from in docs/GRAPH.md):

1. **Static map** — [docs/GRAPH.md](../../docs/GRAPH.md), the mermaid render
   of the real compiled topology. Regenerate: `python scripts/draw_graph.py`.
2. **Live campaign state** — `GET /api/campaigns/{id}/state`: current
   status, the interrupt the graph is parked on (with its payload), legal
   next events, and the full graph state. Plus the per-campaign audit
   timeline on `GET /api/campaigns/{id}`.
3. **LangGraph Studio (visual step-through)** — from the repo root:
   `langgraph dev` (needs `pip install "langgraph-cli[inmem]"`). Opens
   Studio against the demo-deps harness (`graph/studio.py`) — watch state
   flow node-to-node, inspect checkpoints, resume interrupts by hand.
4. **LangSmith (production tracing)** — set `LANGSMITH_TRACING=true` +
   `LANGSMITH_API_KEY`; every graph run of the real app is then traced at
   smith.langchain.com (node timings, inputs/outputs, interrupt waits).

## Rules of the road

- **Never edit `generated/`** — change the spec in `packages/contracts/`,
  run `python packages/contracts/codegen.py`, fix what the compiler surfaces.
- **All upstream I/O goes through an adapter** (boundary validation is what
  keeps bad data out of checkpoints — ADR D6).
- **Status changes go through `graph.transitions.next_status`** — illegal
  transitions must raise, never be worked around.
- `null` from Trend Radar / Lenceus means *not measured* — never coalesce
  to 0.
