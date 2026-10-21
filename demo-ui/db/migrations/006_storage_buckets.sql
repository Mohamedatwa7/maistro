-- 006 — private storage buckets (ADR-006). The legacy public bucket `refs`
-- is left in place until its objects are migrated in M3; new uploads go to
-- the private buckets and are read through signed URLs issued server-side.
insert into storage.buckets (id, name, public)
values ('assets', 'assets', false), ('approvals', 'approvals', false), ('refs-private', 'refs-private', false)
on conflict (id) do nothing;
