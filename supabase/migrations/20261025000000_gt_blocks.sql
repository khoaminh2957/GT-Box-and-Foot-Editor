-- GT Editor: a queue of 50-frame blocks that people claim, label and lock.
--
--   open --claim--> claimed --complete--> done        (done is final: nothing in this file can change a done block)
--          <-release-/      \--15 min without a save--> counts as open again, the next claimer takes it over
--
-- Clients can only READ the tables.  Every write goes through the SECURITY DEFINER functions below, which check
-- auth.uid() (Supabase anonymous sign-in gives each browser one) against the block's claimant.

create table if not exists public.gt_blocks (
  video         text        not null check (video in ('IMG_0114', 'IMG_0115')),
  block         integer     not null check (block >= 0),
  first_frame   integer     not null check (first_frame >= 1),
  last_frame    integer     not null,
  status        text        not null default 'open' check (status in ('open', 'claimed', 'done')),
  claimed_by    uuid,
  claimed_name  text        check (char_length(claimed_name) between 1 and 40),
  claimed_at    timestamptz,
  done_by       uuid,
  done_name     text,
  done_at       timestamptz,
  labels        jsonb,      -- {"frames": {"<frame>": {"A#6": [x1, y1, x2, y2, court_x, court_y, observed, edited], ...}}}; a draft while claimed, final when done
  primary key (video, block),
  check (last_frame >= first_frame),
  check (status <> 'claimed' or (claimed_by is not null and claimed_at is not null)),
  check (status <> 'done' or (done_by is not null and done_at is not null and labels is not null))
);

-- IMG_0114: 11,536 frames -> 231 blocks; IMG_0115: 11,823 frames -> 237 blocks (the last block of each is shorter).
insert into public.gt_blocks (video, block, first_frame, last_frame)
select v.video, b, b * 50 + 1, least(v.total, (b + 1) * 50)
from (values ('IMG_0114', 11536), ('IMG_0115', 11823)) as v(video, total), generate_series(0, (v.total - 1) / 50) as b
on conflict do nothing;

alter table public.gt_blocks enable row level security;
revoke all on public.gt_blocks from anon, authenticated;
grant select on public.gt_blocks to anon, authenticated;
drop policy if exists "gt_blocks read" on public.gt_blocks;
create policy "gt_blocks read" on public.gt_blocks for select to anon, authenticated using (true);

-- Light view for the progress bar (no label payload); a claim older than 15 minutes shows as open.
create or replace view public.gt_block_status with (security_invoker = true) as
select video, block, first_frame, last_frame,
       case when status = 'claimed' and claimed_at < now() - interval '15 minutes' then 'open' else status end as status,
       claimed_by, claimed_name, done_name, done_at
from public.gt_blocks;
revoke all on public.gt_block_status from anon, authenticated;
grant select on public.gt_block_status to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- Error codes (SQLSTATE): GT000 not signed in, GT001 claim lost / not yours / already done, GT002 bad argument, GT003 bad label payload.

create or replace function public.gt_claim_block(p_video text, p_prefer integer, p_name text)
returns public.gt_blocks language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  nm  text := btrim(coalesce(p_name, ''));
  r   public.gt_blocks;
begin
  if uid is null then raise exception 'not signed in' using errcode = 'GT000'; end if;
  if char_length(nm) not between 1 and 40 then raise exception 'name must be 1 to 40 characters' using errcode = 'GT002'; end if;
  if p_video not in ('IMG_0114', 'IMG_0115') then raise exception 'unknown video' using errcode = 'GT002'; end if;

  -- Already holding a block of this video: hand the same one back (and renew the lease).
  select * into r from public.gt_blocks where video = p_video and status = 'claimed' and claimed_by = uid order by block limit 1 for update;
  if found then
    update public.gt_blocks set claimed_at = now(), claimed_name = nm where video = r.video and block = r.block returning * into r;
    return r;
  end if;

  -- Otherwise the first free block at or after p_prefer (wrapping to the start); rows another transaction is claiming right now are skipped.
  select * into r from public.gt_blocks
   where video = p_video and (status = 'open' or (status = 'claimed' and claimed_at < now() - interval '15 minutes'))
   order by (block < coalesce(p_prefer, 0)), block
   limit 1 for update skip locked;
  if not found then return null; end if;
  update public.gt_blocks set status = 'claimed', claimed_by = uid, claimed_name = nm, claimed_at = now() where video = r.video and block = r.block returning * into r;
  return r;
