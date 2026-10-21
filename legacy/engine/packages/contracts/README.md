# packages/contracts

The single source of truth for every boundary in Maistro. Nothing calls an
upstream tool, defines a campaign entity, or publishes to a platform except
through types generated from the files in this package.

```
openapi/
  trend-radar.yaml   # kymah.com /api/agent/* (read-only; ADR D9)
  f1x8.yaml          # image sync + video async analysis
  sentiment.yaml     # corpus + apify trigger (dashboard/data deliberately excluded)
  lenceus.yaml       # sites + log (POST /api/run deliberately excluded)
schemas/
  campaign.json          # Maistro-owned entities (JSON Schema 2020-12)
  brief.json             # creator working document (finalize with creator, M1-W3)
  content-version.json
  learning.json
  approval.json
  publish-request.json   # idempotency_key is contractual (ADR D8)
  publish-result.json
  problem.json           # RFC 9457 + retryable extension
generated/               # codegen output — never hand-edited (CI drift check)
```

All shapes in `openapi/` were **extracted from the four codebases on
2026-09-04**, not guessed. If a contract test disagrees with one of these
files, first determine which side changed.

## Rules (enforced by CI)

1. **Spec first.** Change the YAML/JSON here, run codegen, then fix what the
   compiler surfaces. PRs that edit `generated/` directly are rejected
   (drift check re-runs codegen and diffs).
2. **Tolerant reader.** Consumers ignore unknown fields (`additionalProperties: true`
   on upstream shapes is deliberate). Producers never repurpose a field.
3. **Versioning.** Semver in each spec's `info.version` / `$comment`.
   Additive = minor. Breaking = major + migration note + consumer sign-off.
   Maistro-owned MCP/Brief shapes are **append-only** once the creator is
   onboarded (M2).
4. **null ≠ 0.** Trend Radar and Lenceus use `null` for *not measured*.
   Generated types keep these `Optional`; adapters must never coalesce to 0.

## Codegen

Python models (Pydantic v2) via [datamodel-code-generator](https://github.com/koxudaxi/datamodel-code-generator):

```bash
pip install "datamodel-code-generator[http]"

# OpenAPI -> adapter models
datamodel-codegen --input openapi/trend-radar.yaml --input-file-type openapi \
  --output generated/python/trend_radar_models.py --output-model-type pydantic_v2.BaseModel \
  --use-annotated --target-python-version 3.12
# (repeat for f1x8.yaml, sentiment.yaml, lenceus.yaml)

# JSON Schema -> entity models
datamodel-codegen --input schemas/ --input-file-type jsonschema \
  --output generated/python/entities.py --output-model-type pydantic_v2.BaseModel \
  --use-annotated --target-python-version 3.12
```

TypeScript types (for the M5 dashboard) via
[openapi-typescript](https://github.com/openapi-ts/openapi-typescript) +
[json-schema-to-typescript](https://github.com/bcherny/json-schema-to-typescript):

```bash
npx openapi-typescript openapi/maistro-api.yaml -o generated/ts/maistro-api.d.ts
npx json-schema-to-typescript -i schemas/ -o generated/ts/entities/
```

A `make codegen` / `codegen.ps1` wrapper lands with the service scaffold
(M1-W2); until then run the commands above from this directory.

## Contract tests

`services/core/tests/contract/` (M1-W4) calls each **staging** endpoint and
validates the live response against these specs (nightly CI). A failure means
one side drifted — the test output names the endpoint, field, and spec file.

## Deliberate exclusions

| Excluded | Why |
|---|---|
| SamsungSentiment `/api/dashboard/data` | Regex-based sentiment path — weaker signal than the LLM-scored corpus on `/api/comments`. |
| Lenceus `POST /api/run` | Lenceus runs on its own daily schedule; Maistro is read-only there. |
| Trend Radar collection/pipeline routes | ADR D9 — Maistro never triggers collection (spend governance). |
| TR `POST /api/mcp` | Available (JSON-RPC MCP server, same auth) but Maistro's adapters use REST; the creator may connect to it directly. |
