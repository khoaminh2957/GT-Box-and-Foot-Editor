-- GT Editor: append-only, versioned snapshots of the ground-truth state of a video.
-- Public editing was chosen on purpose (anyone with the link can save), so the policies below allow
-- SELECT and INSERT only: nobody holding the anon key can update or delete a snapshot, i.e. a bad or
-- malicious save never destroys an earlier one.  Removing old snapshots is done by the project owner in the dashboard.

create table if not exists public.gt_snapshots (
  id            uuid primary key default gen_random_uuid(),
  video         text        not null check (video in ('IMG_0114', 'IMG_0115')),
  saved_at      timestamptz not null default now(),
  author        text        not null default '' check (char_length(author) <= 80),
  edited_boxes  integer     not null check (edited_boxes >= 0),
  object_path   text        not null unique check (object_path like video || '/%'),
  bytes         integer     not null check (bytes > 0 and bytes <= 20000000)
);

create index if not exists gt_snapshots_video_saved_at on public.gt_snapshots (video, saved_at desc);

alter table public.gt_snapshots enable row level security;

drop policy if exists "gt_snapshots read" on public.gt_snapshots;
create policy "gt_snapshots read" on public.gt_snapshots for select to anon using (true);

drop policy if exists "gt_snapshots add" on public.gt_snapshots;
create policy "gt_snapshots add" on public.gt_snapshots for insert to anon with check (true);

-- Storage: one gzip JSON object per snapshot, private bucket (read through the policy below), 20 MB cap per object.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gt-snapshots', 'gt-snapshots', false, 20000000, array['application/gzip'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "gt-snapshots read" on storage.objects;
create policy "gt-snapshots read" on storage.objects for select to anon using (bucket_id = 'gt-snapshots');

drop policy if exists "gt-snapshots add" on storage.objects;
create policy "gt-snapshots add" on storage.objects for insert to anon with check (bucket_id = 'gt-snapshots');
