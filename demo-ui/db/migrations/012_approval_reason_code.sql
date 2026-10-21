-- 012 — structured rejection reasons (Phase 6.1 item 8): the fixed code
-- from the rejection taxonomy next to the free text on every decision.
alter table approvals add column if not exists reason_code text;
