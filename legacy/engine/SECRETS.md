# Secrets inventory — NAMES ONLY, never values (ADR D12)

Storage: local `.env` (gitignored) · CI: GitHub Environments · prod: deploy
platform secret store. Rotation owner: Maistro operator. Update this file in
the same PR that introduces or retires a secret.

## Maistro core (`MAISTRO_*` env vars — see .env.example)

| Name | Purpose | Since |
|---|---|---|
| MAISTRO_DATABASE_URL | Maistro's dedicated Supabase Postgres | M1 |
| MAISTRO_TREND_RADAR_AGENT_KEY | TR /api/agent/* bearer key (issued from TR's AGENT_API_KEY) | M1 |
| MAISTRO_F1X8_API_KEY | F1X8 service key (enforcement lands M1-W3) | M1 |
| MAISTRO_SENTIMENT_BASE_URL / _API_KEY | SamsungSentiment deployment + service key (M1-W3) | M1 |
| MAISTRO_LENCEUS_BASE_URL / _API_KEY | Lenceus API + service key (M1-W3) | M1 |
| MAISTRO_OPERATOR_API_KEY | Operator/approver REST auth (X-Operator-Key) | M2 |

## Arriving later (placeholders — do not create early)

| Name | Purpose | Lands |
|---|---|---|
| MAISTRO_TIKTOK_CLIENT_ID / _SECRET | TikTok Content Posting OAuth app | M3–M4 |
| MAISTRO_META_APP_ID / _SECRET | Meta Graph (IG/FB) publishing app | M3–M4 |
| MAISTRO_X_CLIENT_ID / _SECRET | X API v2 app | M3–M4 |
| MAISTRO_CREATOR_KEY_* | Per-creator scoped MCP keys (hashed in `creators` table) | M2 |
| LANGSMITH_API_KEY | Graph tracing | M2 |
| SENTRY_DSN | Exception tracking | M1-W4 |

## Upstream tools' own secrets

Each tool keeps its own inventory in its own repo/deploy platform
(TR: TikHub/Anthropic/Apify/Supabase/CF; Sentiment: OpenAI/Apify/Supabase;
Lenceus: Anthropic/Apify/Supabase/Resend/Modal/R2; F1X8: Anthropic/Modal/
Higgsfield/HF). Maistro never holds those — it holds only its own service
keys to reach them.
