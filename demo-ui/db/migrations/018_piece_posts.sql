-- 018 — piece_posts (7.5 attribution): which published post an approved final became. Until Sprinklr returns
-- post ids, a line manager or admin links the final to its post URL; the URL is resolved to the tracker's post
-- the same way the reader resolves aliases, and only an owned account's post can be linked (R-8). History is
-- kept: an unlink sets unlinked_at / unlinked_by instead of deleting, and at most one ACTIVE link exists per
-- (piece, post).
create table if not exists piece_posts (
  id bigint generated always as identity primary key,
  piece_id uuid not null references content_pieces(id),
  platform text not null check (platform in ('tiktok','instagram','facebook','x')),
  post_id text not null,
  url text not null,
  account text,
  source text not null default 'manual' check (source in ('manual','sprinklr')),
  linked_by uuid,
  linked_by_label text,
  linked_at timestamptz not null default now(),
  unlinked_by uuid,
  unlinked_by_label text,
  unlinked_at timestamptz,
  unlink_reason text
);
create unique index if not exists piece_posts_active_uniq on piece_posts (piece_id, platform, post_id) where unlinked_at is null;
create index if not exists piece_posts_post_idx on piece_posts (platform, post_id);
alter table piece_posts enable row level security;
