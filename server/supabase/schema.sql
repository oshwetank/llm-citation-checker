-- CitoSkeleton server schema (0.82.0). Run once in the Supabase SQL editor.
--
-- Every table has row-level security on and no policy for the public (anon)
-- role, so the only way in is the server's service key. The one exception:
-- a signed-in person may read and update their own profile row.

create table if not exists public.subscribers (
  email           text primary key check (email = lower(email) and position('@' in email) > 1),
  consent         boolean not null default false,
  source          text,
  token           text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unsubscribed_at timestamptz
);
alter table public.subscribers enable row level security;

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 60),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "own profile: read" on public.profiles;
create policy "own profile: read" on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists "own profile: update" on public.profiles;
create policy "own profile: update" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create table if not exists public.shared_campaigns (
  code       text primary key check (code ~ '^[A-HJ-NP-Z2-9]{10}$'),
  owner      uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  bytes      integer not null check (bytes > 0 and bytes <= 26214400),
  counts     jsonb,
  from_name  text,
  ready      boolean not null default false,
  downloads  integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists shared_campaigns_owner on public.shared_campaigns (owner, created_at desc);
alter table public.shared_campaigns enable row level security;

-- The files themselves: a private bucket, reached only through short-lived
-- signed addresses the server hands out.
insert into storage.buckets (id, name, public, file_size_limit)
values ('shares', 'shares', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

-- 0.85.0: campaigns saved to a profile, and the people each is shared with.
-- Run this whole file again on an existing project: every statement is
-- "if not exists", so the 0.82.0 tables are left as they are.
--
-- A saved campaign is the .cito file (without raw captures) at
-- shares/<owner>/profile/<id>.cito, replaced on every save. The pending_*
-- columns hold a save in flight, so a failed upload never changes what the
-- list shows; /api/campaigns?done=1 moves them across.
create table if not exists public.cloud_campaigns (
  id             uuid primary key,
  owner          uuid not null references auth.users (id) on delete cascade,
  local_id       text not null check (char_length(local_id) <= 100),
  name           text not null check (char_length(name) <= 120),
  bytes          integer not null default 0 check (bytes >= 0 and bytes <= 26214400),
  counts         jsonb,
  from_name      text,
  version        integer not null default 0,
  saved_at       timestamptz,
  created_at     timestamptz not null default now(),
  pending_bytes  integer,
  pending_counts jsonb,
  pending_name   text,
  unique (owner, local_id)
);
create index if not exists cloud_campaigns_owner on public.cloud_campaigns (owner, saved_at desc);
alter table public.cloud_campaigns enable row level security;

-- Who a saved campaign is shared with, by email. Sign-in proves the email
-- (an emailed code), so a person sees what's shared with them as soon as
-- they sign in with that address, account or not beforehand.
create table if not exists public.campaign_people (
  campaign uuid not null references public.cloud_campaigns (id) on delete cascade,
  email    text not null check (email = lower(email) and position('@' in email) > 1),
  added_at timestamptz not null default now(),
  primary key (campaign, email)
);
create index if not exists campaign_people_email on public.campaign_people (email);
alter table public.campaign_people enable row level security;
-- No policies on either table: only the server (service key) reads or
-- writes them, the same as shared_campaigns.
