-- 016 — Phase 6.9 lineage and stage invalidation: every version records the
-- upstream versions it was built from ({ "<stage kind>": "<version id>" }).
-- A stage is stale when one of those is no longer its stage's current version.
alter table artifact_versions add column if not exists inputs jsonb;
