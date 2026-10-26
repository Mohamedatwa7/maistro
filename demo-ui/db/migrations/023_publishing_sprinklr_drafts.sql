-- 023 — Sprinklr drafts on a planned post (ADR-008 amendment 2026-10-26). In drafts mode an export also creates the
-- Sprinklr draft; its id, the last status read back (e.g. APPROVAL, SCHEDULED, SENT) and the last error are kept on
-- the slot. Maistro never schedules or publishes: a person schedules the draft inside Sprinklr.
alter table publishing_slots add column if not exists sprinklr_draft_id text;
alter table publishing_slots add column if not exists sprinklr_status text;
alter table publishing_slots add column if not exists sprinklr_checked_at timestamptz;
alter table publishing_slots add column if not exists sprinklr_error text;