end $$;

create or replace function public.gt_save_draft(p_video text, p_block integer, p_labels jsonb)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.gt_blocks;
begin
  if uid is null then raise exception 'not signed in' using errcode = 'GT000'; end if;
  if p_labels is null or jsonb_typeof(p_labels -> 'frames') is distinct from 'object' or octet_length(p_labels::text) > 400000 then
    raise exception 'labels must be {"frames": {...}} of at most 400000 bytes' using errcode = 'GT003';
  end if;
  select * into r from public.gt_blocks where video = p_video and block = p_block for update;
  if not found or r.status <> 'claimed' or r.claimed_by is distinct from uid then raise exception 'this block is not claimed by you' using errcode = 'GT001'; end if;
  update public.gt_blocks set labels = p_labels, claimed_at = now() where video = p_video and block = p_block;
  return now();
end $$;

create or replace function public.gt_complete_block(p_video text, p_block integer, p_labels jsonb)
returns public.gt_blocks language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.gt_blocks;
begin
  if uid is null then raise exception 'not signed in' using errcode = 'GT000'; end if;
  select * into r from public.gt_blocks where video = p_video and block = p_block for update;
  if not found or r.status <> 'claimed' or r.claimed_by is distinct from uid then raise exception 'this block is not claimed by you' using errcode = 'GT001'; end if;
  if p_labels is null or jsonb_typeof(p_labels -> 'frames') is distinct from 'object' or octet_length(p_labels::text) > 400000 then
    raise exception 'labels must be {"frames": {...}} of at most 400000 bytes' using errcode = 'GT003';
  end if;
  -- every frame of the block present, six players in each
  if exists (
    select 1 from generate_series(r.first_frame, r.last_frame) f
    where case when jsonb_typeof(p_labels -> 'frames' -> (f::text)) = 'object'
               then (select count(*) from jsonb_object_keys(p_labels -> 'frames' -> (f::text))) else -1 end <> 6
  ) or (select count(*) from jsonb_object_keys(p_labels -> 'frames')) <> r.last_frame - r.first_frame + 1 then
    raise exception 'labels must hold exactly frames % to % with six players each', r.first_frame, r.last_frame using errcode = 'GT003';
  end if;
  update public.gt_blocks
     set status = 'done', done_by = uid, done_name = claimed_name, done_at = now(), labels = p_labels, claimed_by = null, claimed_at = null
   where video = p_video and block = p_block returning * into r;
  return r;
end $$;

create or replace function public.gt_release_block(p_video text, p_block integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); r public.gt_blocks;
begin
  if uid is null then raise exception 'not signed in' using errcode = 'GT000'; end if;
  select * into r from public.gt_blocks where video = p_video and block = p_block for update;
  if not found or r.status <> 'claimed' or r.claimed_by is distinct from uid then raise exception 'this block is not claimed by you' using errcode = 'GT001'; end if;
  update public.gt_blocks set status = 'open', claimed_by = null, claimed_name = null, claimed_at = null where video = p_video and block = p_block;   -- the draft labels stay for the next claimer
end $$;

revoke all on function public.gt_claim_block(text, integer, text), public.gt_save_draft(text, integer, jsonb), public.gt_complete_block(text, integer, jsonb), public.gt_release_block(text, integer) from public;
grant execute on function public.gt_claim_block(text, integer, text), public.gt_save_draft(text, integer, jsonb), public.gt_complete_block(text, integer, jsonb), public.gt_release_block(text, integer) to authenticated;
