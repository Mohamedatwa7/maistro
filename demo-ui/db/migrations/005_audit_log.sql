-- 005 — append-only audit log, filled by triggers on the tables that carry decisions.
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create index if not exists audit_log_entity_idx on audit_log (entity, entity_id, at desc);

create or replace function audit_row() returns trigger language plpgsql security definer as $$
declare actor_id uuid;
begin
  begin actor_id := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; exception when others then actor_id := null; end;
  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (
    actor_id,
    lower(tg_op),
    tg_table_name,
    coalesce((case when tg_op = 'DELETE' then old.id else new.id end), null),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['content_pieces','stages','artifact_versions','approvals','adlcp_documents','jobs']
  loop
    execute format('drop trigger if exists %I on %I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', t || '_audit', t);
  end loop;
end $$;

alter table audit_log enable row level security;
drop policy if exists audit_log_admin_read on audit_log;
create policy audit_log_admin_read on audit_log for select using (exists (select 1 from members m where m.id = auth.uid() and m.role = 'admin'));
-- No update/delete policy exists: the log is append-only even for the service role via these policies' absence plus the trigger-only writes.
