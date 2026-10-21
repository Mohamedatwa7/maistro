-- 001 — members and roles (ADR-003). Supabase Auth owns identities in
-- auth.users; this table carries the role and display name Maistro needs.
create table if not exists members (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text,
  role text not null check (role in ('admin','creator','reviewer','line_manager','adlcp_approver','viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists members_updated_at on members;
create trigger members_updated_at before update on members for each row execute function set_updated_at();

alter table members enable row level security;
-- A member may read their own row; admins read all. Writes are server-side (service role).
drop policy if exists members_self_read on members;
create policy members_self_read on members for select using (auth.uid() = id);
drop policy if exists members_admin_read on members;
create policy members_admin_read on members for select using (exists (select 1 from members m where m.id = auth.uid() and m.role = 'admin'));
